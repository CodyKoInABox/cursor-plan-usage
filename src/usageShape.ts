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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate the shape of a GetCurrentPeriodUsage body. Throws
 * UnexpectedResponseError when there is no usable percent field, instead of
 * letting the UI show 0% for an API that changed its schema.
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
  if (!PERCENT_KEYS.some((key) => isFiniteNumber(fields[key]))) {
    throw new UnexpectedResponseError(
      'Unexpected response from GetCurrentPeriodUsage: planUsage has no percent fields.'
    );
  }
}
