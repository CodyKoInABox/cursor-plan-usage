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
  watchStateDbForAuth,
} from './auth';
import { CursorApiError, fetchUsageSnapshot } from './api';
import {
  alertMessage,
  budgetReadings,
  cycleKeyFor,
  DEFAULT_ALERT_THRESHOLDS,
  decideAlerts,
  type MeterReading,
  normalizeBudget,
  normalizeThresholds,
  parseAlertState,
} from './alerts';
import { fmtResetCountdown, parseCycleEndMs } from './billing';
import { withBurnEstimates } from './burnRate';
import { cycleProgressPct, projectCyclePct } from './projection';
import { shouldWarnTokenExpiry, tokenExpiryMessage } from './tokenExpiry';
import {
  type DailyRecord,
  dailyUsage,
  localDayKey,
  parseDailyRecords,
  recordDay,
} from './history';
import { describeError } from './errors';
import {
  debugChannelDisposable,
  debugEnabled,
  debugLog,
  recentDebugLines,
} from './log';
import { buildDiagnostics } from './diagnostics';
import { toUsageCsv } from './exportCsv';
import { type GitContext, watchGitContext } from './git';
import { UsageViewProvider } from './usageViewProvider';
import type { UsageSnapshot } from './types';
import {
  parseAnchoredBaseline,
  parseBranchBaselinesState,
  parseUsageSamples,
  parseUsageSoFarState,
  SINCE_LAST_COMMIT_BASELINE_KEY,
  THIS_BRANCH_BASELINES_KEY,
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
/** globalState key: which alert thresholds already fired this billing cycle. */
const ALERT_STATE_KEY = 'cursorPlanUsage.alertState';
/** globalState key: the token expiry (epoch ms) we already warned about. */
const TOKEN_EXPIRY_WARNED_KEY = 'cursorPlanUsage.tokenExpiryWarnedFor';
/** globalState key: one peak record per local day for the history chart. */
const DAILY_RECORDS_KEY = 'cursorPlanUsage.dailyRecords';
let dailyRecords: DailyRecord[] = [];

type RefreshReason = 'manual' | 'poll' | 'focus' | 'activity' | 'config' | 'git';
type StatusBarMode = 'absolute' | 'usageSoFar' | 'sinceLastCommit' | 'thisBranch';

let pollTimer: ReturnType<typeof setTimeout> | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
let pending: { silent: boolean; force: boolean } | undefined;
let lastRefreshAt = 0;
let lastSuccessAt = 0;
/** ErrorKind of the last failed refresh, cleared on success. For Copy Diagnostics. */
let lastErrorKind: string | undefined;
let lastActivityAt = 0;
let lastStatusKey = '';
let windowFocused = true;
let lastSnapshot: UsageSnapshot | undefined;
let lastGitContext: GitContext | undefined;
/** False until watchGitContext emits once — avoids flashing stale git windows. */
let gitReady = false;
const windowTracker = new UsageWindowTracker();

/**
 * Final pass on every snapshot before it becomes `lastSnapshot` (refresh, reset,
 * git change). Burn estimates are derived here so they never go stale.
 */
function stampGit(input: UsageSnapshot): UsageSnapshot {
  const snapshot: UsageSnapshot = {
    ...withBurnEstimates(input),
    history: dailyUsage(dailyRecords, localDayKey(new Date())),
  };
  if (!gitReady || !lastGitContext) {
    const { git: _g, sinceLastCommit: _s, thisBranch: _t, ...rest } = snapshot;
    return rest;
  }
  const next: UsageSnapshot = {
    ...snapshot,
    git: {
      repoName: lastGitContext.repoName,
      branch: lastGitContext.branchName,
      dirtyFiles: lastGitContext.dirtyFiles,
      isDefaultBranch: lastGitContext.isDefaultBranch,
    },
  };
  if (!lastGitContext.sinceLastCommitKey) {
    delete next.sinceLastCommit;
  }
  if (!lastGitContext.thisBranchKey) {
    delete next.thisBranch;
  }
  return next;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new UsageViewProvider(context.extensionUri);
  dailyRecords = parseDailyRecords(context.globalState.get(DAILY_RECORDS_KEY));
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

  // Defer loading git-derived baselines until git has spoken once.
  let pendingStoredAnchor = parseAnchoredBaseline(
    context.workspaceState.get(SINCE_LAST_COMMIT_BASELINE_KEY)
  );
  let pendingStoredBranches = parseBranchBaselinesState(
    context.workspaceState.get(THIS_BRANCH_BASELINES_KEY)
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
    const branches = windowTracker.takeBranchBaselinesIfNeedsPersist();
    if (branches !== undefined) {
      await context.workspaceState.update(
        THIS_BRANCH_BASELINES_KEY,
        branches === null ? undefined : branches
      );
    }
  };

  /**
   * Warn once per threshold per billing cycle. State is tracked even when
   * alerts are off, so turning them back on does not re-announce old crossings.
   */
  const checkAlerts = async (snapshot: UsageSnapshot): Promise<void> => {
    const cfg = vscode.workspace.getConfiguration('cursorPlanUsage');
    const thresholds = normalizeThresholds(
      cfg.get<unknown>('alertThresholds', [...DEFAULT_ALERT_THRESHOLDS])
    );
    const budget = normalizeBudget(cfg.get<unknown>('monthlyBudgetPercent', 0));
    const progress = cycleProgressPct(
      parseCycleEndMs(snapshot.billingCycleStart),
      parseCycleEndMs(snapshot.billingCycleEnd),
      Date.now()
    );
    const readings: MeterReading[] = [
      { id: 'auto', label: 'Cursor Models', percent: snapshot.autoPercentUsed },
      { id: 'api', label: 'Other Models', percent: snapshot.apiPercentUsed },
      ...budgetReadings(budget, {
        auto: projectCyclePct(snapshot.autoPercentUsed, progress),
        api: projectCyclePct(snapshot.apiPercentUsed, progress),
      }),
    ];
    const decision = decideAlerts(
      parseAlertState(context.globalState.get(ALERT_STATE_KEY)),
      cycleKeyFor(snapshot),
      readings,
      thresholds
    );
    if (decision.changed) {
      await context.globalState.update(ALERT_STATE_KEY, decision.state);
    }
    if (!cfg.get<boolean>('alerts', true)) {
      return;
    }
    for (const alert of decision.alerts) {
      void vscode.window.showWarningMessage(alertMessage(alert));
    }
  };

  /** Keep today's peak for the history chart. Writes only when a value changes. */
  const recordHistory = async (snapshot: UsageSnapshot): Promise<void> => {
    const next = recordDay(
      dailyRecords,
      localDayKey(new Date()),
      cycleKeyFor(snapshot),
      snapshot.autoPercentUsed,
      snapshot.apiPercentUsed
    );
    if (JSON.stringify(next) === JSON.stringify(dailyRecords)) {
      return;
    }
    dailyRecords = next;
    await context.globalState.update(DAILY_RECORDS_KEY, next);
  };

  /** One warning per token expiry, inside the 24h window. Follows cursorPlanUsage.alerts. */
  const checkTokenExpiry = async (snapshot: UsageSnapshot): Promise<void> => {
    const expiresAt = snapshot.tokenInfo?.expiresAt;
    const now = Date.now();
    const warnedFor = context.globalState.get<number>(TOKEN_EXPIRY_WARNED_KEY);
    if (!shouldWarnTokenExpiry(expiresAt, now, warnedFor) || expiresAt === undefined) {
      return;
    }
    await context.globalState.update(TOKEN_EXPIRY_WARNED_KEY, expiresAt);
    if (!vscode.workspace.getConfiguration('cursorPlanUsage').get<boolean>('alerts', true)) {
      return;
    }
    void vscode.window.showWarningMessage(tokenExpiryMessage(expiresAt, now));
  };

  const applySnapshot = async (
    snapshot: UsageSnapshot,
    opts?: { force?: boolean }
  ): Promise<boolean> => {
    lastErrorKind = undefined;
    await recordHistory(snapshot);
    const stamped = stampGit(snapshot);
    lastSnapshot = stamped;
    await persistWindowsIfNeeded();
    await checkAlerts(stamped);
    await checkTokenExpiry(stamped);
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
    const startedAt = Date.now();
    debugLog(`refresh start (silent=${opts.silent}, force=${opts.force})`);
    if (!opts.silent) {
      provider.showLoading();
    }

    try {
      let auth = await resolveAuth(context);
      try {
        const raw = await fetchUsageSnapshot(auth);
        const snapshot = windowTracker.attachWindows(raw);
        lastSuccessAt = Date.now();
        debugLog(`refresh ok in ${lastSuccessAt - startedAt}ms`);
        const changed = await applySnapshot(snapshot, { force: !opts.silent });
        if (changed || !opts.silent) {
          updateStatusBar(statusBar, lastSnapshot ?? snapshot);
        }
      } catch (err) {
        if (err instanceof CursorApiError && err.status === 401) {
          debugLog('refresh: 401, re-reading token and retrying once');
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
      const info = describeError(err);
      lastErrorKind = info.kind;
      const status =
        err instanceof CursorApiError ? ` status=${err.status}` : '';
      debugLog(`refresh failed: kind=${info.kind}${status}`);
      if (!opts.silent || !lastSuccessAt) {
        provider.showError(info);
        statusBar.text = '$(warning) Plan';
        statusBar.tooltip = info.message;
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
  const authWatcher = watchStateDbForAuth();

  const gitWatcher = watchGitContext((ctx) => {
    const firstEmit = !gitReady;
    gitReady = true;

    if (firstEmit) {
      if (pendingStoredBranches) {
        windowTracker.loadBranchBaselines(pendingStoredBranches);
        pendingStoredBranches = undefined;
      }
      if (
        pendingStoredAnchor &&
        ctx?.sinceLastCommitKey === pendingStoredAnchor.key
      ) {
        windowTracker.loadAnchor(pendingStoredAnchor);
      } else if (pendingStoredAnchor) {
        void context.workspaceState.update(
          SINCE_LAST_COMMIT_BASELINE_KEY,
          undefined
        );
      }
      pendingStoredAnchor = undefined;
    }

    const prevCommitKey = lastGitContext?.sinceLastCommitKey;
    const prevBranchKey = lastGitContext?.thisBranchKey;
    lastGitContext = ctx;

    const commitNext = windowTracker.setAnchor(ctx?.sinceLastCommitKey);
    const branchChanged = windowTracker.setThisBranchKey(ctx?.thisBranchKey);

    if (commitNext === null) {
      void context.workspaceState.update(
        SINCE_LAST_COMMIT_BASELINE_KEY,
        undefined
      );
    } else if (commitNext) {
      void context.workspaceState.update(SINCE_LAST_COMMIT_BASELINE_KEY, commitNext);
    }
    if (branchChanged) {
      const branches = windowTracker.takeBranchBaselinesIfNeedsPersist();
      if (branches !== undefined) {
        void context.workspaceState.update(
          THIS_BRANCH_BASELINES_KEY,
          branches === null ? undefined : branches
        );
      }
    }

    const commitKeySame =
      prevCommitKey === (ctx?.sinceLastCommitKey ?? undefined);
    const branchKeySame =
      prevBranchKey === (ctx?.thisBranchKey ?? undefined);
    const metadataOnly =
      !firstEmit &&
      commitNext === undefined &&
      !branchChanged &&
      commitKeySame &&
      branchKeySame;

    if (metadataOnly) {
      if (lastSnapshot) {
        const updated = stampGit(windowTracker.overlayWindows(lastSnapshot));
        lastSnapshot = updated;
        provider.showUsage(updated, { force: true });
        updateStatusBar(statusBar, updated);
      }
      return;
    }

    if (
      firstEmit &&
      commitNext === undefined &&
      !branchChanged &&
      lastSnapshot
    ) {
      const updated = stampGit(windowTracker.overlayWindows(lastSnapshot));
      lastSnapshot = updated;
      provider.showUsage(updated, { force: true });
      updateStatusBar(statusBar, updated);
      // Still refresh if we activated a branch pending samples / need live baseline.
      if (ctx?.thisBranchKey || ctx?.sinceLastCommitKey) {
        requestRefresh('git', { silent: true, force: true });
      }
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
    vscode.commands.registerCommand('cursorPlanUsage.exportUsage', async () => {
      if (dailyRecords.length === 0) {
        void vscode.window.showInformationMessage(
          'Plan Usage: no usage history to export yet.'
        );
        return;
      }
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(os.homedir(), `cursor-plan-usage-${localDayKey(new Date())}.csv`)
        ),
        filters: { CSV: ['csv'] },
        saveLabel: 'Export',
      });
      if (!uri) {
        return;
      }
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(toUsageCsv(dailyRecords), 'utf8')
      );
      void vscode.window.showInformationMessage(
        `Plan Usage: exported ${dailyRecords.length} day${dailyRecords.length === 1 ? '' : 's'} to ${uri.fsPath}.`
      );
    }),
    vscode.commands.registerCommand('cursorPlanUsage.copyDiagnostics', async () => {
      const text = buildDiagnostics({
        extensionVersion: String(
          vscode.extensions.getExtension('CodyKoInABox.cursor-plan-usage')?.packageJSON.version ?? 'unknown'
        ),
        vscodeVersion: vscode.version,
        platform: process.platform,
        arch: process.arch,
        token: lastSnapshot?.tokenInfo,
        lastError: lastErrorKind,
        debugOn: debugEnabled(),
        debugLines: recentDebugLines(),
        nowMs: Date.now(),
      });
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('Plan Usage diagnostics copied to the clipboard.');
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
    authWatcher,
    gitWatcher,
    debugChannelDisposable()
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
  const thisBranch = snapshot.thisBranch;
  // Countdown is part of the key so the tooltip refreshes when the label changes.
  const reset =
    fmtResetCountdown(parseCycleEndMs(snapshot.billingCycleEnd), Date.now()) ??
    '';
  const tooltip = (lines: string[]): string =>
    [...lines, ...(reset ? [reset] : [])].join('\n');

  if (mode === 'thisBranch' && thisBranch) {
    const key = [
      'thisBranch',
      snapshot.planName,
      thisBranch.autoPercentDelta,
      thisBranch.apiPercentDelta,
      thisBranch.since,
      snapshot.git?.branch ?? '',
      reset,
    ].join('|');
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    item.text = `$(git-branch) CM +${thisBranch.autoPercentDelta}% · OM +${thisBranch.apiPercentDelta}%`;
    item.tooltip = tooltip([
      `Cursor Plan Usage — ${snapshot.planName}`,
      `This branch${snapshot.git?.branch ? ` (${snapshot.git.branch})` : ''} since ${fmtSinceClock(thisBranch.since)}`,
      `Cursor Models +${thisBranch.autoPercentDelta}%`,
      `Other Models +${thisBranch.apiPercentDelta}%`,
      `Cycle total — CM ${cm}% · OM ${om}%`,
    ]);
    return;
  }

  if (mode === 'sinceLastCommit' && sinceCommit) {
    const key = [
      'sinceCommit',
      snapshot.planName,
      sinceCommit.autoPercentDelta,
      sinceCommit.apiPercentDelta,
      sinceCommit.since,
      reset,
    ].join('|');
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    item.text = `$(git-commit) CM +${sinceCommit.autoPercentDelta}% · OM +${sinceCommit.apiPercentDelta}%`;
    item.tooltip = tooltip([
      `Cursor Plan Usage — ${snapshot.planName}`,
      `Since last commit (since ${fmtSinceClock(sinceCommit.since)})`,
      `Cursor Models +${sinceCommit.autoPercentDelta}%`,
      `Other Models +${sinceCommit.apiPercentDelta}%`,
      `Cycle total — CM ${cm}% · OM ${om}%`,
    ]);
    return;
  }

  if (mode === 'usageSoFar' && soFar) {
    const key = [
      'soFar',
      snapshot.planName,
      soFar.autoPercentDelta,
      soFar.apiPercentDelta,
      soFar.since,
      reset,
    ].join('|');
    if (key === lastStatusKey) {
      return;
    }
    lastStatusKey = key;
    item.text = `$(history) CM +${soFar.autoPercentDelta}% · OM +${soFar.apiPercentDelta}%`;
    item.tooltip = tooltip([
      `Cursor Plan Usage — ${snapshot.planName}`,
      `Usage so far (since ${fmtSinceClock(soFar.since)})`,
      `Cursor Models +${soFar.autoPercentDelta}%`,
      `Other Models +${soFar.apiPercentDelta}%`,
      `Cycle total — CM ${cm}% · OM ${om}%`,
    ]);
    return;
  }

  const key = ['absolute', snapshot.planName, cm, om, reset].join('|');
  if (key === lastStatusKey) {
    return;
  }
  lastStatusKey = key;
  item.text = `$(dashboard) CM ${cm}% · OM ${om}%`;
  item.tooltip = tooltip([
    `Cursor Plan Usage — ${snapshot.planName}`,
    `Cursor Models ${cm}%`,
    `Other Models ${om}%`,
  ]);
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
