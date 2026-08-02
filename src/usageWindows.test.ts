import { describe, expect, it } from 'vitest';

import type { UsageSnapshot } from './types';
import {
  isUsageSample,
  parseAnchoredBaseline,
  parseBranchBaselinesState,
  parseUsageSamples,
  parseUsageSoFarState,
  THIS_BRANCH_MAP_CAP,
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

  it('parses keyed since-last-commit anchors', () => {
    expect(
      parseAnchoredBaseline({
        key: '/repo@abc',
        baseline: sample,
        cycleKey: 'start:2026-07-01',
      })
    ).toEqual({
      key: '/repo@abc',
      baseline: sample,
      cycleKey: 'start:2026-07-01',
    });
    expect(parseAnchoredBaseline({ key: '', baseline: sample })).toBeUndefined();
    expect(parseAnchoredBaseline({ key: '/repo@abc', baseline: {} })).toBeUndefined();
  });

  it('parses branch baseline maps and rejects garbage', () => {
    expect(parseBranchBaselinesState(null)).toBeUndefined();
    expect(parseBranchBaselinesState({ entries: [] })).toBeUndefined();
    expect(
      parseBranchBaselinesState({
        cycleKey: 'start:2026-07-01',
        activeKey: '/repo@feat',
        entries: {
          '/repo@feat': {
            accumulatedAuto: 1.5,
            accumulatedApi: 2,
            startedAt: BASE_TIME,
            lastSeenAt: BASE_TIME + 1000,
          },
          bad: { accumulatedAuto: 'x' },
        },
      })
    ).toEqual({
      cycleKey: 'start:2026-07-01',
      activeKey: '/repo@feat',
      entries: {
        '/repo@feat': {
          accumulatedAuto: 1.5,
          accumulatedApi: 2,
          startedAt: BASE_TIME,
          lastSeenAt: BASE_TIME + 1000,
        },
      },
    });
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

  it('applies a pending since-last-commit anchor on the first sample', () => {
    const tracker = new UsageWindowTracker();
    expect(tracker.setAnchor('/repo@aaa')).toBeUndefined();
    expect(tracker.sinceLastCommit()).toBeUndefined();

    tracker.record(snapshot(10, 20), BASE_TIME);
    expect(tracker.sinceLastCommit()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
      since: new Date(BASE_TIME).toISOString(),
    });
    expect(tracker.takeAnchorIfNeedsPersist()).toMatchObject({
      key: '/repo@aaa',
      baseline: {
        at: BASE_TIME,
        autoPercentUsed: 10,
        apiPercentUsed: 20,
      },
    });
  });

  it('re-anchors on key change and no-ops on the same key', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    expect(tracker.setAnchor('/repo@aaa')).toMatchObject({ key: '/repo@aaa' });
    tracker.record(snapshot(12, 25), BASE_TIME + MINUTE_MS);

    expect(tracker.sinceLastCommit()).toMatchObject({
      autoPercentDelta: 2,
      apiPercentDelta: 5,
    });
    expect(tracker.setAnchor('/repo@aaa')).toBeUndefined();
    expect(tracker.sinceLastCommit()).toMatchObject({
      autoPercentDelta: 2,
      apiPercentDelta: 5,
    });

    expect(tracker.setAnchor('/repo@bbb')).toMatchObject({
      key: '/repo@bbb',
      baseline: {
        at: BASE_TIME + MINUTE_MS,
        autoPercentUsed: 12,
        apiPercentUsed: 25,
      },
    });
    expect(tracker.sinceLastCommit()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
    });
  });

  it('clears since-last-commit when the anchor key is removed', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    tracker.setAnchor('/repo@aaa');
    expect(tracker.sinceLastCommit()).toBeDefined();

    expect(tracker.setAnchor(undefined)).toBeNull();
    expect(tracker.sinceLastCommit()).toBeUndefined();
    expect(tracker.setAnchor(undefined)).toBeUndefined();
  });

  it('drops the since-last-commit anchor on billing cycle rollover', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(90, 80), BASE_TIME);
    tracker.setAnchor('/repo@aaa');
    tracker.record(snapshot(92, 81), BASE_TIME + MINUTE_MS);
    expect(tracker.sinceLastCommit()?.autoPercentDelta).toBe(2);

    tracker.record(
      snapshot(2, 3, {
        billingCycleStart: '2026-08-01',
        billingCycleEnd: '2026-09-01',
      }),
      BASE_TIME + 2 * MINUTE_MS
    );

    expect(tracker.sinceLastCommit()).toBeUndefined();
    expect(tracker.takeAnchorIfNeedsPersist()).toBeNull();
  });

  it('tracks this-branch active-time with pause and resume', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 20), BASE_TIME);
    expect(tracker.setThisBranchKey('/repo@feat', BASE_TIME)).toBe(true);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
      since: new Date(BASE_TIME).toISOString(),
    });

    tracker.record(snapshot(12, 23), BASE_TIME + MINUTE_MS);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 2,
      apiPercentDelta: 3,
    });

    // Leave feature branch (e.g. checkout main) — freeze accumulated.
    expect(tracker.setThisBranchKey(undefined, BASE_TIME + 2 * MINUTE_MS)).toBe(
      true
    );
    expect(tracker.thisBranch()).toBeUndefined();

    // Usage while away must not count.
    tracker.record(snapshot(20, 40), BASE_TIME + 3 * MINUTE_MS);
    expect(tracker.thisBranch()).toBeUndefined();

    // Return — resume at frozen 2/3, then only new active spend adds.
    expect(
      tracker.setThisBranchKey('/repo@feat', BASE_TIME + 4 * MINUTE_MS)
    ).toBe(true);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 2,
      apiPercentDelta: 3,
    });
    tracker.record(snapshot(21, 41), BASE_TIME + 5 * MINUTE_MS);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 3,
      apiPercentDelta: 4,
    });
  });

  it('restores accumulated when switching between feature branches', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(10, 10), BASE_TIME);
    tracker.setThisBranchKey('/repo@a', BASE_TIME);
    tracker.record(snapshot(13, 12), BASE_TIME + MINUTE_MS);
    expect(tracker.thisBranch()?.autoPercentDelta).toBe(3);

    tracker.setThisBranchKey('/repo@b', BASE_TIME + 2 * MINUTE_MS);
    tracker.record(snapshot(15, 14), BASE_TIME + 3 * MINUTE_MS);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 2,
      apiPercentDelta: 2,
    });

    tracker.setThisBranchKey('/repo@a', BASE_TIME + 4 * MINUTE_MS);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 3,
      apiPercentDelta: 2,
    });
  });

  it('applies a pending this-branch key on the first sample', () => {
    const tracker = new UsageWindowTracker();
    expect(tracker.setThisBranchKey('/repo@feat', BASE_TIME)).toBe(false);
    expect(tracker.thisBranch()).toBeUndefined();
    tracker.record(snapshot(5, 5), BASE_TIME);
    expect(tracker.thisBranch()).toMatchObject({
      autoPercentDelta: 0,
      apiPercentDelta: 0,
    });
  });

  it('wipes this-branch map on billing cycle rollover', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(50, 50), BASE_TIME);
    tracker.setThisBranchKey('/repo@feat', BASE_TIME);
    tracker.record(snapshot(55, 55), BASE_TIME + MINUTE_MS);
    expect(tracker.thisBranch()?.autoPercentDelta).toBe(5);

    tracker.record(
      snapshot(1, 1, {
        billingCycleStart: '2026-08-01',
        billingCycleEnd: '2026-09-01',
      }),
      BASE_TIME + 2 * MINUTE_MS
    );
    expect(tracker.thisBranch()).toBeUndefined();
    expect(tracker.takeBranchBaselinesIfNeedsPersist()).toBeNull();
  });

  it('evicts the oldest paused branch when the map exceeds the cap', () => {
    const tracker = new UsageWindowTracker();
    tracker.record(snapshot(1, 1), BASE_TIME);

    for (let i = 0; i < THIS_BRANCH_MAP_CAP; i++) {
      const t = BASE_TIME + i * MINUTE_MS;
      tracker.setThisBranchKey(`/repo@b${i}`, t);
      tracker.record(snapshot(1 + i * 0.01, 1), t + 1);
      tracker.setThisBranchKey(undefined, t + 2);
    }

    // Map is at cap with all paused. Entering a new branch evicts oldest.
    const enterAt = BASE_TIME + THIS_BRANCH_MAP_CAP * MINUTE_MS;
    tracker.setThisBranchKey('/repo@new', enterAt);
    const persisted = tracker.takeBranchBaselinesIfNeedsPersist();
    expect(persisted).toBeDefined();
    expect(Object.keys(persisted!.entries).length).toBe(THIS_BRANCH_MAP_CAP);
    expect(persisted!.entries['/repo@b0']).toBeUndefined();
    expect(persisted!.entries['/repo@new']).toBeDefined();
  });
});
