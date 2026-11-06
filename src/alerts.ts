import type { UsageSnapshot } from './types';

/** Used when `cursorPlanUsage.alertThresholds` is not an array. */
export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [80, 95];

/**
 * One meter at a percent to test. `usage` readings use the global thresholds;
 * `budget` readings (projected cycle end) use their own single threshold.
 */
export interface MeterReading {
  id: string;
  label: string;
  percent: number;
  kind?: 'usage' | 'budget';
  thresholds?: readonly number[];
}

/**
 * Which thresholds already fired in which billing cycle. `notified` holds
 * `"<meter>:<threshold>"` keys, e.g. `"auto:80"`.
 */
export interface AlertState {
  cycle: string;
  notified: string[];
}

export interface PendingAlert {
  label: string;
  /** Highest threshold crossed in this refresh (one toast per meter). */
  threshold: number;
  percent: number;
  kind: 'usage' | 'budget';
}

export interface AlertDecision {
  alerts: PendingAlert[];
  state: AlertState;
  /** True when the caller should persist `state`. */
  changed: boolean;
}

/**
 * Sanitize the configured threshold list: whole numbers in 1–100, unique,
 * ascending. Anything that is not an array falls back to the defaults. An
 * empty array is kept and means "no thresholds".
 */
export function normalizeThresholds(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [...DEFAULT_ALERT_THRESHOLDS];
  }
  const out = new Set<number>();
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      continue;
    }
    const t = Math.round(v);
    if (t >= 1 && t <= 100) {
      out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Identity of the billing cycle a snapshot belongs to. Uses the API's cycle
 * start/end; when neither is present, falls back to the calendar month of the
 * refresh so alerts still reset monthly.
 */
export function cycleKeyFor(
  snapshot: Pick<UsageSnapshot, 'billingCycleStart' | 'billingCycleEnd' | 'refreshedAt'>
): string {
  const { billingCycleStart: start, billingCycleEnd: end } = snapshot;
  if (start == null && end == null) {
    return snapshot.refreshedAt.slice(0, 7);
  }
  return `${start ?? ''}|${end ?? ''}`;
}

/** Narrow an unknown persisted value to AlertState, or undefined. */
export function parseAlertState(value: unknown): AlertState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Partial<AlertState>;
  if (typeof v.cycle !== 'string' || !Array.isArray(v.notified)) {
    return undefined;
  }
  const notified = v.notified.filter((k): k is string => typeof k === 'string');
  return { cycle: v.cycle, notified };
}

function thresholdKey(id: string, threshold: number): string {
  return `${id}:${threshold}`;
}

/**
 * Decide which meters should alert on this refresh. A threshold fires at most
 * once per cycle per meter. If a refresh crosses several thresholds at once,
 * only the highest one is announced, but all of them are marked as notified.
 * A new cycle clears the notified set.
 */
export function decideAlerts(
  stored: AlertState | undefined,
  cycle: string,
  readings: readonly MeterReading[],
  thresholds: readonly number[]
): AlertDecision {
  const sameCycle = stored !== undefined && stored.cycle === cycle;
  const notified = new Set(sameCycle ? stored.notified : []);
  const alerts: PendingAlert[] = [];

  for (const r of readings) {
    const limits = r.thresholds ?? thresholds;
    const crossed = limits.filter(
      (t) => r.percent >= t && !notified.has(thresholdKey(r.id, t))
    );
    if (crossed.length === 0) {
      continue;
    }
    for (const t of crossed) {
      notified.add(thresholdKey(r.id, t));
    }
    alerts.push({
      label: r.label,
      threshold: Math.max(...crossed),
      percent: r.percent,
      kind: r.kind ?? 'usage',
    });
  }

  const state: AlertState = { cycle, notified: [...notified].sort() };
  return {
    alerts,
    state,
    changed: alerts.length > 0 || !sameCycle,
  };
}

/** Toast text for one pending alert. */
export function alertMessage(alert: PendingAlert): string {
  const now = Math.round(alert.percent);
  if (alert.kind === 'budget') {
    return `Plan Usage: ${alert.label} is projected to reach ${now}% this cycle, past your ${alert.threshold}% budget.`;
  }
  return `Plan Usage: ${alert.label} at ${now}%, past your ${alert.threshold}% alert this billing cycle.`;
}
