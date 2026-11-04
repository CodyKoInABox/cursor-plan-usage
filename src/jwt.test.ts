import { describe, expect, it } from 'vitest';
import { EXPIRY_SKEW_MS, isExpired, jwtExpiresAtMs } from './jwt';

/** Unsigned JWT with the given payload. Signature is irrelevant here. */
function jwt(payload: Record<string, unknown>): string {
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.c2ln`;
}

describe('jwtExpiresAtMs', () => {
  it('reads exp (seconds) as epoch milliseconds', () => {
    expect(jwtExpiresAtMs(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
  });

  it('returns undefined when there is no numeric exp', () => {
    expect(jwtExpiresAtMs(jwt({ sub: 'user_01' }))).toBeUndefined();
    expect(jwtExpiresAtMs(jwt({ exp: '1800000000' }))).toBeUndefined();
  });

  it('returns undefined for values that are not JWTs', () => {
    expect(jwtExpiresAtMs('user_01::abc')).toBeUndefined();
    expect(jwtExpiresAtMs('a.b.c')).toBeUndefined();
    expect(jwtExpiresAtMs('')).toBeUndefined();
  });
});

describe('isExpired', () => {
  const exp = 1_800_000_000_000;

  it('is false well before exp', () => {
    expect(isExpired(exp, exp - 10 * 60_000)).toBe(false);
  });

  it('is true inside the skew window before exp', () => {
    expect(isExpired(exp, exp - EXPIRY_SKEW_MS + 1)).toBe(true);
  });

  it('is true after exp', () => {
    expect(isExpired(exp, exp + 1)).toBe(true);
  });

  it('is never true without an exp', () => {
    expect(isExpired(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
