import { describe, expect, it } from 'vitest';
import { describeError, TokenError } from './errors';
import { SafeStorageError } from './safeStorage';
import { UnexpectedResponseError } from './usageShape';

/** Mirrors CursorApiError in api.ts without importing vscode. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'CursorApiError', status });
}

describe('describeError', () => {
  it('maps a decrypt failure to token-decrypt with the sign-in hint', () => {
    const info = describeError(new SafeStorageError('decrypt failed: bad key'));
    expect(info.kind).toBe('token-decrypt');
    expect(info.title).toMatch(/could not be decrypted/);
    expect(info.message).toBe('decrypt failed: bad key');
    expect(info.hint).toMatch(/Set Session Token/);
  });

  it('maps token errors by their kind', () => {
    expect(describeError(new TokenError('token-expired', 'x')).kind).toBe('token-expired');
    expect(describeError(new TokenError('token-missing', 'x')).kind).toBe('token-missing');
    expect(describeError(new TokenError('token-read', 'x')).kind).toBe('token-read');
  });

  it('maps a 401 from the API to token-rejected, not a generic API error', () => {
    const info = describeError(apiError(401, 'Cursor API ... failed (401)'));
    expect(info.kind).toBe('token-rejected');
    expect(info.hint).toMatch(/Sign in to Cursor again/);
  });

  it('keeps other API statuses as a generic API error', () => {
    const info = describeError(apiError(500, 'Cursor API ... failed (500)'));
    expect(info.kind).toBe('api');
    expect(info.hint).toBeUndefined();
  });

  it('maps a shape mismatch to unexpected-response', () => {
    const info = describeError(new UnexpectedResponseError('planUsage is missing.'));
    expect(info.kind).toBe('unexpected-response');
    expect(info.hint).toMatch(/Plan Usage update/);
  });

  it('falls back to unknown for anything else, including non-Error values', () => {
    expect(describeError(new Error('boom')).kind).toBe('unknown');
    expect(describeError('boom')).toEqual({
      kind: 'unknown',
      title: 'Could not load plan usage',
      message: 'boom',
    });
  });
});
