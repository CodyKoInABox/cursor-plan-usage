import * as vscode from 'vscode';
import { redactSecrets } from './redact';

let channel: vscode.OutputChannel | undefined;

/** Last debug lines, kept for "Copy Diagnostics". Only filled while debug is on. */
const RECENT_LINE_LIMIT = 50;
const recentLines: string[] = [];

/** Copy of the recent (already redacted) debug lines, oldest first. */
export function recentDebugLines(): string[] {
  return [...recentLines];
}

/** Read on every call, so toggling the setting takes effect immediately. */
export function debugEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('cursorPlanUsage')
    .get<boolean>('debug', false);
}

/**
 * Append one line to the "Cursor Plan Usage" output channel when
 * cursorPlanUsage.debug is on. Pass statuses, kinds, and timings only.
 */
export function debugLog(message: string): void {
  if (!debugEnabled()) {
    return;
  }
  channel ??= vscode.window.createOutputChannel('Cursor Plan Usage');
  const line = `[${new Date().toISOString()}] ${redactSecrets(message)}`;
  channel.appendLine(line);
  recentLines.push(line);
  if (recentLines.length > RECENT_LINE_LIMIT) {
    recentLines.splice(0, recentLines.length - RECENT_LINE_LIMIT);
  }
}

/** Disposes the output channel with the extension. */
export function debugChannelDisposable(): vscode.Disposable {
  return {
    dispose: () => {
      channel?.dispose();
      channel = undefined;
    },
  };
}
