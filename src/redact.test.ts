import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxIn0.c2lnbmF0dXJl';

describe('redactSecrets', () => {
  it('replaces a JWT', () => {
    expect(redactSecrets(`token=${JWT} ok`)).toBe('token=<jwt> ok');
  });

  it('replaces the user_…:: prefix and keeps the JWT part redacted', () => {
    expect(redactSecrets(`user_01ABC::${JWT}`)).toBe('user_<redacted>::<jwt>');
  });

  it('replaces safeStorage ciphertext', () => {
    expect(redactSecrets('value=cursor-safe-storage:v1:djEwabc+/==')).toBe(
      'value=<sealed>'
    );
  });

  it('leaves ordinary text alone', () => {
    const plain = 'POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage -> 200 in 84ms';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
