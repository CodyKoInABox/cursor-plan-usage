/**
 * Treat a token as expired this long before its `exp`, so a request that
 * leaves now is not rejected on the way to the API.
 */
export const EXPIRY_SKEW_MS = 60_000;

/**
 * Read the `exp` claim (as epoch ms) from a JWT. No signature check: this is
 * for expiry handling only, never for trust. Returns undefined for anything
 * that is not a JWT with a numeric `exp`.
 */
export function jwtExpiresAtMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when the token has an `exp` and it is within the skew of `now`. */
export function isExpired(expiresAtMs: number | undefined, now: number): boolean {
  return expiresAtMs !== undefined && expiresAtMs - EXPIRY_SKEW_MS <= now;
}
