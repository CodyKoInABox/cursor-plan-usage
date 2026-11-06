/**
 * Below this share of the cycle, a linear projection is mostly noise (2% used
 * at 1% progress projects to 200%). Budget alerts wait for this much progress.
 */
export const MIN_PROJECTION_PROGRESS_PCT = 5;

/**
 * Share of the billing cycle elapsed, 0–100. Undefined when the bounds are
 * missing or the cycle has no length.
 */
export function cycleProgressPct(
  startMs: number | undefined,
  endMs: number | undefined,
  nowMs: number
): number | undefined {
  if (startMs === undefined || endMs === undefined) {
    return undefined;
  }
  const total = endMs - startMs;
  if (!(total > 0)) {
    return undefined;
  }
  const pct = ((nowMs - startMs) / total) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Linear end-of-cycle projection: used / progress. Undefined when progress is
 * unknown or below MIN_PROJECTION_PROGRESS_PCT. The result may exceed 100.
 */
export function projectCyclePct(
  usedPct: number,
  progressPct: number | undefined
): number | undefined {
  if (
    progressPct === undefined ||
    !Number.isFinite(usedPct) ||
    progressPct < MIN_PROJECTION_PROGRESS_PCT
  ) {
    return undefined;
  }
  const projected = (Math.max(0, usedPct) / progressPct) * 100;
  return Number.isFinite(projected) ? projected : undefined;
}
