import type { UsageSnapshot, UsageWindow } from './types';

export interface UsageSample {
  at: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
}

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

/**
 * In-memory ring of period-usage samples for last-hour / IDE-session deltas.
 * Absolute spend/% come from GetCurrentPeriodUsage; windows are local diffs.
 */
export class UsageWindowTracker {
  private samples: UsageSample[] = [];
  private sessionBaseline?: UsageSample;

  record(snapshot: UsageSnapshot, at = Date.now()): void {
    const sample: UsageSample = {
      at,
      autoPercentUsed: snapshot.autoPercentUsed,
      apiPercentUsed: snapshot.apiPercentUsed,
    };
    if (!this.sessionBaseline) {
      this.sessionBaseline = sample;
    }
    this.samples.push(sample);
    this.prune(at);
  }

  attachWindows(snapshot: UsageSnapshot, at = Date.now()): UsageSnapshot {
    this.record(snapshot, at);
    return {
      ...snapshot,
      lastHour: this.lastHour(at),
      session: this.session(at),
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
