import type { MeterReading } from './alerts';
import type { OnDemandUsage } from './types';

/**
 * Cursor's dashboard client treats this individualLimit (cents) as "no cap".
 * It is 2^31 - 1, the largest value the hard-limit field can hold.
 */
export const UNLIMITED_LIMIT_CENTS = 2147483647;

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads on-demand spend from the `spendLimitUsage` block of GetCurrentPeriodUsage.
 * Field names and units follow Cursor's own dashboard client: `individualUsed`
 * and `individualLimit` are cents.
 *
 * Returns undefined when the block is absent, so the sidebar hides the meter
 * instead of showing a made-up $0. A missing or zero limit means off. A missing
 * `individualUsed` means 0, because proto3 JSON leaves out zero values.
 */
export function parseOnDemand(body: unknown): OnDemandUsage | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const block = (body as { spendLimitUsage?: unknown }).spendLimitUsage;
  if (typeof block !== 'object' || block === null) {
    return undefined;
  }
  const fields = block as Record<string, unknown>;
  const usedCents = isFiniteNumber(fields.individualUsed)
    ? Math.max(0, fields.individualUsed)
    : 0;
  const limit = fields.individualLimit;
  if (!isFiniteNumber(limit) || limit <= 0) {
    return { mode: 'disabled', usedCents };
  }
  if (limit >= UNLIMITED_LIMIT_CENTS) {
    return { mode: 'unlimited', usedCents };
  }
  return { mode: 'fixed', usedCents, limitCents: limit };
}

/** Whole-dollar-and-cents string from cents, e.g. 340 -> "$3.40". */
export function fmtUsd(cents: number): string {
  return USD.format(cents / 100);
}

/**
 * Alert reading for the on-demand cap, on the same global thresholds as the
 * plan meters. Only a fixed cap has a percent to test; unlimited and off do not.
 */
export function onDemandReading(od: OnDemandUsage | undefined): MeterReading | undefined {
  if (!od || od.mode !== 'fixed') {
    return undefined;
  }
  return {
    id: 'ondemand',
    label: 'On-demand',
    percent: (od.usedCents / od.limitCents) * 100,
  };
}

/** What the sidebar shows for an on-demand meter. Strings are final; the view only renders them. */
export interface OnDemandView {
  mode: OnDemandUsage['mode'];
  /** Right side of the section header, e.g. "$3.40 / $20.00". */
  headline: string;
  /** Line under the header. */
  subtitle: string;
  /** Bar fill, 0 to 100. Null when there is no cap to fill against. */
  barPct: number | null;
  /** Spend has reached the cap. */
  atLimit: boolean;
}

export function onDemandView(od: OnDemandUsage): OnDemandView {
  const used = fmtUsd(od.usedCents);

  if (od.mode === 'disabled') {
    return {
      mode: 'disabled',
      headline: 'Off',
      subtitle:
        od.usedCents > 0
          ? `${used} used this cycle`
          : 'Spend beyond your plan is not allowed',
      barPct: null,
      atLimit: false,
    };
  }

  if (od.mode === 'unlimited') {
    return {
      mode: 'unlimited',
      headline: `${used} used`,
      subtitle: 'No spend limit set',
      barPct: null,
      atLimit: false,
    };
  }

  const limit = od.limitCents;
  const ratio = limit > 0 ? od.usedCents / limit : 0;
  const atLimit = od.usedCents >= limit;
  const left = Math.max(0, limit - od.usedCents);
  return {
    mode: 'fixed',
    headline: `${used} / ${fmtUsd(limit)}`,
    subtitle: atLimit
      ? 'Limit reached'
      : `${Math.round(ratio * 100)}% of limit · ${fmtUsd(left)} left`,
    barPct: Math.min(100, ratio * 100),
    atLimit,
  };
}
