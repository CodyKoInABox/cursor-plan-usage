/**
 * Parse `billingCycleEnd` into epoch ms. The API sends epoch seconds or ms,
 * as a number or a numeric string, or occasionally an ISO string. Values below
 * 1e12 are seconds (ms timestamps are 1e12 and up until the year 2286).
 */
export function parseCycleEndMs(value: string | number | undefined): number | undefined {
  if (value == null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : undefined;
  }
  const s = value.trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? undefined : d;
}

/**
 * "resets in 3d 4h" / "resets in 4h 12m" / "resets in 42m" / "resets in <1m",
 * or "reset pending" once the end time has passed (the next refresh picks up
 * the new cycle). Undefined when the end time is unknown.
 */
export function fmtResetCountdown(endMs: number | undefined, nowMs: number): string | undefined {
  if (endMs === undefined) {
    return undefined;
  }
  const remaining = endMs - nowMs;
  if (remaining <= 0) {
    return 'reset pending';
  }
  const mins = Math.floor(remaining / 60_000);
  if (mins < 1) {
    return 'resets in <1m';
  }
  if (mins < 60) {
    return `resets in ${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `resets in ${hours}h ${mins % 60}m`;
  }
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}
