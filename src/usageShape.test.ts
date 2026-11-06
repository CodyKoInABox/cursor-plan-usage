import { describe, expect, it } from 'vitest';
import { assertUsageShape, UnexpectedResponseError } from './usageShape';

describe('assertUsageShape', () => {
  it('accepts a body with both percent fields', () => {
    expect(() =>
      assertUsageShape({ planUsage: { autoPercentUsed: 12, apiPercentUsed: 3 } })
    ).not.toThrow();
  });

  it('accepts a body where only one percent field is present', () => {
    expect(() =>
      assertUsageShape({ planUsage: { apiPercentUsed: 0 } })
    ).not.toThrow();
  });

  it('accepts an empty planUsage when the cycle end is present (zero usage)', () => {
    expect(() =>
      assertUsageShape({
        planUsage: {},
        billingCycleEnd: '2026-12-01T00:00:00.000Z',
      })
    ).not.toThrow();
  });

  it('accepts spend-only planUsage with a numeric cycle end', () => {
    expect(() =>
      assertUsageShape({
        planUsage: { totalSpend: 0, limit: 2000 },
        billingCycleEnd: 1_790_000_000,
      })
    ).not.toThrow();
  });

  it('rejects an empty planUsage without a cycle end', () => {
    expect(() => assertUsageShape({ planUsage: {} })).toThrow(
      UnexpectedResponseError
    );
  });

  it('rejects planUsage with an unknown key (possible schema change)', () => {
    expect(() =>
      assertUsageShape({
        planUsage: { autoPercentRenamed: 12 },
        billingCycleEnd: 1_790_000_000,
      })
    ).toThrow(/no percent fields/);
  });

  it('rejects a non-object body', () => {
    expect(() => assertUsageShape(null)).toThrow(UnexpectedResponseError);
    expect(() => assertUsageShape('ok')).toThrow(UnexpectedResponseError);
  });

  it('rejects a body without planUsage', () => {
    expect(() => assertUsageShape({ membershipType: 'pro' })).toThrow(
      /planUsage is missing/
    );
  });

  it('rejects planUsage with no percent fields and no cycle end', () => {
    expect(() =>
      assertUsageShape({ planUsage: { totalSpend: 1234, limit: 2000 } })
    ).toThrow(/no percent fields/);
  });

  it('rejects percent fields that are not finite numbers', () => {
    expect(() =>
      assertUsageShape({ planUsage: { autoPercentUsed: '12' } })
    ).toThrow(UnexpectedResponseError);
  });
});
