import { describe, expect, it } from 'vitest';
import {
  AUTH_REREAD_MIN_MS,
  type AuthCacheEntry,
  canReuseAuth,
} from './authCache';

const NOW = 1_800_000_000_000;
const TTL_MS = 10 * 60_000;

function entry(opts: { readAt?: number; tokenExpiresAt?: number } = {}): AuthCacheEntry {
  return {
    value: {
      accessToken: 'tok',
      source: 'db',
      expiresAt: opts.tokenExpiresAt,
    },
    readAt: opts.readAt ?? NOW,
    expiresAt: NOW + TTL_MS,
  };
}

describe('canReuseAuth', () => {
  it('reuses a live entry when the state DB has not changed', () => {
    expect(canReuseAuth(entry(), NOW + 1000, { stale: false })).toBe(true);
  });

  it('does not reuse without an entry', () => {
    expect(canReuseAuth(undefined, NOW, { stale: false })).toBe(false);
  });

  it('does not reuse after the cache TTL', () => {
    expect(canReuseAuth(entry(), NOW + TTL_MS, { stale: false })).toBe(false);
  });

  it('does not reuse a token that has already expired', () => {
    const e = entry({ tokenExpiresAt: NOW - 1 });
    expect(canReuseAuth(e, NOW, { stale: false })).toBe(false);
  });

  it('keeps reusing a stale entry until the re-read minimum has passed', () => {
    const e = entry({ readAt: NOW });
    expect(canReuseAuth(e, NOW + AUTH_REREAD_MIN_MS - 1, { stale: true })).toBe(true);
  });

  it('re-reads a stale entry once the re-read minimum has passed', () => {
    const e = entry({ readAt: NOW });
    expect(canReuseAuth(e, NOW + AUTH_REREAD_MIN_MS, { stale: true })).toBe(false);
  });
});
