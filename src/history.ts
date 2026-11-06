import type { DailyUsage } from './types';

/**
 * One record per local calendar day: the highest cycle percent seen that day.
 * The chart derives per-day usage from the difference between consecutive days.
 */
export interface DailyRecord {
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** Billing cycle the values belong to. A cycle change restarts the day's peak. */
  cycleKey: string;
  cm: number;
  om: number;
}

/** Records older than this many days are dropped on write. */
export const HISTORY_RETENTION_DAYS = 35;
/** Days shown in the chart. */
export const HISTORY_CHART_DAYS = 14;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Local YYYY-MM-DD for a Date. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Shift a YYYY-MM-DD key by whole days using local calendar arithmetic. */
export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return localDayKey(new Date(y, m - 1, d + days));
}

/** Narrow persisted values to DailyRecord[], dropping anything malformed. */
export function parseDailyRecords(value: unknown): DailyRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (r): r is DailyRecord =>
      typeof r === 'object' &&
      r !== null &&
      typeof (r as DailyRecord).day === 'string' &&
      DAY_RE.test((r as DailyRecord).day) &&
      typeof (r as DailyRecord).cycleKey === 'string' &&
      Number.isFinite((r as DailyRecord).cm) &&
      Number.isFinite((r as DailyRecord).om)
  );
}

/**
 * Upsert today's record with the max percents seen, and drop records older
 * than the retention window. Returns a new array.
 */
export function recordDay(
  records: readonly DailyRecord[],
  day: string,
  cycleKey: string,
  cm: number,
  om: number
): DailyRecord[] {
  const cutoff = shiftDayKey(day, -HISTORY_RETENTION_DAYS);
  const kept = records.filter((r) => r.day >= cutoff && r.day !== day);
  const existing = records.find((r) => r.day === day);
  const sameCycle = existing !== undefined && existing.cycleKey === cycleKey;
  const next: DailyRecord = {
    day,
    cycleKey,
    cm: sameCycle ? Math.max(existing.cm, cm) : cm,
    om: sameCycle ? Math.max(existing.om, om) : om,
  };
  return [...kept, next].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Per-day usage for the last `days` days ending at `today`. A day has a value
 * only when the day before it is recorded in the same cycle. Otherwise the
 * entry has no cm/om and the chart leaves a gap.
 */
export function dailyUsage(
  records: readonly DailyRecord[],
  today: string,
  days: number = HISTORY_CHART_DAYS
): DailyUsage[] {
  const byDay = new Map(records.map((r) => [r.day, r]));
  const out: DailyUsage[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = shiftDayKey(today, -i);
    const rec = byDay.get(day);
    const prev = byDay.get(shiftDayKey(day, -1));
    if (!rec || !prev || rec.cycleKey !== prev.cycleKey) {
      out.push({ day });
      continue;
    }
    out.push({
      day,
      cm: Math.max(0, rec.cm - prev.cm),
      om: Math.max(0, rec.om - prev.om),
    });
  }
  return out;
}
