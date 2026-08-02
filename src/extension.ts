import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  clearAuthCache,
  clearSessionTokenSecret,
  migrateSessionTokenSetting,
  resolveAuth,
  setSessionTokenSecret,
} from './auth';
import { CursorApiError, fetchUsageSnapshot } from './api';
import { type GitAnchor, watchGitAnchor } from './git';
import { UsageViewProvider } from './usageViewProvider';
import type { UsageSnapshot } from './types';
import {
  parseAnchoredBaseline,
  parseUsageSamples,
  parseUsageSoFarState,
  SINCE_LAST_COMMIT_BASELINE_KEY,
  USAGE_SAMPLES_KEY,
  USAGE_SO_FAR_BASELINE_KEY,
  UsageWindowTracker,
} from './usageWindows';

/** Hard floor between API calls (except force). */
const MIN_REFRESH_GAP_MS = 12_000;
/** Refetch on focus/panel if older than this. */
const STALE_ON_FOCUS_MS = 15_000;
/** Debounce after ai-tracking.db writes before hitting the API. */
const ACTIVITY_DEBOUNCE_MS = 3_000;
/** After AI activity, poll fast for this long. */
const BURST_WINDOW_MS = 2 * 60 * 1000;
const BURST_POLL_MS = 30_000;
const IDLE_POLL_MS = 3 * 60 * 1000;

type RefreshReason = 'manual' | 'poll' | 'focus' | 'activity' | 'config' | 'git';
type StatusBarMode = 'absolute' | 'usageSoFar' | 'sinceLastCommit';

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let pending: { silent: boolean; force: boolean } | undefined;
let lastRefreshAt = 0;
let lastSuccessAt = 0;
let lastActivityAt = 0;
let lastStatusKey = '';
let windowFocused = true;
let lastSnapshot: UsageSnapshot | undefined;
let lastGitAnchor: GitAnchor | undefined;
/** False until watchGitAnchor emits once — avoids flashing a stale persisted window. */
let gitReady = false;
const windowTracker = new UsageWindowTracker();

