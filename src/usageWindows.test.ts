import { describe, expect, it } from 'vitest';

import type { UsageSnapshot } from './types';
import {
  isUsageSample,
  parseUsageSamples,
  parseUsageSoFarState,
  UsageWindowTracker,
} from './usageWindows';

const MINUTE_MS = 60 * 1000;
const BASE_TIME = Date.parse('2026-07-30T00:00:00.000Z');

function snapshot(
  autoPercentUsed: number,
  apiPercentUsed: number,
  overrides: Partial<UsageSnapshot> = {}
): UsageSnapshot {
  return {
    planName: 'Pro',
    autoPercentUsed,
    apiPercentUsed,
    refreshedAt: new Date(BASE_TIME).toISOString(),
    billingCycleStart: '2026-07-01',
    billingCycleEnd: '2026-08-01',
    ...overrides,
  };
}

describe('persisted usage state parsing', () => {
  const sample = {
    at: BASE_TIME,
    autoPercentUsed: 10,
    apiPercentUsed: 20,
  };

  it('accepts valid samples and rejects malformed samples', () => {
    expect(isUsageSample(sample)).toBe(true);
    expect(isUsageSample({ ...sample, at: Number.NaN })).toBe(false);
    expect(isUsageSample({ ...sample, apiPercentUsed: '20' })).toBe(false);
    expect(isUsageSample(null)).toBe(false);
  });

  it('reads both current and legacy persisted shapes', () => {
    expect(
      parseUsageSoFarState({
        baseline: sample,
        cycleKey: 'start:2026-07-01',
      })
    ).toEqual({
      baseline: sample,
      cycleKey: 'start:2026-07-01',
    });
    expect(parseUsageSoFarState(sample)).toEqual({ baseline: sample });
    expect(parseUsageSoFarState({ baseline: {} })).toBeUndefined();
  });

  it('parses a sample ring and skips garbage', () => {
    expect(parseUsageSamples(null)).toEqual([]);
    expect(parseUsageSamples({})).toEqual([]);
    expect(
      parseUsageSamples([sample, { at: 'bad' }, null, sample])
    ).toEqual([sample, sample]);
  });
});

describe('UsageWindowTracker', () => {
  it('calculates rounded session and partial last-hour deltas', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    tracker.record(snapshot(11.24, 23.26), BASE_TIME + 30 * MINUTE_MS);

    expect(tracker.session()).toMatchObject({
      autoPercentDelta: 1.2,
      apiPercentDelta: 3.3,
      since: new Date(BASE_TIME).toISOString(),
      partial: false,
    });
    expect(tracker.lastHour(BASE_TIME + 30 * MINUTE_MS)).toMatchObject({
      autoPercentDelta: 1.2,
      apiPercentDelta: 3.3,
      since: new Date(BASE_TIME).toISOString(),
      partial: true,
      outdated: false,
    });
  });

  it('uses the newest sample at or before the one-hour boundary', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    tracker.record(snapshot(12, 24), BASE_TIME + 30 * MINUTE_MS);
    tracker.record(snapshot(15, 29), BASE_TIME + 90 * MINUTE_MS);

    expect(tracker.lastHour(BASE_TIME + 90 * MINUTE_MS)).toMatchObject({
      autoPercentDelta: 3,
      apiPercentDelta: 5,
      since: new Date(BASE_TIME + 30 * MINUTE_MS).toISOString(),
      partial: false,
      outdated: false,
    });
  });

  it('marks a stale last-hour baseline as outdated', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    tracker.record(snapshot(15, 25), BASE_TIME + 2 * 60 * MINUTE_MS);

    expect(
      tracker.lastHour(BASE_TIME + 2 * 60 * MINUTE_MS)
    ).toMatchObject({
      partial: false,
      outdated: true,
    });
  });

  it('persists an auto-seeded custom baseline only once', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);

    expect(tracker.takeCustomBaselineIfNeedsPersist()).toEqual({
      baseline: {
        at: BASE_TIME,
        autoPercentUsed: 10,
        apiPercentUsed: 20,
      },
      cycleKey: 'start:2026-07-01',
    });
    expect(tracker.takeCustomBaselineIfNeedsPersist()).toBeUndefined();
  });

  it('round-trips the sample ring so last-hour survives a restart', () => {
    const a = new UsageWindowTracker();
    a.record(snapshot(10, 20), BASE_TIME);
    a.record(snapshot(12, 24), BASE_TIME + 30 * MINUTE_MS);
    a.record(snapshot(15, 29), BASE_TIME + 90 * MINUTE_MS);

    const persisted = a.takeSamplesIfNeedsPersist();
    expect(persisted).toBeDefined();
    expect(a.takeSamplesIfNeedsPersist()).toBeUndefined();

    const b = new UsageWindowTracker();
    b.loadSamples(persisted!, BASE_TIME + 90 * MINUTE_MS);
    expect(b.lastHour(BASE_TIME + 90 * MINUTE_MS)).toMatchObject({
      autoPercentDelta: 3,
      apiPercentDelta: 5,
      since: new Date(BASE_TIME + 30 * MINUTE_MS).toISOString(),
      partial: false,
      outdated: false,
    });
  });

  it('does not seed session from loaded samples', () => {
    const a = new UsageWindowTracker();
    a.record(snapshot(10, 20), BASE_TIME);
    a.record(snapshot(14, 28), BASE_TIME + 45 * MINUTE_MS);
    const persisted = a.takeSamplesIfNeedsPersist()!;

    const b = new UsageWindowTracker();
    b.loadSamples(persisted, BASE_TIME + 45 * MINUTE_MS);
    const reopenAt = BASE_TIME + 50 * MINUTE_MS;
    b.record(snapshot(15, 30), reopenAt);

    expect(b.session()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
      since: new Date(reopenAt).toISOString(),
      partial: false,
    });
    expect(b.lastHour(reopenAt)).toMatchObject({
      autoPercentDelta: 5,
      apiPercentDelta: 10,
      since: new Date(BASE_TIME).toISOString(),
      partial: true,
    });
  });

  it('resets all windows when the billing cycle changes', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(90, 80), BASE_TIME);
    expect(tracker.takeSamplesIfNeedsPersist()?.length).toBe(1);

    tracker.record(
      snapshot(2, 3, {
        billingCycleStart: '2026-08-01',
        billingCycleEnd: '2026-09-01',
      }),
      BASE_TIME + MINUTE_MS
    );

    expect(tracker.session()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
      since: new Date(BASE_TIME + MINUTE_MS).toISOString(),
    });
    expect(tracker.usageSoFar()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
    });
    expect(tracker.takeCustomBaselineIfNeedsPersist()?.cycleKey).toBe(
      'start:2026-08-01'
    );
    expect(tracker.takeSamplesIfNeedsPersist()).toEqual([
      {
        at: BASE_TIME + MINUTE_MS,
        autoPercentUsed: 2,
        apiPercentUsed: 3,
      },
    ]);
  });

  it('also detects rollover when cumulative usage drops significantly', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(40, 50), BASE_TIME);
    tracker.record(snapshot(38.9, 48.9), BASE_TIME + MINUTE_MS);

    expect(tracker.session()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
      since: new Date(BASE_TIME + MINUTE_MS).toISOString(),
    });
  });
});
