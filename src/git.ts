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

interface GitRef {
  name?: string;
  commit?: string;
}

interface Repository {
  rootUri: vscode.Uri;
  state: RepositoryState;
  getRefs?(
    query: { pattern?: string },
    token?: vscode.CancellationToken
  ): Promise<GitRef[]>;
}

interface RepositoryState {
  HEAD: { name?: string; commit?: string } | undefined;
  remotes: readonly { name: string }[];
  workingTreeChanges: readonly unknown[];
  indexChanges: readonly unknown[];
  mergeChanges: readonly unknown[];
  onDidChange: vscode.Event<void>;
}

/** Unified git snapshot for Since last commit + This branch. */
export interface GitContext {
  repoRoot: string;
  repoName: string;
  branchName?: string;
  isDefaultBranch: boolean;
  headCommit?: string;
  dirtyFiles: number;
  /** Present only when dirty — drives Since last commit. */
  sinceLastCommitKey?: string;
  /** Present only when named + !isDefaultBranch — drives This branch. */
  thisBranchKey?: string;
}

/** @deprecated Use GitContext; kept for any external imports. */
export type GitAnchor = {
  key: string;
  repoName: string;
  branch?: string;
  dirtyFiles: number;
};

const DEBOUNCE_MS = 500;
const FALLBACK_DEFAULTS = ['main', 'master', 'develop'] as const;

/** Cached default branch short name per repo root. */
const defaultBranchCache = new Map<string, string | undefined>();

function getGitApi(): GitAPI | undefined {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) {
    return undefined;
  }
  try {
    if (!ext.isActive) {
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
  return (
    file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`)
  );
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

function shortBranchName(refName: string): string {
  // refs/remotes/origin/HEAD → often reported as origin/HEAD; resolve target later
  const parts = refName.replace(/^refs\//, '').split('/');
  return parts[parts.length - 1] ?? refName;
}

/**
 * Resolve the repo default branch short name.
 * Prefer remote HEAD (origin/HEAD → main); else local main/master/develop.
 */
async function resolveDefaultBranch(repo: Repository): Promise<string | undefined> {
  const root = repo.rootUri.fsPath;
  if (defaultBranchCache.has(root)) {
    return defaultBranchCache.get(root);
  }

  let resolved: string | undefined;

  if (typeof repo.getRefs === 'function') {
    try {
      const heads = await repo.getRefs({ pattern: 'refs/remotes/*/HEAD' });
      for (const ref of heads) {
        const name = ref.name ?? '';
        // Symbolic remote HEAD is often stored as the target name in some APIs;
        // also try reading refs/remotes/origin/main style from commit match.
        if (/\/HEAD$/i.test(name) || name.endsWith('HEAD')) {
          // Some git APIs give name like "origin/HEAD" with commit of default tip.
          // Look for a remote branch with the same commit.
          if (ref.commit) {
            const remotes = await repo.getRefs({ pattern: 'refs/remotes/*/*' });
            const match = remotes.find(
              (r) =>
                r.commit === ref.commit &&
                r.name &&
                !/\/HEAD$/i.test(r.name)
            );
            if (match?.name) {
              const segs = match.name.replace(/^refs\/remotes\//, '').split('/');
              // origin/main → main
              resolved = segs.slice(1).join('/') || segs[segs.length - 1];
              break;
            }
          }
        }
      }

      if (!resolved) {
        for (const candidate of FALLBACK_DEFAULTS) {
          const locals = await repo.getRefs({
            pattern: `refs/heads/${candidate}`,
          });
          if (locals.some((r) => shortBranchName(r.name ?? '') === candidate)) {
            resolved = candidate;
            break;
          }
        }
      }
    } catch {
      // fall through
    }
  }

  if (!resolved) {
    // Sync fallback when getRefs unavailable: HEAD name if classic default.
    const head = repo.state.HEAD?.name;
    if (head && (FALLBACK_DEFAULTS as readonly string[]).includes(head)) {
      resolved = head;
    } else {
      resolved = 'main';
    }
  }

  defaultBranchCache.set(root, resolved);
  return resolved;
}

function isDefaultBranchName(
  branchName: string | undefined,
  defaultName: string | undefined
): boolean {
  if (!branchName) {
    return true; // detached → treat as "not a feature branch"
  }
  if (defaultName && branchName === defaultName) {
    return true;
  }
  // Last-resort: classic names when detection failed oddly
  if (!defaultName && (branchName === 'main' || branchName === 'master')) {
    return true;
  }
  return false;
}

async function computeContext(
  api: GitAPI | undefined
): Promise<GitContext | undefined> {
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
  const root = repo.rootUri.fsPath;
  const repoName = path.basename(root) || 'repo';
  const branchName = s.HEAD?.name;
  const headCommit = s.HEAD?.commit;
  const defaultName = await resolveDefaultBranch(repo);
  const isDefault = isDefaultBranchName(branchName, defaultName);

  const ctx: GitContext = {
    repoRoot: root,
    repoName,
    branchName,
    isDefaultBranch: isDefault,
    headCommit,
    dirtyFiles,
  };

  if (dirtyFiles > 0) {
    ctx.sinceLastCommitKey = `${root}@${headCommit ?? 'none'}`;
  }
  if (branchName && !isDefault) {
    ctx.thisBranchKey = `${root}@${branchName}`;
  }

  return ctx;
}

/**
 * Watch the active git repo. Emits a full GitContext when the API is usable,
 * or undefined when there is no repo / git is unavailable.
 * Callers hide git-derived windows until the first non-pending emit.
 */
export function watchGitContext(
  onChange: (ctx: GitContext | undefined) => void
): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSig = '';
  let repoListeners: vscode.Disposable[] = [];
  let computing = false;
  let computeAgain = false;

  const emit = (): void => {
    if (computing) {
      computeAgain = true;
      return;
    }
    computing = true;
    void (async () => {
      try {
        do {
          computeAgain = false;
          const ctx = await computeContext(getGitApi());
          const sig = ctx
            ? [
                ctx.repoRoot,
                ctx.branchName ?? '',
                ctx.isDefaultBranch ? '1' : '0',
                ctx.headCommit ?? '',
                String(ctx.dirtyFiles),
                ctx.sinceLastCommitKey ?? '',
                ctx.thisBranchKey ?? '',
              ].join('|')
            : '';
          if (sig === lastSig) {
            continue;
          }
          lastSig = sig;
          onChange(ctx);
        } while (computeAgain);
      } finally {
        computing = false;
      }
    })();
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
    disposables.push(
      api.onDidOpenRepository(() => {
        defaultBranchCache.clear();
        bindRepos();
        schedule();
      })
    );
    disposables.push(
      api.onDidCloseRepository(() => {
        defaultBranchCache.clear();
        bindRepos();
        schedule();
      })
    );
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

  schedule();

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

/** @deprecated Prefer watchGitContext. */
export function watchGitAnchor(
  onChange: (anchor: GitAnchor | undefined) => void
): vscode.Disposable {
  return watchGitContext((ctx) => {
    if (!ctx?.sinceLastCommitKey) {
      onChange(undefined);
      return;
    }
    onChange({
      key: ctx.sinceLastCommitKey,
      repoName: ctx.repoName,
      branch: ctx.branchName,
      dirtyFiles: ctx.dirtyFiles,
    });
  });
}
