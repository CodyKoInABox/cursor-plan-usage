import type { UsageSnapshot, UsageWindow } from './types';

export interface UsageSample {
  at: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
}

/** Persisted "Usage so far" baseline plus the billing cycle it belongs to. */
export interface UsageSoFarState {
  baseline: UsageSample;
  cycleKey?: string;
}

/**
 * Keyed baseline for "Since last commit" — key is `{repoRoot}@{headCommit}`.
 * Persisted in workspaceState (per-workspace).
 */
export interface AnchoredBaseline {
  key: string;
  baseline: UsageSample;
  cycleKey?: string;
}

/** globalState key for the user-resettable "Usage so far" baseline. */
export const USAGE_SO_FAR_BASELINE_KEY = 'cursorPlanUsage.usageSoFarBaseline';

/** globalState key for the pruned last-hour sample ring. */
export const USAGE_SAMPLES_KEY = 'cursorPlanUsage.usageSamples';

/** workspaceState key for the "Since last commit" keyed baseline. */
export const SINCE_LAST_COMMIT_BASELINE_KEY =
  'cursorPlanUsage.sinceLastCommitBaseline';

/** workspaceState key for per-branch active-time baselines. */
export const THIS_BRANCH_BASELINES_KEY = 'cursorPlanUsage.thisBranchBaselines';

/** Max remembered feature-branch entries (LRU by lastSeenAt). */
export const THIS_BRANCH_MAP_CAP = 40;

/**
 * Per-branch active-time accounting. Usage while checked out elsewhere does
 * not inflate the delta.
 */
export interface BranchEntry {
  accumulatedAuto: number;
  accumulatedApi: number;
  /** Set only while this branch is currently checked out. */
  liveBaseline?: UsageSample;
  /** First observation time (ms). */
  startedAt: number;
  lastSeenAt: number;
}

export interface BranchBaselinesState {
  cycleKey?: string;
  activeKey?: string;
  entries: Record<string, BranchEntry>;
}

const HOUR_MS = 60 * 60 * 1000;
/** Keep slightly more than 1h so we always have a pre-window baseline. */
const RETAIN_MS = HOUR_MS + 15 * 60 * 1000;
/** A last-hour baseline older than 1h + this is reported as outdated. */
const OUTDATED_GRACE_MS = 10 * 60 * 1000;
/**
 * Percentage-point drop treated as a billing cycle rollover. Period usage is
 * cumulative, so a real decrease means the period reset (or the plan changed).
 */
const ROLLOVER_DROP_PCT = 1;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function delta(
  baseline: UsageSample,
  current: UsageSample,
  nominalStartMs: number
): UsageWindow {
  const auto = Math.max(0, current.autoPercentUsed - baseline.autoPercentUsed);
  const api = Math.max(0, current.apiPercentUsed - baseline.apiPercentUsed);
  return {
    autoPercentDelta: round1(auto),
    apiPercentDelta: round1(api),
    since: new Date(baseline.at).toISOString(),
    partial: baseline.at > nominalStartMs,
  };
}

/** Identity of the current billing period, when the API reports one. */
function cycleKeyOf(snapshot: UsageSnapshot): string | undefined {
  const start = snapshot.billingCycleStart;
  if (start != null && start !== '') {
    return `start:${String(start)}`;
  }
  const end = snapshot.billingCycleEnd;
  if (end != null && end !== '') {
    return `end:${String(end)}`;
  }
  return undefined;
}

export function isUsageSample(value: unknown): value is UsageSample {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === 'number' &&
    Number.isFinite(v.at) &&
    typeof v.autoPercentUsed === 'number' &&
    Number.isFinite(v.autoPercentUsed) &&
    typeof v.apiPercentUsed === 'number' &&
    Number.isFinite(v.apiPercentUsed)
  );
}

/** Reads persisted state, tolerating the pre-cycleKey bare-sample shape. */
export function parseUsageSoFarState(
  value: unknown
): UsageSoFarState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (isUsageSample(v.baseline)) {
    return {
      baseline: v.baseline,
      cycleKey: typeof v.cycleKey === 'string' ? v.cycleKey : undefined,
    };
  }
  if (isUsageSample(v)) {
    return { baseline: v };
  }
  return undefined;
}

/** Reads a persisted sample ring; skips malformed entries. */
export function parseUsageSamples(value: unknown): UsageSample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: UsageSample[] = [];
  for (const item of value) {
    if (isUsageSample(item)) {
      out.push({
        at: item.at,
        autoPercentUsed: item.autoPercentUsed,
        apiPercentUsed: item.apiPercentUsed,
      });
    }
  }
  return out;
}

