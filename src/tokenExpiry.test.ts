import { describe, expect, it } from 'vitest';
import {
  EXPIRY_WARNING_MS,
  fmtTokenExpiry,
  shouldWarnTokenExpiry,
  tokenExpiryMessage,
} from './tokenExpiry';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

describe('shouldWarnTokenExpiry', () => {
  it('warns when the token expires inside the 24h window', () => {
    expect(shouldWarnTokenExpiry(NOW + 23 * HOUR, NOW, undefined)).toBe(true);
    expect(shouldWarnTokenExpiry(NOW + EXPIRY_WARNING_MS, NOW, undefined)).toBe(true);
  });

  it('does not warn before the window opens', () => {
    expect(
      shouldWarnTokenExpiry(NOW + EXPIRY_WARNING_MS + 1, NOW, undefined)
    ).toBe(false);
  });

  it('does not warn for tokens that are already expired', () => {
    expect(shouldWarnTokenExpiry(NOW - 1, NOW, undefined)).toBe(false);
    expect(shouldWarnTokenExpiry(NOW, NOW, undefined)).toBe(false);
  });

  it('does not warn for opaque tokens with no exp', () => {
    expect(shouldWarnTokenExpiry(undefined, NOW, undefined)).toBe(false);
    expect(shouldWarnTokenExpiry(Number.NaN, NOW, undefined)).toBe(false);
  });

  it('warns once per token: the same expiry is not warned again', () => {
    const exp = NOW + 5 * HOUR;
    expect(shouldWarnTokenExpiry(exp, NOW, exp)).toBe(false);
  });

  it('warns again for a new token with a new expiry', () => {
    const old = NOW + 5 * HOUR;
    const renewed = NOW + 10 * HOUR;
    expect(shouldWarnTokenExpiry(renewed, NOW, old)).toBe(true);
  });
});

describe('fmtTokenExpiry', () => {
  it('formats hours, minutes, expired, and unknown', () => {
    expect(fmtTokenExpiry(NOW + 23 * HOUR, NOW)).toBe('in 23h');
    expect(fmtTokenExpiry(NOW + 45 * 60_000, NOW)).toBe('in 45m');
    expect(fmtTokenExpiry(NOW - 1, NOW)).toBe('expired');
    expect(fmtTokenExpiry(undefined, NOW)).toBe('unknown (no exp)');
  });
});

describe('tokenExpiryMessage', () => {
  it('uses hours when at least one hour is left', () => {
    expect(tokenExpiryMessage(NOW + 23.5 * HOUR, NOW)).toBe(
      'Plan Usage: session token expires in 23h. Keep Cursor signed in, or set a new session token.'
    );
  });

  it('uses minutes under an hour and never says 0m', () => {
    expect(tokenExpiryMessage(NOW + 20 * 60_000, NOW)).toContain('in 20m.');
    expect(tokenExpiryMessage(NOW + 10_000, NOW)).toContain('in 1m.');
  });
});
