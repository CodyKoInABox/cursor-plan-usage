import { parseCycleEndMs } from './billing';
import type { BurnEstimate, UsageSnapshot } from './types';

/** Shorter spans are too noisy to extrapolate from (round1 deltas, few samples). */
export const MIN_BURN_SPAN_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

export interface BurnInput {
  /** Current cycle percent for the meter. */
  usedPct: number;
  /** Percent gained over the span. */
  deltaPct: number;
  /** Length of the span the delta covers. */
  spanMs: number;
  /** Billing cycle end (epoch ms), if known. */
  resetMs?: number;
  nowMs: number;
}

/**
 * Extrapolate the time to 100% from the rate over the span. Undefined when
 * there is nothing to project: no growth, a span that is too short, already
 * at 100%, or non-finite inputs.
 */
export function estimateBurn(input: BurnInput): BurnEstimate | undefined {
  const { usedPct, deltaPct, spanMs, resetMs, nowMs } = input;
  if (![usedPct, deltaPct, spanMs, nowMs].every(Number.isFinite)) {
    return undefined;
  }
  if (deltaPct <= 0 || spanMs < MIN_BURN_SPAN_MS || usedPct >= 100) {
    return undefined;
  }
  const ratePerHour = deltaPct / (spanMs / HOUR_MS);
  const limitAtMs = nowMs + ((100 - usedPct) / ratePerHour) * HOUR_MS;
  return {
    ratePerHour,
    limitAtMs,
    afterReset: resetMs !== undefined && limitAtMs > resetMs,
  };
}

/**
 * Attach burn estimates from the last-hour window. Skipped when the window is
 * outdated: its rate averages over a longer span than the current burn.
 * Replaces any previous `burn` so a stale estimate never survives a refresh.
 */
export function withBurnEstimates(
  snapshot: UsageSnapshot,
  nowMs: number = Date.now()
): UsageSnapshot {
  const { burn: _previous, ...rest } = snapshot;
  const w = snapshot.lastHour;
  if (!w || w.outdated) {
    return rest;
  }
  const spanMs = nowMs - Date.parse(w.since);
  const resetMs = parseCycleEndMs(snapshot.billingCycleEnd);
  const auto = estimateBurn({
    usedPct: snapshot.autoPercentUsed,
    deltaPct: w.autoPercentDelta,
    spanMs,
    resetMs,
    nowMs,
  });
  const api = estimateBurn({
    usedPct: snapshot.apiPercentUsed,
    deltaPct: w.apiPercentDelta,
    spanMs,
    resetMs,
    nowMs,
  });
  if (!auto && !api) {
    return rest;
  }
  return { ...rest, burn: { ...(auto ? { auto } : {}), ...(api ? { api } : {}) } };
}