/** Reads a persisted keyed anchor for "Since last commit". */
export function parseAnchoredBaseline(
  value: unknown
): AnchoredBaseline | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key || !isUsageSample(v.baseline)) {
    return undefined;
  }
  return {
    key: v.key,
    baseline: {
      at: v.baseline.at,
      autoPercentUsed: v.baseline.autoPercentUsed,
      apiPercentUsed: v.baseline.apiPercentUsed,
    },
    cycleKey: typeof v.cycleKey === 'string' ? v.cycleKey : undefined,
  };
}

function parseBranchEntry(value: unknown): BranchEntry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.accumulatedAuto !== 'number' ||
    !Number.isFinite(v.accumulatedAuto) ||
    typeof v.accumulatedApi !== 'number' ||
    !Number.isFinite(v.accumulatedApi) ||
    typeof v.startedAt !== 'number' ||
    !Number.isFinite(v.startedAt) ||
    typeof v.lastSeenAt !== 'number' ||
    !Number.isFinite(v.lastSeenAt)
  ) {
    return undefined;
  }
  const entry: BranchEntry = {
    accumulatedAuto: v.accumulatedAuto,
    accumulatedApi: v.accumulatedApi,
    startedAt: v.startedAt,
    lastSeenAt: v.lastSeenAt,
  };
  if (v.liveBaseline !== undefined) {
    if (!isUsageSample(v.liveBaseline)) {
      return undefined;
    }
    entry.liveBaseline = {
      at: v.liveBaseline.at,
      autoPercentUsed: v.liveBaseline.autoPercentUsed,
      apiPercentUsed: v.liveBaseline.apiPercentUsed,
    };
  }
  return entry;
}

/** Reads persisted per-branch baselines; skips malformed entries. */
export function parseBranchBaselinesState(
  value: unknown
): BranchBaselinesState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (!v.entries || typeof v.entries !== 'object' || Array.isArray(v.entries)) {
    return undefined;
  }
  const entries: Record<string, BranchEntry> = {};
  for (const [key, raw] of Object.entries(
    v.entries as Record<string, unknown>
  )) {
    if (!key) {
      continue;
    }
    const entry = parseBranchEntry(raw);
    if (entry) {
      entries[key] = entry;
    }
  }
  return {
    cycleKey: typeof v.cycleKey === 'string' ? v.cycleKey : undefined,
    activeKey: typeof v.activeKey === 'string' ? v.activeKey : undefined,
    entries,
  };
}

/**
 * Sample ring for last-hour (persisted) and IDE-session (in-memory) deltas.
 * Absolute spend/% come from GetCurrentPeriodUsage; windows are local diffs.
 */
export class UsageWindowTracker {
  private samples: UsageSample[] = [];
  private sessionBaseline?: UsageSample;
  private customBaseline?: UsageSample;
  private cycleKey?: string;
  /** True when customBaseline was seeded/rolled over and not yet persisted. */
  private customBaselineNeedsPersist = false;
  /** True when the sample ring changed and is not yet persisted. */
  private samplesNeedPersist = false;
  /** Keyed "Since last commit" anchor. */
  private anchor?: AnchoredBaseline;
  /** Anchor key requested before any sample existed; applied on next record(). */
  private pendingAnchorKey?: string;
  /** True when anchor was auto-applied and not yet persisted. */
  private anchorNeedsPersist = false;
  /** Per-branch active-time map. */
  private branchEntries: Record<string, BranchEntry> = {};
  private activeBranchKey?: string;
  /** Branch key requested before any sample; applied on next record(). */
  private pendingBranchKey?: string;
  private branchNeedsPersist = false;

  loadCustomBaseline(state: UsageSoFarState): void {
    this.customBaseline = { ...state.baseline };
    this.cycleKey = state.cycleKey;
    this.customBaselineNeedsPersist = false;
  }

  loadAnchor(state: AnchoredBaseline): void {
    this.anchor = {
      key: state.key,
      baseline: { ...state.baseline },
      cycleKey: state.cycleKey,
    };
    this.pendingAnchorKey = undefined;
    this.anchorNeedsPersist = false;
  }

  /**
   * Restore paused/active branch map. Does not auto-activate a key — caller
   * should setThisBranchKey after git is ready.
   */
  loadBranchBaselines(state: BranchBaselinesState): void {
    this.branchEntries = {};
    for (const [key, entry] of Object.entries(state.entries)) {
      this.branchEntries[key] = {
        accumulatedAuto: entry.accumulatedAuto,
        accumulatedApi: entry.accumulatedApi,
        startedAt: entry.startedAt,
        lastSeenAt: entry.lastSeenAt,
        // Never restore liveBaseline across reloads — re-enter via setThisBranchKey.
      };
    }
    if (state.cycleKey) {
      this.cycleKey = state.cycleKey;
    }
    this.activeBranchKey = undefined;
    this.pendingBranchKey = undefined;
    this.branchNeedsPersist = false;
  }

