import { describe, expect, it } from 'vitest';
import { tokenInfoFor } from './tokenInfo';

describe('tokenInfoFor', () => {
  it('describes a plain DB token without copying the token', () => {
    const info = tokenInfoFor({
      accessToken: 'eyJsecret.payload.sig',
      source: 'db',
      expiresAt: 1_800_000_000_000,
    });

    expect(info).toEqual({
      source: 'db',
      sealed: false,
      expiresAt: 1_800_000_000_000,
    });
    expect(JSON.stringify(info)).not.toContain('eyJsecret');
  });

  it('marks a decrypted DB token as sealed', () => {
    expect(tokenInfoFor({ accessToken: 'x', source: 'db', sealed: true })).toEqual({
      source: 'db',
      sealed: true,
      expiresAt: undefined,
    });
  });

  it('keeps the secret-override source', () => {
    expect(tokenInfoFor({ accessToken: 'x', source: 'secret' }).source).toBe('secret');
  });
});
