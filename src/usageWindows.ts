import type { UsageSnapshot, UsageWindow } from './types';

export interface UsageSample {
  at: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
}

/** globalState key for the user-resettable "Usage so far" baseline. */
export const USAGE_SO_FAR_BASELINE_KEY = 'cursorPlanUsage.usageSoFarBaseline';

const HOUR_MS = 60 * 60 * 1000;
/** Keep slightly more than 1h so we always have a pre-window baseline. */
const RETAIN_MS = HOUR_MS + 15 * 60 * 1000;

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

/**
 * In-memory ring of period-usage samples for last-hour / IDE-session deltas.
 * Absolute spend/% come from GetCurrentPeriodUsage; windows are local diffs.
 */
export class UsageWindowTracker {
  private samples: UsageSample[] = [];
  private sessionBaseline?: UsageSample;
  private customBaseline?: UsageSample;
  /** True when customBaseline was seeded this session and not yet persisted. */
  private customBaselineNeedsPersist = false;

  loadCustomBaseline(sample: UsageSample): void {
    this.customBaseline = { ...sample };
    this.customBaselineNeedsPersist = false;
  }

  getCustomBaseline(): UsageSample | undefined {
    return this.customBaseline ? { ...this.customBaseline } : undefined;
  }

  /**
   * If the custom baseline was auto-seeded and not yet written, return it and
   * clear the dirty flag. Callers should persist to globalState.
   */
  takeCustomBaselineIfNeedsPersist(): UsageSample | undefined {
    if (!this.customBaselineNeedsPersist || !this.customBaseline) {
      return undefined;
    }
    this.customBaselineNeedsPersist = false;
    return { ...this.customBaseline };
  }

  /**
   * Reset "Usage so far" to the latest sample. Returns the new baseline, or
   * undefined if there are no samples yet.
   */
  resetCustomBaseline(): UsageSample | undefined {
    const current = this.latest();
    if (!current) {
      return undefined;
    }
    this.customBaseline = { ...current };
    this.customBaselineNeedsPersist = false;
    return { ...this.customBaseline };
  }

  record(snapshot: UsageSnapshot, at = Date.now()): void {
    const sample: UsageSample = {
      at,
      autoPercentUsed: snapshot.autoPercentUsed,
      apiPercentUsed: snapshot.apiPercentUsed,
    };
    if (!this.sessionBaseline) {
      this.sessionBaseline = sample;
    }
    if (!this.customBaseline) {
      this.customBaseline = sample;
      this.customBaselineNeedsPersist = true;
    }
    this.samples.push(sample);
    this.prune(at);
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
    return delta(baseline, current, target);
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

  private latest(): UsageSample | undefined {
    return this.samples[this.samples.length - 1];
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