  /**
   * Restore the last-hour sample ring. Does not seed sessionBaseline — that
   * stays IDE-local and is set on the next live record().
   */
  loadSamples(samples: UsageSample[], at = Date.now()): void {
    this.samples = samples.map((s) => ({ ...s }));
    this.prune(at);
    this.samplesNeedPersist = false;
  }

  /**
   * If the custom baseline was auto-seeded and not yet written, return it and
   * clear the dirty flag. Callers should persist to globalState.
   */
  takeCustomBaselineIfNeedsPersist(): UsageSoFarState | undefined {
    if (!this.customBaselineNeedsPersist) {
      return undefined;
    }
    const state = this.customState();
    if (!state) {
      return undefined;
    }
    this.customBaselineNeedsPersist = false;
    return state;
  }

  /**
   * If the sample ring changed and is not yet written, return a copy and clear
   * the dirty flag. Callers should persist to globalState.
   */
  takeSamplesIfNeedsPersist(): UsageSample[] | undefined {
    if (!this.samplesNeedPersist) {
      return undefined;
    }
    this.samplesNeedPersist = false;
    return this.samples.map((s) => ({ ...s }));
  }

  /**
   * If the since-last-commit anchor changed and is not yet written, return it
   * (or null when cleared) and clear the dirty flag.
   */
  takeAnchorIfNeedsPersist(): AnchoredBaseline | null | undefined {
    if (!this.anchorNeedsPersist) {
      return undefined;
    }
    this.anchorNeedsPersist = false;
    return this.anchorState() ?? null;
  }

  /**
   * If the branch map changed, return a copy to persist (or null when empty
   * after clear) and clear the dirty flag.
   */
  takeBranchBaselinesIfNeedsPersist(): BranchBaselinesState | null | undefined {
    if (!this.branchNeedsPersist) {
      return undefined;
    }
    this.branchNeedsPersist = false;
    const state = this.branchState();
    if (!state || Object.keys(state.entries).length === 0) {
      return null;
    }
    return state;
  }

  /**
   * Reset "Usage so far" to the latest sample. Returns the new state, or
   * undefined if there are no samples yet.
   */
  resetCustomBaseline(): UsageSoFarState | undefined {
    const current = this.latest();
    if (!current) {
      return undefined;
    }
    this.customBaseline = { ...current };
    this.customBaselineNeedsPersist = false;
    return this.customState();
  }

  /**
   * Set or clear the "Since last commit" key. No-op when the key is unchanged
   * and an anchor already exists. Returns the new state to persist, or null
   * when cleared, or undefined when unchanged / pending.
   */
  setAnchor(key: string | undefined): AnchoredBaseline | null | undefined {
    if (!key) {
      const had =
        this.anchor !== undefined || this.pendingAnchorKey !== undefined;
      this.anchor = undefined;
      this.pendingAnchorKey = undefined;
      if (!had) {
        return undefined;
      }
      this.anchorNeedsPersist = false;
      return null;
    }
    if (this.anchor?.key === key || this.pendingAnchorKey === key) {
      return undefined;
    }
    const current = this.latest();
    if (!current) {
      this.pendingAnchorKey = key;
      this.anchor = undefined;
      this.anchorNeedsPersist = false;
      return undefined;
    }
    this.anchor = {
      key,
      baseline: { ...current },
      cycleKey: this.cycleKey,
    };
    this.pendingAnchorKey = undefined;
    this.anchorNeedsPersist = false;
    return this.anchorState();
  }

  /**
   * Activate or pause "This branch" tracking. Pausing freezes accumulated
   * spend so usage on other branches does not inflate the delta.
   * Returns true when the map changed and should be persisted.
   */
  setThisBranchKey(key: string | undefined, at = Date.now()): boolean {
    if (key === this.activeBranchKey) {
      if (key && this.branchEntries[key]) {
        this.branchEntries[key].lastSeenAt = at;
      }
      return false;
    }

    // Same key already pending with no samples yet.
    if (key && this.pendingBranchKey === key && !this.activeBranchKey) {
      return false;
    }

    const current = this.latest();
    this.pauseActiveBranch(current, at);

    if (!key) {
      this.pendingBranchKey = undefined;
      this.activeBranchKey = undefined;
      this.branchNeedsPersist = true;
      return true;
    }

    if (!current) {
      this.pendingBranchKey = key;
      this.activeBranchKey = undefined;
      return false;
    }

    this.enterBranch(key, current, at);
    this.pendingBranchKey = undefined;
    this.branchNeedsPersist = true;
    return true;
  }

