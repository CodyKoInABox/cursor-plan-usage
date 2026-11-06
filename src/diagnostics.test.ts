import { describe, expect, it } from 'vitest';
import { buildDiagnostics, type DiagnosticsInput } from './diagnostics';

const NOW = 1_800_000_000_000;
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';

function input(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  return {
    extensionVersion: '0.6.0',
    vscodeVersion: '1.99.0',
    platform: 'win32',
    arch: 'x64',
    token: { source: 'db', sealed: true, expiresAt: NOW + 23 * 3_600_000 },
    lastError: undefined,
    debugOn: false,
    debugLines: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe('buildDiagnostics', () => {
  it('reports versions, platform, token origin, and last error', () => {
    const out = buildDiagnostics(input({ lastError: 'token-expired' }));
    expect(out).toContain('extension: 0.6.0');
    expect(out).toContain('vscode: 1.99.0');
    expect(out).toContain('platform: win32 x64');
    expect(out).toContain('token: source=db, sealed=yes, expires=in 23h');
    expect(out).toContain('last error: token-expired');
  });

  it('says so when there is no token or no error', () => {
    const out = buildDiagnostics(input({ token: undefined }));
    expect(out).toContain('token: none');
    expect(out).toContain('last error: none');
  });

  it('says debug is off and includes no log lines when debug is off', () => {
    const out = buildDiagnostics(input({ debugOn: false, debugLines: ['should not appear'] }));
    expect(out).toContain('debug log: off');
    expect(out).not.toContain('should not appear');
  });

  it('includes the debug lines when debug is on', () => {
    const out = buildDiagnostics(
      input({ debugOn: true, debugLines: ['[t] refresh ok in 120ms'] })
    );
    expect(out).toContain('--- last 1 debug lines (redacted) ---');
    expect(out).toContain('[t] refresh ok in 120ms');
  });

  it('never contains a JWT or an email, even if they reach the debug lines', () => {
    const out = buildDiagnostics(
      input({
        debugOn: true,
        debugLines: [
          `[t] POST failed with Authorization: Bearer ${FAKE_JWT}`,
          '[t] account person@example.com signed in',
        ],
      })
    );
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toContain('person@example.com');
    expect(out).toContain('<jwt>');
    expect(out).toContain('<email>');
  });

  it('does not put a token value in the report (the input carries only origin and expiry)', () => {
    const out = buildDiagnostics(input());
    expect(out).not.toContain(FAKE_JWT);
    expect(out).not.toMatch(/eyJ/);
  });
});
