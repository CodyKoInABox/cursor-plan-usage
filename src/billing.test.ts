import { describe, expect, it } from 'vitest';
import { fmtResetCountdown, parseCycleEndMs } from './billing';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('parseCycleEndMs', () => {
  it('treats numbers below 1e12 as epoch seconds', () => {
    expect(parseCycleEndMs(1_790_000_000)).toBe(1_790_000_000_000);
  });

  it('treats numbers at or above 1e12 as epoch ms', () => {
    expect(parseCycleEndMs(1_790_000_000_000)).toBe(1_790_000_000_000);
  });

  it('handles numeric strings in seconds and ms', () => {
    expect(parseCycleEndMs('1790000000')).toBe(1_790_000_000_000);
    expect(parseCycleEndMs(' 1790000000000 ')).toBe(1_790_000_000_000);
  });

  it('handles ISO strings', () => {
    expect(parseCycleEndMs('2026-12-01T00:00:00.000Z')).toBe(
      Date.parse('2026-12-01T00:00:00.000Z')
    );
  });

  it('returns undefined for missing or invalid values', () => {
    expect(parseCycleEndMs(undefined)).toBeUndefined();
    expect(parseCycleEndMs('')).toBeUndefined();
    expect(parseCycleEndMs('not a date')).toBeUndefined();
    expect(parseCycleEndMs(Number.NaN)).toBeUndefined();
  });
});

describe('fmtResetCountdown', () => {
  const now = 1_000_000_000_000;

  it('is undefined when the end is unknown', () => {
    expect(fmtResetCountdown(undefined, now)).toBeUndefined();
  });

  it('says reset pending once the end has passed', () => {
    expect(fmtResetCountdown(now, now)).toBe('reset pending');
    expect(fmtResetCountdown(now - MIN, now)).toBe('reset pending');
  });

  it('shows <1m under a minute', () => {
    expect(fmtResetCountdown(now + 30_000, now)).toBe('resets in <1m');
  });

  it('shows minutes under an hour', () => {
    expect(fmtResetCountdown(now + 42 * MIN, now)).toBe('resets in 42m');
  });

  it('shows hours and minutes under a day', () => {
    expect(fmtResetCountdown(now + 4 * HOUR + 12 * MIN, now)).toBe(
      'resets in 4h 12m'
    );
  });

  it('shows days and hours from one day up', () => {
    expect(fmtResetCountdown(now + DAY, now)).toBe('resets in 1d 0h');
    expect(fmtResetCountdown(now + 3 * DAY + 4 * HOUR + 59 * MIN, now)).toBe(
      'resets in 3d 4h'
    );
  });
});