  record(snapshot: UsageSnapshot, at = Date.now()): void {
    const sample: UsageSample = {
      at,
      autoPercentUsed: snapshot.autoPercentUsed,
      apiPercentUsed: snapshot.apiPercentUsed,
    };
    const cycleKey = cycleKeyOf(snapshot);
    if (this.isRollover(sample, cycleKey)) {
      // Baselines belong to a period that no longer exists; start clean.
      this.samples = [];
      this.sessionBaseline = undefined;
      this.customBaseline = undefined;
      if (this.anchor) {
        this.anchor = undefined;
        this.anchorNeedsPersist = true;
      }
      if (Object.keys(this.branchEntries).length || this.activeBranchKey) {
        this.branchEntries = {};
        this.activeBranchKey = undefined;
        this.branchNeedsPersist = true;
      }
      // Keep pendingAnchorKey / pendingBranchKey so dirty/feature re-seed after rollover.
    }
    if (cycleKey) {
      this.cycleKey = cycleKey;
    }
    this.sessionBaseline ??= sample;
    if (!this.customBaseline) {
      this.customBaseline = sample;
      this.customBaselineNeedsPersist = true;
    }
    if (this.pendingAnchorKey) {
      this.anchor = {
        key: this.pendingAnchorKey,
        baseline: sample,
        cycleKey: this.cycleKey,
      };
      this.pendingAnchorKey = undefined;
      this.anchorNeedsPersist = true;
    }
    if (this.pendingBranchKey) {
      this.enterBranch(this.pendingBranchKey, sample, at);
      this.pendingBranchKey = undefined;
      this.branchNeedsPersist = true;
    }
    this.samples.push(sample);
    this.prune(at);
    this.samplesNeedPersist = true;
  }

  attachWindows(snapshot: UsageSnapshot, at = Date.now()): UsageSnapshot {
    this.record(snapshot, at);
    return this.overlayWindows(snapshot, at);
  }

  /** Recompute window fields without recording a new sample (e.g. after reset). */
  overlayWindows(snapshot: UsageSnapshot, at = Date.now()): UsageSnapshot {
    return {
      ...snapshot,
      lastHour: this.lastHour(at),
      session: this.session(at),
      usageSoFar: this.usageSoFar(at),
      sinceLastCommit: this.sinceLastCommit(at),
      thisBranch: this.thisBranch(at),
    };
  }

  lastHour(at = Date.now()): UsageWindow | undefined {
    const current = this.latest();
    if (!current) {
      return undefined;
    }
    const target = at - HOUR_MS;
    const baseline = this.baselineAtOrBefore(target) ?? this.earliest();
    if (!baseline) {
      return undefined;
    }
    return {
      ...delta(baseline, current, target),
      outdated: baseline.at < target - OUTDATED_GRACE_MS,
    };
  }

  session(_at = Date.now()): UsageWindow | undefined {
    const current = this.latest();
    const baseline = this.sessionBaseline;
    if (!current || !baseline) {
      return undefined;
    }
    // Session is never "partial" relative to a longer nominal window.
    return { ...delta(baseline, current, baseline.at), partial: false };
  }

  usageSoFar(_at = Date.now()): UsageWindow | undefined {
    const current = this.latest();
    const baseline = this.customBaseline;
    if (!current || !baseline) {
      return undefined;
    }
    return { ...delta(baseline, current, baseline.at), partial: false };
  }

  sinceLastCommit(_at = Date.now()): UsageWindow | undefined {
    const current = this.latest();
    const baseline = this.anchor?.baseline;
    if (!current || !baseline) {
      return undefined;
    }
    return { ...delta(baseline, current, baseline.at), partial: false };
  }

  thisBranch(_at = Date.now()): UsageWindow | undefined {
    const key = this.activeBranchKey;
    if (!key) {
      return undefined;
    }
    const entry = this.branchEntries[key];
    const current = this.latest();
    if (!entry || !current || !entry.liveBaseline) {
      return undefined;
    }
    const liveAuto = Math.max(
      0,
      current.autoPercentUsed - entry.liveBaseline.autoPercentUsed
    );
    const liveApi = Math.max(
      0,
      current.apiPercentUsed - entry.liveBaseline.apiPercentUsed
    );
    return {
      autoPercentDelta: round1(entry.accumulatedAuto + liveAuto),
      apiPercentDelta: round1(entry.accumulatedApi + liveApi),
      since: new Date(entry.startedAt).toISOString(),
      partial: false,
    };
  }

