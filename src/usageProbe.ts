import { shiftDayKey } from './history';

export interface ProbeDay {
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** Local midnight, epoch ms. */
  startMs: number;
  /** Next local midnight, epoch ms. */
  endMs: number;
}

/** Local-day windows for `days` days ending on `today`, newest first. */
export function probeDays(today: string, days: number): ProbeDay[] {
  const out: ProbeDay[] = [];
  for (let i = 0; i < days; i++) {
    const day = shiftDayKey(today, -i);
    const [y, m, d] = day.split('-').map(Number);
    out.push({
      day,
      startMs: new Date(y, m - 1, d).getTime(),
      endMs: new Date(y, m - 1, d + 1).getTime(),
    });
  }
  return out;
}

/** Reads a field under either Connect JSON (camelCase) or proto (snake_case) naming. */
function field(obj: Record<string, unknown>, camel: string, snake: string): string {
  const value = obj[camel] ?? obj[snake];
  return value === undefined || value === null ? 'n/a' : String(value);
}

/**
 * Human-readable summary of one GetAggregatedUsageEvents body: the top-level
 * keys (so an unexpected shape is still visible), the day totals, and one line
 * per model. Numbers and model names only, no account data.
 */
export function summarizeAggregation(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) {
    return [`response is ${body === null ? 'null' : typeof body}`];
  }
  const obj = body as Record<string, unknown>;
  const lines = [
    `keys: ${Object.keys(obj).join(', ') || '(none)'}`,
    `total_cost_cents=${field(obj, 'totalCostCents', 'total_cost_cents')} ` +
      `percent_of_burst_used=${field(obj, 'percentOfBurstUsed', 'percent_of_burst_used')}`,
  ];
  if (Array.isArray(obj.aggregations)) {
    for (const item of obj.aggregations) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const agg = item as Record<string, unknown>;
      lines.push(
        `  model=${field(agg, 'modelIntent', 'model_intent')} ` +
          `tier=${field(agg, 'tier', 'tier')} ` +
          `cents=${field(agg, 'totalCents', 'total_cents')}`
      );
    }
  }
  return lines;
}