function stampGit(snapshot: UsageSnapshot): UsageSnapshot {
  if (!gitReady || !lastGitAnchor || !snapshot.sinceLastCommit) {
    const { git: _g, sinceLastCommit: _s, ...rest } = snapshot;
    return rest;
  }
  return {
    ...snapshot,
    git: {
      repoName: lastGitAnchor.repoName,
      branch: lastGitAnchor.branch,
      dirtyFiles: lastGitAnchor.dirtyFiles,
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new UsageViewProvider(context.extensionUri);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'cursorPlanUsage.focus';
  statusBar.tooltip = 'Cursor Plan Usage';
  statusBar.text = '$(pulse) Plan…';
  statusBar.show();

  windowFocused = vscode.window.state.focused;

  const storedBaseline = parseUsageSoFarState(
    context.globalState.get(USAGE_SO_FAR_BASELINE_KEY)
  );
  if (storedBaseline) {
    windowTracker.loadCustomBaseline(storedBaseline);
  }

  const storedSamples = parseUsageSamples(
    context.globalState.get(USAGE_SAMPLES_KEY)
  );
  if (storedSamples.length) {
    windowTracker.loadSamples(storedSamples);
  }

  // Defer loading the since-last-commit anchor until git has spoken once
  // (avoids a flash when the tree is clean but workspaceState is stale).
  let pendingStoredAnchor = parseAnchoredBaseline(
    context.workspaceState.get(SINCE_LAST_COMMIT_BASELINE_KEY)
  );

  const persistWindowsIfNeeded = async (): Promise<void> => {
    const toSave = windowTracker.takeCustomBaselineIfNeedsPersist();
    if (toSave) {
      await context.globalState.update(USAGE_SO_FAR_BASELINE_KEY, toSave);
    }
    const samples = windowTracker.takeSamplesIfNeedsPersist();
    if (samples) {
      await context.globalState.update(USAGE_SAMPLES_KEY, samples);
    }
    const anchor = windowTracker.takeAnchorIfNeedsPersist();
    if (anchor !== undefined) {
      await context.workspaceState.update(
        SINCE_LAST_COMMIT_BASELINE_KEY,
        anchor === null ? undefined : anchor
      );
    }
  };

  const applySnapshot = async (
    snapshot: UsageSnapshot,
    opts?: { force?: boolean }
  ): Promise<boolean> => {
    const stamped = stampGit(snapshot);
    lastSnapshot = stamped;
    await persistWindowsIfNeeded();
    return provider.showUsage(stamped, opts);
  };

  const runRefresh = async (opts: {
    silent: boolean;
    force: boolean;
  }): Promise<void> => {
    const now = Date.now();
    if (refreshing) {
      pending = {
        silent: opts.silent && (pending?.silent ?? true),
        force: opts.force || (pending?.force ?? false),
      };
      return;
    }
    if (!opts.force && now - lastRefreshAt < MIN_REFRESH_GAP_MS) {
      pending = {
        silent: opts.silent && (pending?.silent ?? true),
        force: false,
      };
      const wait = MIN_REFRESH_GAP_MS - (now - lastRefreshAt);
      scheduleDebounced(Math.max(0, wait), () => {
        const p = pending;
        pending = undefined;
        if (p) {
          void runRefresh(p);
        }
      });
      return;
    }

    refreshing = true;
    pending = undefined;
    lastRefreshAt = now;
    if (!opts.silent) {
      provider.showLoading();
    }

    try {
      let auth = await resolveAuth(context);
      try {
        const raw = await fetchUsageSnapshot(auth);
        const snapshot = windowTracker.attachWindows(raw);
        lastSuccessAt = Date.now();
        const changed = await applySnapshot(snapshot, { force: !opts.silent });
        if (changed || !opts.silent) {
          updateStatusBar(statusBar, lastSnapshot ?? snapshot);
        }
      } catch (err) {
        if (err instanceof CursorApiError && err.status === 401) {
          clearAuthCache();
          auth = await resolveAuth(context, { force: true });
          const raw = await fetchUsageSnapshot(auth);
          const snapshot = windowTracker.attachWindows(raw);
          lastSuccessAt = Date.now();
          await applySnapshot(snapshot, { force: true });
          updateStatusBar(statusBar, lastSnapshot ?? snapshot);
          return;
        }
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!opts.silent || !lastSuccessAt) {
        provider.showError(message);
        statusBar.text = '$(warning) Plan';
        statusBar.tooltip = message;
      }
    } finally {
      refreshing = false;
      if (pending) {
        const p = pending;
        pending = undefined;
        void runRefresh(p);
      } else {
        armPoll();
      }
    }
  };

  const resetUsageSoFar = async (): Promise<void> => {
    const state = windowTracker.resetCustomBaseline();
    if (!state) {
      void runRefresh({ silent: false, force: true });
      return;
    }
    await context.globalState.update(USAGE_SO_FAR_BASELINE_KEY, state);
    if (lastSnapshot) {
      const updated = stampGit(windowTracker.overlayWindows(lastSnapshot));
      lastSnapshot = updated;
      provider.showUsage(updated, { force: true });
      updateStatusBar(statusBar, updated);
      return;
    }
    void runRefresh({ silent: false, force: true });
  };

  const requestRefresh = (
    reason: RefreshReason,
    opts?: { silent?: boolean; force?: boolean }
  ): void => {
    const force =
      opts?.force === true ||
      reason === 'manual' ||
      reason === 'config' ||
      reason === 'git';
    const silent = opts?.silent ?? reason !== 'manual';
    void runRefresh({ silent, force });
  };

  const refreshIfStale = (maxAgeMs: number): void => {
    if (Date.now() - lastSuccessAt >= maxAgeMs) {
      requestRefresh('focus', { silent: true });
    }
  };

  /** AI activity → near-real-time refresh after billing settle debounce. */
  const onAiActivity = (): void => {
    const watchAi = vscode.workspace
      .getConfiguration('cursorPlanUsage')
      .get<boolean>('refreshOnAiActivity', true);
    if (!watchAi) {
      return;
    }
    lastActivityAt = Date.now();
    scheduleDebounced(ACTIVITY_DEBOUNCE_MS, () => {
      requestRefresh('activity', { silent: true });
    });
  };

  provider.setRefreshHandler(() => runRefresh({ silent: false, force: true }));
  provider.setResetUsageSoFarHandler(() => resetUsageSoFar());
  provider.setVisibilityHandler((visible) => {
    if (visible) {
      refreshIfStale(STALE_ON_FOCUS_MS);
    }
  });

  const clearPoll = (): void => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const armPoll = (): void => {
    clearPoll();
    const configured = vscode.workspace
      .getConfiguration('cursorPlanUsage')
      .get<number>('pollIntervalSeconds', 0);
    // 0 = adaptive defaults; >0 overrides idle interval.
    if (configured < 0) {
      return;
    }

    if (!windowFocused) {
      return;
    }

    const now = Date.now();
    const inBurst = now - lastActivityAt < BURST_WINDOW_MS;
    let delay: number;
    if (inBurst) {
      delay = BURST_POLL_MS;
    } else if (configured > 0) {
      delay = Math.max(30, configured) * 1000;
    } else {
      delay = IDLE_POLL_MS;
    }

    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      requestRefresh('poll', { silent: true });
    }, delay);
  };

  const activityWatcher = watchAiTrackingDb(onAiActivity);

  const gitWatcher = watchGitAnchor((anchor) => {
    const firstEmit = !gitReady;
    gitReady = true;

    if (firstEmit) {
      if (pendingStoredAnchor && anchor?.key === pendingStoredAnchor.key) {
        windowTracker.loadAnchor(pendingStoredAnchor);
      } else if (pendingStoredAnchor) {
        // Stale: tree clean, no git, or HEAD moved while we were closed.
        void context.workspaceState.update(
          SINCE_LAST_COMMIT_BASELINE_KEY,
          undefined
        );
      }
      pendingStoredAnchor = undefined;
    }

    const prevKey = lastGitAnchor?.key;
    lastGitAnchor = anchor;
    const next = windowTracker.setAnchor(anchor?.key);
    if (next === undefined && prevKey === (anchor?.key ?? undefined) && !firstEmit) {
      // Metadata-only change (e.g. dirty file count) — restamp UI if we have data.
      if (lastSnapshot) {
        const updated = stampGit(windowTracker.overlayWindows(lastSnapshot));
        lastSnapshot = updated;
        provider.showUsage(updated, { force: true });
        updateStatusBar(statusBar, updated);
      }
      return;
    }
    if (next === null) {
      void context.workspaceState.update(
        SINCE_LAST_COMMIT_BASELINE_KEY,
        undefined
      );
    } else if (next) {
      void context.workspaceState.update(SINCE_LAST_COMMIT_BASELINE_KEY, next);
    }
    // First emit with a restored matching anchor: restamp without forcing an API hit.
    if (firstEmit && next === undefined && lastSnapshot) {
      const updated = stampGit(windowTracker.overlayWindows(lastSnapshot));
      lastSnapshot = updated;
      provider.showUsage(updated, { force: true });
      updateStatusBar(statusBar, updated);
      return;
    }
    requestRefresh('git', { silent: true, force: true });
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    statusBar,
    vscode.commands.registerCommand('cursorPlanUsage.focus', async () => {
      await vscode.commands.executeCommand(`${UsageViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('cursorPlanUsage.refresh', () =>
      requestRefresh('manual', { silent: false, force: true })
    ),
    vscode.commands.registerCommand('cursorPlanUsage.setSessionToken', async () => {
      const value = await vscode.window.showInputBox({
        title: 'Plan Usage: Set Session Token',
        prompt:
          'Paste WorkosCursorSessionToken or JWT. Stored in SecretStorage (not settings.json). Overrides the local Cursor DB token while set.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'user_…::eyJ… or eyJ…',
      });
      if (value === undefined) {
        return;
      }
      try {
        await setSessionTokenSecret(context.secrets, value);
        void vscode.window.showInformationMessage(
          'Plan Usage session token saved to SecretStorage.'
        );
        requestRefresh('config', { force: true, silent: false });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(message);
      }
    }),
    vscode.commands.registerCommand('cursorPlanUsage.clearSessionToken', async () => {
      await clearSessionTokenSecret(context.secrets);
      void vscode.window.showInformationMessage(
        'Plan Usage session token cleared. Falling back to Cursor local DB.'
      );
      requestRefresh('config', { force: true, silent: false });
    }),
    vscode.window.onDidChangeWindowState((state) => {
      windowFocused = state.focused;
      if (state.focused) {
        refreshIfStale(STALE_ON_FOCUS_MS);
        armPoll();
      } else {
        clearPoll();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorPlanUsage')) {
        armPoll();
        if (lastSnapshot) {
          updateStatusBar(statusBar, lastSnapshot);
        }
        requestRefresh('config', { force: true });
      }
    }),
    {
      dispose: () => {
        clearPoll();
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
      },
    },
    activityWatcher,
    gitWatcher
  );

  void (async () => {
    try {
      await migrateSessionTokenSetting(context);
    } catch {
      // migration is best-effort
    }
    void runRefresh({ silent: false, force: true });
  })();
}

function scheduleDebounced(ms: number, fn: () => void): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    fn();
  }, ms);
}

/**
 * Watch Cursor's AI code-tracking DB — updates while Agent / AI edits run.
 * Single-file fs.watch; no recursive project globs.
 */
function watchAiTrackingDb(onActivity: () => void): vscode.Disposable {
  const trackingDir = path.join(os.homedir(), '.cursor', 'ai-tracking');
  const watchTargets = ['ai-code-tracking.db', 'ai-code-tracking.db-wal'];

  if (!fs.existsSync(trackingDir)) {
    return { dispose: () => undefined };
  }

  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(trackingDir, { persistent: false }, (_event, filename) => {
      if (!filename) {
        onActivity();
        return;
      }
      const name = filename.toString();
      if (watchTargets.some((t) => name === t || name.endsWith(t))) {
        onActivity();
      }
    });
  } catch {
    return { dispose: () => undefined };
  }

  return {
    dispose: () => {
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    },
  };
}

function fmtSinceClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return 'reset';
  }
  const clock = {
    hour: '2-digit' as const,
    minute: '2-digit' as const,
    hour12: false as const,
  };
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, clock);
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...clock,
  });
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  snapshot: UsageSnapshot
): void {
  const mode = vscode.workspace
    .getConfiguration('cursorPlanUsage')
    .get<StatusBarMode>('statusBarMode', 'absolute');
  const cm = Math.round(snapshot.autoPercentUsed);
  const om = Math.round(snapshot.apiPercentUsed);
  const soFar = snapshot.usageSoFar;
  const sinceCommit = snapshot.sinceLastCommit;

  if (mode === 'sinceLastCommit' && sinceCommit) {
    const key = [
      'sinceCommit',
      snapshot.planName,
      sinceCommit.autoPercentDelta,
      sinceCommit.apiPercentDelta,
      sinceCommit.since,
    ].join('|');
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    item.text = `$(git-commit) CM +${sinceCommit.autoPercentDelta}% · OM +${sinceCommit.apiPercentDelta}%`;
    item.tooltip = [
      `Cursor Plan Usage — ${snapshot.planName}`,
      `Since last commit (since ${fmtSinceClock(sinceCommit.since)})`,
      `Cursor Models +${sinceCommit.autoPercentDelta}%`,
      `Other Models +${sinceCommit.apiPercentDelta}%`,
      `Cycle total — CM ${cm}% · OM ${om}%`,
    ].join('\n');
    return;
  }

  if (mode === 'usageSoFar' && soFar) {
    const key = [
      'soFar',
      snapshot.planName,
      soFar.autoPercentDelta,
      soFar.apiPercentDelta,
      soFar.since,
    ].join('|');
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    item.text = `$(history) CM +${soFar.autoPercentDelta}% · OM +${soFar.apiPercentDelta}%`;
    item.tooltip = [
      `Cursor Plan Usage — ${snapshot.planName}`,
      `Usage so far (since ${fmtSinceClock(soFar.since)})`,
      `Cursor Models +${soFar.autoPercentDelta}%`,
      `Other Models +${soFar.apiPercentDelta}%`,
      `Cycle total — CM ${cm}% · OM ${om}%`,
    ].join('\n');
    return;
  }

  const key = ['absolute', snapshot.planName, cm, om].join('|');
  if (key === lastStatusKey) {
    return;
  }
  lastStatusKey = key;
  item.text = `$(dashboard) CM ${cm}% · OM ${om}%`;
  item.tooltip = [
    `Cursor Plan Usage — ${snapshot.planName}`,
    `Cursor Models ${cm}%`,
    `Other Models ${om}%`,
  ].join('\n');
}

export function deactivate(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}
