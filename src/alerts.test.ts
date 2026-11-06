import { describe, expect, it } from 'vitest';
import {
  alertMessage,
  cycleKeyFor,
  decideAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  normalizeThresholds,
  parseAlertState,
  type MeterReading,
} from './alerts';

const auto = (percent: number): MeterReading => ({
  id: 'auto',
  label: 'Cursor Models',
  percent,
});
const api = (percent: number): MeterReading => ({
  id: 'api',
  label: 'Other Models',
  percent,
});

describe('normalizeThresholds', () => {
  it('falls back to defaults when the value is not an array', () => {
    expect(normalizeThresholds(undefined)).toEqual([80, 95]);
    expect(normalizeThresholds('80')).toEqual([80, 95]);
    expect(normalizeThresholds(null)).toEqual([80, 95]);
  });

  it('keeps an empty array (alerts off)', () => {
    expect(normalizeThresholds([])).toEqual([]);
  });

  it('drops out-of-range and non-numeric entries, rounds, dedupes, sorts', () => {
    expect(normalizeThresholds([95, 80, 80.4, 0, 101, NaN, '70', 1])).toEqual([
      1, 80, 95,
    ]);
  });

  it('default list is 80 and 95', () => {
    expect([...DEFAULT_ALERT_THRESHOLDS]).toEqual([80, 95]);
  });
});

describe('cycleKeyFor', () => {
  it('combines start and end when present', () => {
    expect(
      cycleKeyFor({
        billingCycleStart: 1000,
        billingCycleEnd: '2000',
        refreshedAt: '2026-11-04T00:00:00.000Z',
      })
    ).toBe('1000|2000');
  });

  it('falls back to the refresh month when no cycle is known', () => {
    expect(cycleKeyFor({ refreshedAt: '2026-11-04T10:00:00.000Z' })).toBe(
      '2026-11'
    );
  });
});

describe('parseAlertState', () => {
  it('accepts a well-formed state', () => {
    expect(parseAlertState({ cycle: 'c', notified: ['auto:80'] })).toEqual({
      cycle: 'c',
      notified: ['auto:80'],
    });
  });

  it('rejects junk', () => {
    expect(parseAlertState(undefined)).toBeUndefined();
    expect(parseAlertState('x')).toBeUndefined();
    expect(parseAlertState({ cycle: 1, notified: [] })).toBeUndefined();
    expect(parseAlertState({ cycle: 'c', notified: 'auto:80' })).toBeUndefined();
  });
});

describe('decideAlerts', () => {
  const thresholds = [80, 95];

  it('fires once when a threshold is first crossed', () => {
    const first = decideAlerts(undefined, 'c1', [auto(85), api(10)], thresholds);
    expect(first.alerts).toEqual([
      { label: 'Cursor Models', threshold: 80, percent: 85, kind: 'usage' },
    ]);
    expect(first.changed).toBe(true);

    const second = decideAlerts(first.state, 'c1', [auto(86), api(10)], thresholds);
    expect(second.alerts).toEqual([]);
    expect(second.changed).toBe(false);
  });

  it('does not fire below the threshold', () => {
    const d = decideAlerts(undefined, 'c1', [auto(79.9), api(0)], thresholds);
    expect(d.alerts).toEqual([]);
    expect(d.state.notified).toEqual([]);
  });

  it('announces only the highest of several crossed thresholds, but marks all', () => {
    const jump = decideAlerts(undefined, 'c1', [auto(97), api(0)], thresholds);
    expect(jump.alerts).toEqual([
      { label: 'Cursor Models', threshold: 95, percent: 97, kind: 'usage' },
    ]);
    expect(jump.state.notified).toEqual(['auto:80', 'auto:95']);

    const later = decideAlerts(jump.state, 'c1', [auto(99), api(0)], thresholds);
    expect(later.alerts).toEqual([]);
  });

  it('fires the 95 alert after the 80 one in the same cycle', () => {
    const at80 = decideAlerts(undefined, 'c1', [auto(81), api(0)], thresholds);
    const at95 = decideAlerts(at80.state, 'c1', [auto(96), api(0)], thresholds);
    expect(at95.alerts).toEqual([
      { label: 'Cursor Models', threshold: 95, percent: 96, kind: 'usage' },
    ]);
  });

  it('tracks the two meters independently', () => {
    const d = decideAlerts(undefined, 'c1', [auto(10), api(82)], thresholds);
    expect(d.alerts).toEqual([
      { label: 'Other Models', threshold: 80, percent: 82, kind: 'usage' },
    ]);
    expect(d.state.notified).toEqual(['api:80']);
  });

  it('resets notified thresholds on a new billing cycle', () => {
    const old = decideAlerts(undefined, 'c1', [auto(90), api(0)], thresholds);
    const next = decideAlerts(old.state, 'c2', [auto(90), api(0)], thresholds);
    expect(next.alerts).toEqual([
      { label: 'Cursor Models', threshold: 80, percent: 90, kind: 'usage' },
    ]);
    expect(next.state.cycle).toBe('c2');
    expect(next.changed).toBe(true);
  });

  it('persists a new cycle even when nothing is past a threshold', () => {
    const d = decideAlerts(undefined, 'c1', [auto(5), api(5)], thresholds);
    expect(d.changed).toBe(true);
    expect(d.state).toEqual({ cycle: 'c1', notified: [] });
  });

  it('with an empty threshold list never alerts', () => {
    const d = decideAlerts(undefined, 'c1', [auto(100), api(100)], []);
    expect(d.alerts).toEqual([]);
  });
});

describe('alertMessage', () => {
  it('names the meter, rounds the current percent, and names the threshold', () => {
    expect(
      alertMessage({ label: 'Other Models', threshold: 95, percent: 95.6, kind: 'usage' })
    ).toBe(
      'Plan Usage: Other Models at 96%, past your 95% alert this billing cycle.'
    );
  });
});

describe('budget readings', () => {
  it('uses their own threshold list and reports kind budget', () => {
    const d = decideAlerts(
      undefined,
      'c1',
      [
        { id: 'auto-budget', label: 'Cursor Models', percent: 104, kind: 'budget', thresholds: [90] },
        { id: 'api-budget', label: 'Other Models', percent: 40, kind: 'budget', thresholds: [90] },
      ],
      [80, 95]
    );
    expect(d.alerts).toEqual([
      { label: 'Cursor Models', threshold: 90, percent: 104, kind: 'budget' },
    ]);
    expect(d.state.notified).toEqual(['auto-budget:90']);
  });

  it('fires once per cycle for the budget too', () => {
    const first = decideAlerts(
      undefined,
      'c1',
      [{ id: 'auto-budget', label: 'Cursor Models', percent: 104, kind: 'budget', thresholds: [90] }],
      []
    );
    const again = decideAlerts(
      first.state,
      'c1',
      [{ id: 'auto-budget', label: 'Cursor Models', percent: 110, kind: 'budget', thresholds: [90] }],
      []
    );
    expect(again.alerts).toEqual([]);
  });

  it('words the budget message as a projection', () => {
    expect(
      alertMessage({ label: 'Cursor Models', threshold: 90, percent: 104.4, kind: 'budget' })
    ).toBe('Plan Usage: Cursor Models is projected to reach 104% this cycle, past your 90% budget.');
  });
});
