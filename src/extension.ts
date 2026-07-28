import * as vscode from 'vscode';
import { resolveAuth } from './auth';
import { fetchUsageSnapshot } from './api';
import { UsageViewProvider } from './usageViewProvider';
import type { UsageSnapshot } from './types';

let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new UsageViewProvider(context.extensionUri);
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'cursorPlanUsage.focus';
  statusBar.tooltip = 'Cursor Plan Usage';
  statusBar.text = '$(pulse) Plan…';
  statusBar.show();

  const refresh = async (): Promise<void> => {
    if (refreshing) {
      return;
    }
    refreshing = true;
    provider.showLoading();
    try {
      const auth = await resolveAuth(context.extensionPath);
      const snapshot = await fetchUsageSnapshot(auth);
      provider.showUsage(snapshot);
      updateStatusBar(statusBar, snapshot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      provider.showError(message);
      statusBar.text = '$(warning) Plan';
      statusBar.tooltip = message;
    } finally {
      refreshing = false;
    }
  };

  provider.setRefreshHandler(refresh);

  const clearPoll = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const setupPolling = (): void => {
    clearPoll();
    const seconds = vscode.workspace
      .getConfiguration('cursorPlanUsage')
      .get<number>('pollIntervalSeconds', 120);

    if (!seconds || seconds <= 0) {
      return;
    }

    const ms = Math.max(30, seconds) * 1000;
    pollTimer = setInterval(() => {
      void refresh();
    }, ms);
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    statusBar,
    vscode.commands.registerCommand('cursorPlanUsage.focus', async () => {
      await vscode.commands.executeCommand(`${UsageViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('cursorPlanUsage.refresh', () => refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorPlanUsage')) {
        setupPolling();
        void refresh();
      }
    }),
    { dispose: clearPoll }
  );

  setupPolling();
  void refresh();
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  snapshot: UsageSnapshot
): void {
  const cm = Math.round(snapshot.autoPercentUsed);
  const om = Math.round(snapshot.apiPercentUsed);
  item.text = `$(dashboard) CM ${cm}% · OM ${om}%`;
  item.tooltip = `Cursor Plan Usage — ${snapshot.planName}\nCursor Models ${cm}% · Other Models ${om}%`;
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}
