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

/** globalState key for the user-resettable "Usage so far" baseline. */
export const USAGE_SO_FAR_BASELINE_KEY = 'cursorPlanUsage.usageSoFarBaseline';

/** globalState key for the pruned last-hour sample ring. */
export const USAGE_SAMPLES_KEY = 'cursorPlanUsage.usageSamples';

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

  loadCustomBaseline(state: UsageSoFarState): void {
    this.customBaseline = { ...state.baseline };
    this.cycleKey = state.cycleKey;
    this.customBaselineNeedsPersist = false;
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
    }
    if (cycleKey) {
      this.cycleKey = cycleKey;
    }
    this.sessionBaseline ??= sample;
    if (!this.customBaseline) {
      this.customBaseline = sample;
      this.customBaselineNeedsPersist = true;
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
