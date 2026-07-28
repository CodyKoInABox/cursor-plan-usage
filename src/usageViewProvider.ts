import * as vscode from 'vscode';
import type { UsageSnapshot } from './types';

type HostToWebview =
  | { type: 'usageData'; data: UsageSnapshot }
  | { type: 'error'; message: string }
  | { type: 'loading' };

type WebviewToHost = { type: 'refresh' } | { type: 'ready' };

export class UsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'cursorPlanUsage.panel';

  private view?: vscode.WebviewView;
  private lastSnapshot?: UsageSnapshot;
  private lastError?: string;
  private refreshHandler?: (opts?: { silent?: boolean }) => Promise<void>;
  private visibilityHandler?: (visible: boolean) => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setRefreshHandler(
    handler: (opts?: { silent?: boolean }) => Promise<void>
  ): void {
    this.refreshHandler = handler;
  }

  setVisibilityHandler(handler: (visible: boolean) => void): void {
    this.visibilityHandler = handler;
  }

  get visible(): boolean {
    return this.view?.visible === true;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'out', 'media'),
        vscode.Uri.joinPath(this.extensionUri, 'src', 'media'),
      ],
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      if (msg.type === 'refresh' || msg.type === 'ready') {
        if (msg.type === 'ready') {
          this.replayLastState();
        }
        if (msg.type === 'refresh' && this.refreshHandler) {
          await this.refreshHandler({ silent: false });
        }
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.replayLastState();
      }
      this.visibilityHandler?.(webviewView.visible);
    });
  }

  showLoading(): void {
    // Don't wipe the UI on background refreshes if we already have content.
    if (this.lastSnapshot || this.lastError) {
      return;
    }
    this.post({ type: 'loading' });
  }

  /** Returns false when usage metrics are unchanged (UI not rewritten). */
  showUsage(data: UsageSnapshot, opts?: { force?: boolean }): boolean {
    if (!opts?.force && sameUsage(this.lastSnapshot, data)) {
      return false;
    }
    this.lastSnapshot = data;
    this.lastError = undefined;
    this.post({ type: 'usageData', data });
    return true;
  }

  showError(message: string): void {
    if (this.lastError === message && !this.lastSnapshot) {
      return;
    }
    this.lastError = message;
    this.post({ type: 'error', message });
  }

  private replayLastState(): void {
    if (this.lastSnapshot) {
      this.post({ type: 'usageData', data: this.lastSnapshot });
    } else if (this.lastError) {
      this.post({ type: 'error', message: this.lastError });
    } else {
      this.post({ type: 'loading' });
    }
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'out', 'media');
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, 'view.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaRoot, 'view.js')
    );
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Plan Usage</title>
</head>
<body>
  <div id="app">
    <div class="state state-loading">Loading plan usage…</div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function sameWindow(
  a: UsageSnapshot['lastHour'],
  b: UsageSnapshot['lastHour']
): boolean {
  if (!a && !b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.autoPercentDelta === b.autoPercentDelta &&
    a.apiPercentDelta === b.apiPercentDelta &&
    a.partial === b.partial &&
    a.since === b.since
  );
}

function sameUsage(a: UsageSnapshot | undefined, b: UsageSnapshot): boolean {
  if (!a) {
    return false;
  }
  return (
    a.autoPercentUsed === b.autoPercentUsed &&
    a.apiPercentUsed === b.apiPercentUsed &&
    a.includedSpendCents === b.includedSpendCents &&
    a.planName === b.planName &&
    a.email === b.email &&
    a.billingCycleEnd === b.billingCycleEnd &&
    sameWindow(a.lastHour, b.lastHour) &&
    sameWindow(a.session, b.session)
  );
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
