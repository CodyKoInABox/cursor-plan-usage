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

  it('rejects a non-object body', () => {
    expect(() => assertUsageShape(null)).toThrow(UnexpectedResponseError);
    expect(() => assertUsageShape('ok')).toThrow(UnexpectedResponseError);
  });

  it('rejects a body without planUsage', () => {
    expect(() => assertUsageShape({ membershipType: 'pro' })).toThrow(
      /planUsage is missing/
    );
  });

  it('rejects planUsage with no percent fields, even if spend is present', () => {
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
