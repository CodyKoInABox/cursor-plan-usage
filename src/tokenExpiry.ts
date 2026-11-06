/** Warn this long before the session token's `exp`. */
export const EXPIRY_WARNING_MS = 24 * 60 * 60_000;

/**
 * Warn once per token (keyed by its expiry) when it expires within the warning
 * window. Expired tokens are not warned about here: the 401 / token-expired
 * path already reports them.
 */
export function shouldWarnTokenExpiry(
  expiresAtMs: number | undefined,
  nowMs: number,
  warnedFor: number | undefined
): boolean {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) {
    return false;
  }
  if (warnedFor === expiresAtMs) {
    return false;
  }
  const remaining = expiresAtMs - nowMs;
  return remaining > 0 && remaining <= EXPIRY_WARNING_MS;
}

/**
 * "in 23h" / "in 45m" until expiry, "expired", or "unknown (no exp)" for
 * opaque tokens. Shared by the warning text and the diagnostics report.
 */
export function fmtTokenExpiry(expiresAtMs: number | undefined, nowMs: number): string {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) {
    return 'unknown (no exp)';
  }
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) {
    return 'expired';
  }
  const hours = Math.floor(remaining / 3_600_000);
  return hours >= 1
    ? `in ${hours}h`
    : `in ${Math.max(1, Math.floor(remaining / 60_000))}m`;
}

/** Warning text shown 24h or less before the session token expires. */
export function tokenExpiryMessage(expiresAtMs: number, nowMs: number): string {
  return `Plan Usage: session token expires ${fmtTokenExpiry(expiresAtMs, nowMs)}. Keep Cursor signed in, or set a new session token.`;
}
