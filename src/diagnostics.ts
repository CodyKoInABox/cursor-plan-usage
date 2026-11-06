import { redactSecrets } from './redact';
import { fmtTokenExpiry } from './tokenExpiry';

export interface DiagnosticsInput {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  /** Where the token came from. Never the token itself. */
  token?: { source: string; sealed: boolean; expiresAt?: number };
  /** ErrorKind of the last failed refresh, if the last one failed. */
  lastError?: string;
  debugOn: boolean;
  /** Already redacted by debugLog; redacted again here as a backstop. */
  debugLines: readonly string[];
  nowMs: number;
}

/**
 * Plain-text report for bug reports. Contains versions, platform, the token's
 * origin and expiry, the last error kind, and (when debug is on) the recent
 * debug lines. Every line passes through redactSecrets.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const lines: string[] = [
    'Cursor Plan Usage diagnostics',
    `generated: ${new Date(input.nowMs).toISOString()}`,
    `extension: ${input.extensionVersion}`,
    `vscode: ${input.vscodeVersion}`,
    `platform: ${input.platform} ${input.arch}`,
    input.token
      ? `token: source=${input.token.source}, sealed=${input.token.sealed ? 'yes' : 'no'}, expires=${fmtTokenExpiry(input.token.expiresAt, input.nowMs)}`
      : 'token: none',
    `last error: ${input.lastError ?? 'none'}`,
  ];
  if (input.debugOn) {
    lines.push('', `--- last ${input.debugLines.length} debug lines (redacted) ---`);
    lines.push(...input.debugLines);
  } else {
    lines.push('', 'debug log: off (enable cursorPlanUsage.debug to include recent lines)');
  }
  return redactSecrets(lines.join('\n'));
}
