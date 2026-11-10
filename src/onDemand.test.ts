import { describe, expect, it } from 'vitest';
import { decideAlerts, DEFAULT_ALERT_THRESHOLDS } from './alerts';
import {
  fmtUsd,
  onDemandReading,
  onDemandView,
  parseOnDemand,
  UNLIMITED_LIMIT_CENTS,
} from './onDemand';

describe('parseOnDemand', () => {
  it('returns undefined when there is no spendLimitUsage block', () => {
    expect(parseOnDemand({ planUsage: { totalSpend: 0 } })).toBeUndefined();
    expect(parseOnDemand({ spendLimitUsage: null })).toBeUndefined();
    expect(parseOnDemand(null)).toBeUndefined();
    expect(parseOnDemand('nope')).toBeUndefined();
  });

  it('reads a fixed cap and the spend against it, in cents', () => {
    expect(
      parseOnDemand({ spendLimitUsage: { individualUsed: 340, individualLimit: 2000 } })
    ).toEqual({ mode: 'fixed', usedCents: 340, limitCents: 2000 });
  });

  it('treats a zero or missing limit as off', () => {
    expect(
      parseOnDemand({ spendLimitUsage: { individualUsed: 0, individualLimit: 0 } })
    ).toEqual({ mode: 'disabled', usedCents: 0 });
    expect(parseOnDemand({ spendLimitUsage: { individualUsed: 120 } })).toEqual({
      mode: 'disabled',
      usedCents: 120,
    });
  });

  it('treats the no-limit sentinel as unlimited', () => {
    expect(
      parseOnDemand({
        spendLimitUsage: { individualUsed: 50, individualLimit: UNLIMITED_LIMIT_CENTS },
      })
    ).toEqual({ mode: 'unlimited', usedCents: 50 });
  });

  it('reads a missing individualUsed as zero (proto3 omits zero values)', () => {
    expect(parseOnDemand({ spendLimitUsage: { individualLimit: 2000 } })).toEqual({
      mode: 'fixed',
      usedCents: 0,
      limitCents: 2000,
    });
  });

  it('never returns negative spend', () => {
    expect(
      parseOnDemand({ spendLimitUsage: { individualUsed: -5, individualLimit: 2000 } })
    ).toEqual({ mode: 'fixed', usedCents: 0, limitCents: 2000 });
  });
});

describe('onDemandReading', () => {
  it('reads a fixed cap as a percent of the limit', () => {
    expect(
      onDemandReading({ mode: 'fixed', usedCents: 1600, limitCents: 2000 })
    ).toEqual({ id: 'ondemand', label: 'On-demand', percent: 80 });
  });

  it('has no reading when off, unlimited, or absent', () => {
    expect(onDemandReading({ mode: 'disabled', usedCents: 500 })).toBeUndefined();
    expect(onDemandReading({ mode: 'unlimited', usedCents: 500 })).toBeUndefined();
    expect(onDemandReading(undefined)).toBeUndefined();
  });

  it('alerts once per threshold per cycle, using the global thresholds', () => {
    const reading = (usedCents: number) =>
      onDemandReading({ mode: 'fixed', usedCents, limitCents: 2000 });
    const first = decideAlerts(undefined, 'c1', [reading(1600)!], DEFAULT_ALERT_THRESHOLDS);
    expect(first.alerts).toEqual([
      { label: 'On-demand', threshold: 80, percent: 80, kind: 'usage' },
    ]);

    const again = decideAlerts(first.state, 'c1', [reading(1700)!], DEFAULT_ALERT_THRESHOLDS);
    expect(again.alerts).toEqual([]);

    const high = decideAlerts(again.state, 'c1', [reading(1900)!], DEFAULT_ALERT_THRESHOLDS);
    expect(high.alerts).toEqual([
      { label: 'On-demand', threshold: 95, percent: 95, kind: 'usage' },
    ]);

    const nextCycle = decideAlerts(high.state, 'c2', [reading(1600)!], DEFAULT_ALERT_THRESHOLDS);
    expect(nextCycle.alerts).toHaveLength(1);
  });
});

describe('fmtUsd', () => {
  it('formats cents as US dollars', () => {
    expect(fmtUsd(340)).toBe('$3.40');
    expect(fmtUsd(2000)).toBe('$20.00');
    expect(fmtUsd(0)).toBe('$0.00');
  });
});

describe('onDemandView', () => {
  it('shows used over cap, percent, and what is left', () => {
    const v = onDemandView({ mode: 'fixed', usedCents: 340, limitCents: 2000 });
    expect(v.headline).toBe('$3.40 / $20.00');
    expect(v.subtitle).toBe('17% of limit · $16.60 left');
    expect(v.barPct).toBeCloseTo(17, 5);
    expect(v.atLimit).toBe(false);
  });

  it('caps the bar at 100 and flags the limit when spend reaches it', () => {
    const v = onDemandView({ mode: 'fixed', usedCents: 2000, limitCents: 2000 });
    expect(v.subtitle).toBe('Limit reached');
    expect(v.barPct).toBe(100);
    expect(v.atLimit).toBe(true);
  });

  it('never shows negative money left when spend is over the cap', () => {
    const v = onDemandView({ mode: 'fixed', usedCents: 2500, limitCents: 2000 });
    expect(v.subtitle).toBe('Limit reached');
    expect(v.barPct).toBe(100);
  });

  it('says Off with no bar when disabled and nothing was spent', () => {
    const v = onDemandView({ mode: 'disabled', usedCents: 0 });
    expect(v.headline).toBe('Off');
    expect(v.subtitle).toBe('Spend beyond your plan is not allowed');
    expect(v.barPct).toBeNull();
  });

  it('keeps the spent amount visible when disabled', () => {
    const v = onDemandView({ mode: 'disabled', usedCents: 120 });
    expect(v.headline).toBe('Off');
    expect(v.subtitle).toBe('$1.20 used this cycle');
    expect(v.barPct).toBeNull();
  });

  it('shows spend only, with no bar, when the cap is unlimited', () => {
    const v = onDemandView({ mode: 'unlimited', usedCents: 750 });
    expect(v.headline).toBe('$7.50 used');
    expect(v.subtitle).toBe('No spend limit set');
    expect(v.barPct).toBeNull();
    expect(v.atLimit).toBe(false);
  });
});