  /**
   * True when the new sample cannot belong to the same period as what we
   * already track: the cycle id changed, or cumulative usage went down.
   */
  private isRollover(
    sample: UsageSample,
    cycleKey: string | undefined
  ): boolean {
    if (cycleKey && this.cycleKey && cycleKey !== this.cycleKey) {
      return true;
    }
    const reference = this.latest() ?? this.customBaseline;
    if (!reference) {
      return false;
    }
    return (
      sample.autoPercentUsed < reference.autoPercentUsed - ROLLOVER_DROP_PCT ||
      sample.apiPercentUsed < reference.apiPercentUsed - ROLLOVER_DROP_PCT
    );
  }

  private customState(): UsageSoFarState | undefined {
    if (!this.customBaseline) {
      return undefined;
    }
    return { baseline: { ...this.customBaseline }, cycleKey: this.cycleKey };
  }

  private anchorState(): AnchoredBaseline | undefined {
    if (!this.anchor) {
      return undefined;
    }
    return {
      key: this.anchor.key,
      baseline: { ...this.anchor.baseline },
      cycleKey: this.anchor.cycleKey ?? this.cycleKey,
    };
  }

  private branchState(): BranchBaselinesState {
    const entries: Record<string, BranchEntry> = {};
    for (const [key, entry] of Object.entries(this.branchEntries)) {
      entries[key] = {
        accumulatedAuto: entry.accumulatedAuto,
        accumulatedApi: entry.accumulatedApi,
        startedAt: entry.startedAt,
        lastSeenAt: entry.lastSeenAt,
        // Persist without liveBaseline — resume sets a fresh one.
      };
    }
    return {
      cycleKey: this.cycleKey,
      activeKey: this.activeBranchKey,
      entries,
    };
  }

  private pauseActiveBranch(
    current: UsageSample | undefined,
    at: number
  ): void {
    const key = this.activeBranchKey;
    if (!key) {
      return;
    }
    const entry = this.branchEntries[key];
    if (!entry?.liveBaseline) {
      this.activeBranchKey = undefined;
      return;
    }
    if (current) {
      entry.accumulatedAuto += Math.max(
        0,
        current.autoPercentUsed - entry.liveBaseline.autoPercentUsed
      );
      entry.accumulatedApi += Math.max(
        0,
        current.apiPercentUsed - entry.liveBaseline.apiPercentUsed
      );
    }
    entry.liveBaseline = undefined;
    entry.lastSeenAt = at;
    this.activeBranchKey = undefined;
  }

  private enterBranch(key: string, current: UsageSample, at: number): void {
    let entry = this.branchEntries[key];
    if (!entry) {
      this.evictOldestBranchesIfNeeded();
      entry = {
        accumulatedAuto: 0,
        accumulatedApi: 0,
        startedAt: at,
        lastSeenAt: at,
        liveBaseline: { ...current },
      };
      this.branchEntries[key] = entry;
    } else {
      entry.liveBaseline = { ...current };
      entry.lastSeenAt = at;
    }
    this.activeBranchKey = key;
  }

  private evictOldestBranchesIfNeeded(): void {
    const keys = Object.keys(this.branchEntries);
    if (keys.length < THIS_BRANCH_MAP_CAP) {
      return;
    }
    let oldestKey = keys[0];
    let oldestAt = this.branchEntries[oldestKey].lastSeenAt;
    for (const key of keys) {
      const seen = this.branchEntries[key].lastSeenAt;
      if (seen < oldestAt) {
        oldestAt = seen;
        oldestKey = key;
      }
    }
    if (oldestKey === this.activeBranchKey) {
      return;
    }
    delete this.branchEntries[oldestKey];
  }

  private latest(): UsageSample | undefined {
    return this.samples.at(-1);
  }

  private earliest(): UsageSample | undefined {
    return this.samples[0];
  }

  /** Newest sample with `at <= target`, else undefined. */
  private baselineAtOrBefore(target: number): UsageSample | undefined {
    let best: UsageSample | undefined;
    for (const s of this.samples) {
      if (s.at <= target) {
        best = s;
      } else {
        break;
      }
    }
    return best;
  }

  private prune(now: number): void {
    const cutoff = now - RETAIN_MS;
    // Keep one sample at/before cutoff as last-hour baseline, drop older.
    let keepFrom = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].at < cutoff) {
        keepFrom = i;
      } else {
        break;
      }
    }
    if (keepFrom > 0) {
      this.samples = this.samples.slice(keepFrom);
    }
  }
}
