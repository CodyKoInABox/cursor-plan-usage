import * as vscode from 'vscode';
import { redactSecrets } from './redact';

let channel: vscode.OutputChannel | undefined;

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
  channel.appendLine(`[${new Date().toISOString()}] ${redactSecrets(message)}`);
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
