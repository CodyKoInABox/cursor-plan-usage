import { describe, expect, it } from 'vitest';
import {
  cycleProgressPct,
  MIN_PROJECTION_PROGRESS_PCT,
  projectCyclePct,
} from './projection';

describe('cycleProgressPct', () => {
  const start = 1_000_000;
  const end = start + 100;

  it('is the elapsed share of the cycle, clamped to 0–100', () => {
    expect(cycleProgressPct(start, end, start + 25)).toBe(25);
    expect(cycleProgressPct(start, end, start - 10)).toBe(0);
    expect(cycleProgressPct(start, end, end + 10)).toBe(100);
  });

  it('is undefined without both bounds or with an empty cycle', () => {
    expect(cycleProgressPct(undefined, end, start)).toBeUndefined();
    expect(cycleProgressPct(start, undefined, start)).toBeUndefined();
    expect(cycleProgressPct(start, start, start)).toBeUndefined();
  });
});

describe('projectCyclePct', () => {
  it('scales used by progress', () => {
    // 30% used at 50% through the cycle projects to 60%.
    expect(projectCyclePct(30, 50)).toBeCloseTo(60);
  });

  it('is undefined below the minimum progress', () => {
    expect(projectCyclePct(2, MIN_PROJECTION_PROGRESS_PCT - 0.1)).toBeUndefined();
    expect(projectCyclePct(2, MIN_PROJECTION_PROGRESS_PCT)).toBeDefined();
  });

  it('is undefined when progress or usage is unknown', () => {
    expect(projectCyclePct(10, undefined)).toBeUndefined();
    expect(projectCyclePct(Number.NaN, 50)).toBeUndefined();
  });

  it('takes a custom minimum progress for the sidebar floor', () => {
    expect(projectCyclePct(2, 1, 1)).toBeCloseTo(200);
    expect(projectCyclePct(2, 0.5, 1)).toBeUndefined();
  });

  it('can exceed 100', () => {
    expect(projectCyclePct(80, 40)).toBeCloseTo(200);
  });
});
