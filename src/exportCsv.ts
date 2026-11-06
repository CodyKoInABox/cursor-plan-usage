import type { DailyRecord } from './history';

export const CSV_HEADER = 'date,cycle,cm_peak_percent,om_peak_percent';

/** RFC 4180 field: quote when it holds a comma, quote, or line break. */
export function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Daily records as CSV, oldest first. One row per local day with that day's
 * peak cycle percents. Holds no tokens, emails, or account data.
 */
export function toUsageCsv(records: readonly DailyRecord[]): string {
  const rows = [...records]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => [r.day, r.cycleKey, r.cm, r.om].map(csvField).join(','));
  return [CSV_HEADER, ...rows].join('\r\n') + '\r\n';
}
