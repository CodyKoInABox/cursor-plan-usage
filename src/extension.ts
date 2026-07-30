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
import { UsageViewProvider } from './usageViewProvider';
import type { UsageSnapshot } from './types';
import {
  isUsageSample,
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

type RefreshReason = 'manual' | 'poll' | 'focus' | 'activity' | 'config';

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
const windowTracker = new UsageWindowTracker();

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

  const storedBaseline = context.globalState.get(USAGE_SO_FAR_BASELINE_KEY);
  if (isUsageSample(storedBaseline)) {
    windowTracker.loadCustomBaseline(storedBaseline);
  }

  const persistCustomBaselineIfNeeded = async (): Promise<void> => {
    const toSave = windowTracker.takeCustomBaselineIfNeedsPersist();
    if (toSave) {
      await context.globalState.update(USAGE_SO_FAR_BASELINE_KEY, toSave);
    }
  };

  const applySnapshot = async (
    snapshot: UsageSnapshot,
    opts?: { force?: boolean }
  ): Promise<boolean> => {
    lastSnapshot = snapshot;
    await persistCustomBaselineIfNeeded();
    return provider.showUsage(snapshot, opts);
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
          updateStatusBar(statusBar, snapshot);
        }
      } catch (err) {
        if (err instanceof CursorApiError && err.status === 401) {
          clearAuthCache();
          auth = await resolveAuth(context, { force: true });
          const raw = await fetchUsageSnapshot(auth);
          const snapshot = windowTracker.attachWindows(raw);
          lastSuccessAt = Date.now();
          await applySnapshot(snapshot, { force: true });
          updateStatusBar(statusBar, snapshot);
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
    const baseline = windowTracker.resetCustomBaseline();
    if (!baseline) {
      void runRefresh({ silent: false, force: true });
      return;
    }
    await context.globalState.update(USAGE_SO_FAR_BASELINE_KEY, baseline);
    if (lastSnapshot) {
      const updated = windowTracker.overlayWindows(lastSnapshot);
      lastSnapshot = updated;
      provider.showUsage(updated, { force: true });
      return;
    }
    void runRefresh({ silent: false, force: true });
  };

  const requestRefresh = (
    reason: RefreshReason,
    opts?: { silent?: boolean; force?: boolean }
  ): void => {
    const force = opts?.force === true || reason === 'manual' || reason === 'config';
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
    activityWatcher
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

function updateStatusBar(
  item: vscode.StatusBarItem,
  snapshot: UsageSnapshot
): void {
  const cm = Math.round(snapshot.autoPercentUsed);
  const om = Math.round(snapshot.apiPercentUsed);
  const key = [snapshot.planName, cm, om].join('|');
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
