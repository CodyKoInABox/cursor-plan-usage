import { describe, expect, it } from 'vitest';
import { probeDays, summarizeAggregation } from './usageProbe';

describe('probeDays', () => {
  it('lists local days newest first, one window each', () => {
    const days = probeDays('2026-11-06', 3);
    expect(days.map((d) => d.day)).toEqual([
      '2026-11-06',
      '2026-11-05',
      '2026-11-04',
    ]);
    for (const d of days) {
      // 23h or 25h is possible around DST changes.
      const span = d.endMs - d.startMs;
      expect(span).toBeGreaterThanOrEqual(23 * 3600_000);
      expect(span).toBeLessThanOrEqual(25 * 3600_000);
    }
  });

  it('starts each window at local midnight', () => {
    const [today] = probeDays('2026-11-06', 1);
    expect(new Date(today.startMs).getHours()).toBe(0);
    expect(new Date(today.startMs).getDate()).toBe(6);
  });

  it('returns nothing for zero days', () => {
    expect(probeDays('2026-11-06', 0)).toEqual([]);
  });
});

describe('summarizeAggregation', () => {
  it('summarizes a camelCase body with per-model lines', () => {
    const lines = summarizeAggregation({
      aggregations: [
        { modelIntent: 'auto', tier: 1, totalCents: 120 },
        { modelIntent: 'claude', tier: 2, totalCents: 35.5 },
      ],
      totalCostCents: 155.5,
      percentOfBurstUsed: 7.7,
    });
    expect(lines[0]).toContain('keys: aggregations, totalCostCents');
    expect(lines[1]).toBe(
      'total_cost_cents=155.5 percent_of_burst_used=7.7'
    );
    expect(lines).toContain('  model=auto tier=1 cents=120');
    expect(lines).toContain('  model=claude tier=2 cents=35.5');
  });

  it('accepts snake_case keys too', () => {
    const lines = summarizeAggregation({
      total_cost_cents: 10,
      percent_of_burst_used: 1,
      aggregations: [{ model_intent: 'gpt', tier: 3, total_cents: 10 }],
    });
    expect(lines).toContain('  model=gpt tier=3 cents=10');
  });

  it('marks missing fields as n/a instead of failing', () => {
    const lines = summarizeAggregation({});
    expect(lines[0]).toBe('keys: (none)');
    expect(lines[1]).toBe('total_cost_cents=n/a percent_of_burst_used=n/a');
  });

  it('handles non-object bodies', () => {
    expect(summarizeAggregation(null)).toEqual(['response is null']);
    expect(summarizeAggregation('oops')).toEqual(['response is string']);
  });
});
