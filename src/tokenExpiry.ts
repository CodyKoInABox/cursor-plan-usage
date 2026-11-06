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

/** "in 23h" or "in 45m" for the warning text. */
export function tokenExpiryMessage(expiresAtMs: number, nowMs: number): string {
  const remaining = Math.max(0, expiresAtMs - nowMs);
  const hours = Math.floor(remaining / 3_600_000);
  const when =
    hours >= 1 ? `${hours}h` : `${Math.max(1, Math.floor(remaining / 60_000))}m`;
  return `Plan Usage: session token expires in ${when}. Keep Cursor signed in, or set a new session token.`;
}
