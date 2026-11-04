import { describe, expect, it } from 'vitest';
import { estimateBurn, MIN_BURN_SPAN_MS, withBurnEstimates } from './burnRate';
import type { UsageSnapshot } from './types';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');

describe('estimateBurn', () => {
  it('projects the time to 100% from delta over span', () => {
    // 10% over 2h = 5%/h. 50% used leaves 50% = 10h to limit.
    const e = estimateBurn({
      usedPct: 50,
      deltaPct: 10,
      spanMs: 2 * HOUR,
      nowMs: NOW,
    });
    expect(e?.ratePerHour).toBeCloseTo(5);
    expect(e?.limitAtMs).toBe(NOW + 10 * HOUR);
    expect(e?.afterReset).toBe(false);
  });

  it('is undefined when nothing is growing', () => {
    expect(
      estimateBurn({ usedPct: 50, deltaPct: 0, spanMs: HOUR, nowMs: NOW })
    ).toBeUndefined();
    expect(
      estimateBurn({ usedPct: 50, deltaPct: -1, spanMs: HOUR, nowMs: NOW })
    ).toBeUndefined();
  });

  it('is undefined for spans shorter than the minimum', () => {
    expect(
      estimateBurn({
        usedPct: 50,
        deltaPct: 1,
        spanMs: MIN_BURN_SPAN_MS - 1,
        nowMs: NOW,
      })
    ).toBeUndefined();
    expect(
      estimateBurn({
        usedPct: 50,
        deltaPct: 1,
        spanMs: MIN_BURN_SPAN_MS,
        nowMs: NOW,
      })
    ).toBeDefined();
  });

  it('is undefined at or above 100%', () => {
    expect(
      estimateBurn({ usedPct: 100, deltaPct: 5, spanMs: HOUR, nowMs: NOW })
    ).toBeUndefined();
  });

  it('is undefined for non-finite inputs', () => {
    expect(
      estimateBurn({ usedPct: NaN, deltaPct: 5, spanMs: HOUR, nowMs: NOW })
    ).toBeUndefined();
    expect(
      estimateBurn({ usedPct: 10, deltaPct: 5, spanMs: NaN, nowMs: NOW })
    ).toBeUndefined();
  });

  it('flags limits that land after the cycle resets', () => {
    // 1%/h from 10% reaches 100% in 90h; reset is in 24h.
    const e = estimateBurn({
      usedPct: 10,
      deltaPct: 1,
      spanMs: HOUR,
      resetMs: NOW + 24 * HOUR,
      nowMs: NOW,
    });
    expect(e?.afterReset).toBe(true);
  });

  it('does not flag afterReset when the reset time is unknown', () => {
    const e = estimateBurn({ usedPct: 10, deltaPct: 1, spanMs: HOUR, nowMs: NOW });
    expect(e?.afterReset).toBe(false);
  });
});

function snap(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    planName: 'Pro',
    autoPercentUsed: 50,
    apiPercentUsed: 20,
    refreshedAt: new Date(NOW).toISOString(),
    billingCycleEnd: NOW + 30 * 24 * HOUR,
    lastHour: {
      autoPercentDelta: 10,
      apiPercentDelta: 0,
      since: new Date(NOW - 2 * HOUR).toISOString(),
      partial: false,
    },
    ...overrides,
  };
}

describe('withBurnEstimates', () => {
  it('adds estimates for meters that are growing', () => {
    const out = withBurnEstimates(snap(), NOW);
    expect(out.burn?.auto?.ratePerHour).toBeCloseTo(5);
    expect(out.burn?.api).toBeUndefined();
  });

  it('leaves the snapshot without burn when no lastHour window exists', () => {
    const out = withBurnEstimates(snap({ lastHour: undefined }), NOW);
    expect(out.burn).toBeUndefined();
  });

  it('skips outdated windows', () => {
    const out = withBurnEstimates(
      snap({
        lastHour: {
          autoPercentDelta: 10,
          apiPercentDelta: 0,
          since: new Date(NOW - 5 * HOUR).toISOString(),
          partial: false,
          outdated: true,
        },
      }),
      NOW
    );
    expect(out.burn).toBeUndefined();
  });

  it('drops a previous burn that no longer applies', () => {
    const prev = withBurnEstimates(snap(), NOW);
    expect(prev.burn).toBeDefined();
    const out = withBurnEstimates(
      { ...prev, lastHour: { ...prev.lastHour!, autoPercentDelta: 0 } },
      NOW
    );
    expect(out.burn).toBeUndefined();
    expect('burn' in out).toBe(false);
  });

  it('does not mutate the input', () => {
    const input = snap();
    withBurnEstimates(input, NOW);
    expect(input.burn).toBeUndefined();
  });
});
