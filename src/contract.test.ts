import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseCycleEndMs } from './billing';
import { parseOnDemand } from './onDemand';
import type { PlanInfoResponse } from './types';
import { assertUsageShape, UnexpectedResponseError } from './usageShape';

/**
 * Contract fixtures for Cursor's unofficial dashboard RPC. They are derived
 * from the response types in types.ts and the parsing rules in usageShape.ts
 * and billing.ts, not copied from a live capture. When a real response is
 * captured (sanitized, no tokens or emails), replace the matching file here.
 *
 * What these catch: a renamed percent field, a missing planUsage block, or a
 * cycle end format the parser no longer handles.
 */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', name), 'utf8')
  ) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('GetCurrentPeriodUsage contract', () => {
  it('accepts a usage response with percent fields', () => {
    const body = fixture('currentPeriodUsage.json');
    expect(() => assertUsageShape(body)).not.toThrow();
  });

  it('accepts the zero-usage shape (spend fields only, ISO cycle end)', () => {
    const body = fixture('currentPeriodUsageZero.json');
    expect(() => assertUsageShape(body)).not.toThrow();
  });

  it('parses numeric-string cycle bounds in epoch ms', () => {
    const body = fixture('currentPeriodUsage.json') as {
      billingCycleStart: string;
      billingCycleEnd: string;
    };
    expect(parseCycleEndMs(body.billingCycleStart)).toBe(
      Date.UTC(2026, 10, 1)
    );
    expect(parseCycleEndMs(body.billingCycleEnd)).toBe(
      Date.UTC(2026, 11, 1)
    );
  });

  it('parses ISO cycle bounds for the zero-usage shape', () => {
    const body = fixture('currentPeriodUsageZero.json') as {
      billingCycleEnd: string;
    };
    expect(parseCycleEndMs(body.billingCycleEnd)).toBe(
      Date.UTC(2026, 11, 1)
    );
  });

  it('reads on-demand spend and cap from spendLimitUsage', () => {
    const body = fixture('currentPeriodUsageOnDemand.json');
    expect(() => assertUsageShape(body)).not.toThrow();
    expect(parseOnDemand(body)).toEqual({
      mode: 'fixed',
      usedCents: 340,
      limitCents: 2000,
    });
  });

  it('rejects a renamed percent field instead of showing 0%', () => {
    const body = clone(fixture('currentPeriodUsage.json'));
    const plan = body.planUsage as Record<string, unknown>;
    plan.autoPct = plan.autoPercentUsed;
    delete plan.autoPercentUsed;
    delete plan.apiPercentUsed;

    expect(() => assertUsageShape(body)).toThrow(UnexpectedResponseError);
  });

  it('rejects a response without planUsage', () => {
    const body = clone(fixture('currentPeriodUsage.json'));
    delete body.planUsage;

    expect(() => assertUsageShape(body)).toThrow(UnexpectedResponseError);
  });

  it('rejects the zero-usage shape when the cycle end is gone', () => {
    const body = clone(fixture('currentPeriodUsageZero.json'));
    delete body.billingCycleEnd;

    expect(() => assertUsageShape(body)).toThrow(UnexpectedResponseError);
  });
});

describe('GetPlanInfo contract', () => {
  it('exposes the plan name the sidebar title is built from', () => {
    const info = fixture('planInfo.json') as PlanInfoResponse;
    expect(info.planInfo?.planName).toBe('Pro');
    expect(info.planInfo?.includedAmountCents).toBe(2000);
  });
});
