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
  private refreshHandler?: () => Promise<void>;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setRefreshHandler(handler: () => Promise<void>): void {
    this.refreshHandler = handler;
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
          await this.refreshHandler();
        }
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.replayLastState();
      }
    });
  }

  showLoading(): void {
    this.post({ type: 'loading' });
  }

  showUsage(data: UsageSnapshot): void {
    this.lastSnapshot = data;
    this.lastError = undefined;
    this.post({ type: 'usageData', data });
  }

  showError(message: string): void {
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

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
