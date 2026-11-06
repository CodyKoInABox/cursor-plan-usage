import { describe, expect, it } from 'vitest';
import {
  dailyUsage,
  type DailyRecord,
  HISTORY_RETENTION_DAYS,
  localDayKey,
  parseDailyRecords,
  recordDay,
  shiftDayKey,
} from './history';

const rec = (day: string, cm: number, om = 0, cycleKey = 'c1'): DailyRecord => ({
  day,
  cycleKey,
  cm,
  om,
});

describe('day keys', () => {
  it('formats local dates as YYYY-MM-DD', () => {
    expect(localDayKey(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05');
  });

  it('shifts across month and year boundaries', () => {
    expect(shiftDayKey('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftDayKey('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDayKey('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('parseDailyRecords', () => {
  it('keeps well-formed records and drops junk', () => {
    const out = parseDailyRecords([
      rec('2026-11-05', 10, 2),
      { day: 'nope', cycleKey: 'c', cm: 1, om: 1 },
      { day: '2026-11-04', cycleKey: 'c', cm: 'x', om: 1 },
      null,
    ]);
    expect(out).toEqual([rec('2026-11-05', 10, 2)]);
  });

  it('returns [] for non-arrays', () => {
    expect(parseDailyRecords(undefined)).toEqual([]);
    expect(parseDailyRecords({})).toEqual([]);
  });
});

describe('recordDay', () => {
  it('keeps the max seen today', () => {
    let r = recordDay([], '2026-11-05', 'c1', 10, 1);
    r = recordDay(r, '2026-11-05', 'c1', 12, 0.5);
    expect(r).toEqual([rec('2026-11-05', 12, 1)]);
  });

  it('restarts the peak when the cycle changes mid-day', () => {
    const r = recordDay([rec('2026-11-05', 80, 40, 'old')], '2026-11-05', 'new', 3, 1);
    expect(r).toEqual([rec('2026-11-05', 3, 1, 'new')]);
  });

  it('drops records older than the retention window', () => {
    const today = '2026-11-05';
    const oldest = shiftDayKey(today, -HISTORY_RETENTION_DAYS);
    const tooOld = shiftDayKey(today, -HISTORY_RETENTION_DAYS - 1);
    const r = recordDay([rec(tooOld, 1), rec(oldest, 2)], today, 'c1', 5, 0);
    expect(r.map((x) => x.day)).toEqual([oldest, today]);
  });

  it('sorts by day', () => {
    const r = recordDay([rec('2026-11-04', 1)], '2026-11-03', 'c1', 1, 0);
    expect(r.map((x) => x.day)).toEqual(['2026-11-03', '2026-11-04']);
  });
});

describe('dailyUsage', () => {
  it('shows the difference from the previous recorded day', () => {
    const out = dailyUsage(
      [rec('2026-11-03', 10, 2), rec('2026-11-04', 14, 2.5), rec('2026-11-05', 20, 2.5)],
      '2026-11-05',
      3
    );
    expect(out).toEqual([
      { day: '2026-11-03' }, // 11-02 not recorded, so a gap
      { day: '2026-11-04', cm: 4, om: 0.5 },
      { day: '2026-11-05', cm: 6, om: 0 },
    ]);
  });

  it('leaves a gap when the previous day is missing', () => {
    const out = dailyUsage([rec('2026-11-05', 20), rec('2026-11-03', 10)], '2026-11-05', 3);
    expect(out[1]).toEqual({ day: '2026-11-04' });
    expect(out[2]).toEqual({ day: '2026-11-05' });
  });

  it('leaves a gap across a cycle change', () => {
    const out = dailyUsage(
      [rec('2026-11-04', 90, 0, 'old'), rec('2026-11-05', 3, 0, 'new')],
      '2026-11-05',
      2
    );
    expect(out[1]).toEqual({ day: '2026-11-05' });
  });

  it('never reports negative usage', () => {
    const out = dailyUsage([rec('2026-11-04', 50), rec('2026-11-05', 48)], '2026-11-05', 2);
    expect(out[1]).toEqual({ day: '2026-11-05', cm: 0, om: 0 });
  });

  it('returns one entry per requested day, oldest first', () => {
    const out = dailyUsage([], '2026-11-05', 14);
    expect(out).toHaveLength(14);
    expect(out[0].day).toBe('2026-10-23');
    expect(out[13].day).toBe('2026-11-05');
  });
});
