import { isExpired } from './jwt';
import type { AuthResult } from './types';

export interface AuthCacheEntry {
  value: AuthResult;
  /** When the token was read from its source (epoch ms). */
  readAt: number;
  /** Cache TTL end (epoch ms). */
  expiresAt: number;
}

/**
 * Re-reading the state DB can copy a multi-GiB WAL file, so after a DB write
 * the token is re-read at most this often.
 */
export const AUTH_REREAD_MIN_MS = 60_000;

/**
 * Whether a cached token may be reused.
 * - Reuse needs a live TTL and a token that has not expired.
 * - When the state DB changed since the read (`stale`), reuse only until
 *   AUTH_REREAD_MIN_MS has passed, so a rotated token is picked up soon.
 */
export function canReuseAuth(
  entry: AuthCacheEntry | undefined,
  now: number,
  opts: { stale: boolean }
): boolean {
  if (!entry || entry.expiresAt <= now) {
    return false;
  }
  if (isExpired(entry.value.expiresAt, now)) {
    return false;
  }
  if (opts.stale && now - entry.readAt >= AUTH_REREAD_MIN_MS) {
    return false;
  }
  return true;
}
