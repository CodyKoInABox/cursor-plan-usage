import { describe, expect, it } from 'vitest';
import { csvField, CSV_HEADER, toUsageCsv } from './exportCsv';
import type { DailyRecord } from './history';

const rec = (day: string, cm: number, om: number, cycleKey = '1|2'): DailyRecord => ({
  day,
  cycleKey,
  cm,
  om,
});

describe('csvField', () => {
  it('leaves plain values alone', () => {
    expect(csvField('2026-11-05')).toBe('2026-11-05');
    expect(csvField(12.5)).toBe('12.5');
  });

  it('quotes values with commas, quotes, or line breaks', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });
});

describe('toUsageCsv', () => {
  it('starts with the header and uses CRLF line endings', () => {
    const out = toUsageCsv([rec('2026-11-05', 10, 2)]);
    expect(out.split('\r\n')[0]).toBe(CSV_HEADER);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('writes one row per day, oldest first, regardless of input order', () => {
    const out = toUsageCsv([rec('2026-11-05', 20, 3), rec('2026-11-03', 10, 1)]);
    expect(out.split('\r\n').slice(1, 3)).toEqual([
      '2026-11-03,1|2,10,1',
      '2026-11-05,1|2,20,3',
    ]);
  });

  it('is only the header when there are no records', () => {
    expect(toUsageCsv([])).toBe(`${CSV_HEADER}\r\n`);
  });

  it('contains only the documented columns', () => {
    const out = toUsageCsv([rec('2026-11-05', 1, 2)]);
    for (const line of out.trim().split('\r\n')) {
      expect(line.split(',')).toHaveLength(4);
    }
    expect(out).not.toMatch(/@|eyJ|user_/);
  });
});
