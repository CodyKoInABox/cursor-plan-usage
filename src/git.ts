import * as path from 'path';
import * as vscode from 'vscode';

/** Minimal subset of the built-in vscode.git extension API. */
interface GitExtension {
  getAPI(version: 1): GitAPI;
}

interface GitAPI {
  repositories: Repository[];
  onDidOpenRepository: vscode.Event<Repository>;
  onDidCloseRepository: vscode.Event<Repository>;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
}

interface RepositoryState {
  HEAD: { name?: string; commit?: string } | undefined;
  workingTreeChanges: readonly unknown[];
  indexChanges: readonly unknown[];
  mergeChanges: readonly unknown[];
  onDidChange: vscode.Event<void>;
}

export interface GitAnchor {
  /** `{repoRoot}@{headCommit}` — Option A re-anchor key. */
  key: string;
  repoName: string;
  branch?: string;
  dirtyFiles: number;
}

const DEBOUNCE_MS = 500;

function getGitApi(): GitAPI | undefined {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    if (!ext.isActive) {
      // Fire-and-forget activate; callers will re-emit once repos open.
      void ext.activate();
      return undefined;
    }
    return ext.exports.getAPI(1);
  } catch {
    return undefined;
  }
}

function repoContainsUri(repo: Repository, uri: vscode.Uri): boolean {
  const root = repo.rootUri.fsPath.replace(/\\/g, '/').toLowerCase();
  const file = uri.fsPath.replace(/\\/g, '/').toLowerCase();
  return file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function pickRepo(api: GitAPI): Repository | undefined {
  const repos = api.repositories;
  if (!repos.length) {
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') {
    const match = repos.find((r) => repoContainsUri(r, active));
    if (match) {
      return match;
    }
  }
  return repos[0];
}

function computeAnchor(api: GitAPI | undefined): GitAnchor | undefined {
  if (!api) {
    return undefined;
  }
  const repo = pickRepo(api);
  if (!repo) {
    return undefined;
  }
  const s = repo.state;
  const dirtyFiles =
    s.workingTreeChanges.length +
    s.indexChanges.length +
    s.mergeChanges.length;
  if (dirtyFiles === 0) {
    return undefined;
  }
  const head = s.HEAD?.commit ?? 'none';
  const root = repo.rootUri.fsPath;
  const repoName = path.basename(root) || 'repo';
  return {
    key: `${root}@${head}`,
    repoName,
    branch: s.HEAD?.name,
    dirtyFiles,
  };
}

/**
 * Watch the active git repo and emit an Option-A anchor while the tree is dirty.
 * Emits undefined when clean, not a git workspace (no repos), or vscode.git is
 * unavailable (e.g. Remote UI) — callers hide "Since last commit" in that case.
 */
export function watchGitAnchor(
  onChange: (anchor: GitAnchor | undefined) => void
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSig = '';
  let repoListeners: vscode.Disposable[] = [];

  const emit = (): void => {
    const anchor = computeAnchor(getGitApi());
    const sig = anchor
      ? `${anchor.key}|${anchor.dirtyFiles}|${anchor.branch ?? ''}|${anchor.repoName}`
      : '';
    if (sig === lastSig) {
      return;
    }
    lastSig = sig;
    onChange(anchor);
  };

  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      emit();
    }, DEBOUNCE_MS);
  };

  const bindRepos = (): void => {
    for (const d of repoListeners) {
      d.dispose();
    }
    repoListeners = [];
    const api = getGitApi();
    if (!api) {
      return;
    }
    for (const repo of api.repositories) {
      repoListeners.push(repo.state.onDidChange(schedule));
    }
  };

  const api = getGitApi();
  if (api) {
    disposables.push(api.onDidOpenRepository(() => {
      bindRepos();
      schedule();
    }));
    disposables.push(api.onDidCloseRepository(() => {
      bindRepos();
      schedule();
    }));
    bindRepos();
  }

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      bindRepos();
      schedule();
    }),
    vscode.extensions.onDidChange(() => {
      bindRepos();
      schedule();
    })
  );

  // Initial emit (may be undefined until git activates).
  schedule();

  // Retry once git finishes activating.
  const ext = vscode.extensions.getExtension('vscode.git');
  if (ext && !ext.isActive) {
    void ext.activate().then(() => {
      bindRepos();
      schedule();
    });
  }

  return {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const d of repoListeners) {
        d.dispose();
      }
      repoListeners = [];
      for (const d of disposables) {
        d.dispose();
      }
    },
  };
}
