import type { CurrentPeriodUsageResponse } from './types';

/** The API answered 200 but the body is not a usage response we understand. */
export class UnexpectedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

/** At least one of these must be a number, or we would show 0% for real data. */
const PERCENT_KEYS = ['autoPercentUsed', 'apiPercentUsed', 'totalPercentUsed'] as const;

/**
 * Spend and limit fields the API sends alongside planUsage. A planUsage made
 * only of these (and no percent fields) is the zero-usage shape, as long as the
 * cycle end is present. Any other key is treated as a schema change.
 */
const ZERO_USAGE_KEYS: readonly string[] = [
  'totalSpend',
  'includedSpend',
  'bonusSpend',
  'remaining',
  'limit',
];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the shape of a GetCurrentPeriodUsage body. Throws
 * UnexpectedResponseError when there is no usable percent field, instead of
 * letting the UI show 0% for an API that changed its schema.
 *
 * The one exception: a zero-usage cycle where planUsage has no percent fields
 * at all, only known spend/limit keys, and billingCycleEnd is present.
 */
export function assertUsageShape(
  body: unknown
): asserts body is CurrentPeriodUsageResponse {
  if (typeof body !== 'object' || body === null) {
    throw new UnexpectedResponseError(
      'Unexpected response from GetCurrentPeriodUsage: body is not an object.'
    );
  }
  const plan = (body as { planUsage?: unknown }).planUsage;
  if (typeof plan !== 'object' || plan === null) {
    throw new UnexpectedResponseError(
      'Unexpected response from GetCurrentPeriodUsage: planUsage is missing.'
    );
  }
  const fields = plan as Record<string, unknown>;
  if (PERCENT_KEYS.some((key) => isFiniteNumber(fields[key]))) {
    return;
  }
  const cycleEnd = (body as { billingCycleEnd?: unknown }).billingCycleEnd;
  const hasCycleEnd =
    (typeof cycleEnd === 'string' && cycleEnd !== '') ||
    isFiniteNumber(cycleEnd);
  const knownKeysOnly = Object.keys(fields).every((k) =>
    ZERO_USAGE_KEYS.includes(k)
  );
  if (!(hasCycleEnd && knownKeysOnly)) {
    throw new UnexpectedResponseError(
      'Unexpected response from GetCurrentPeriodUsage: planUsage has no percent fields.'
    );
  }
}
