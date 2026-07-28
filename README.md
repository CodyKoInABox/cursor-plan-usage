# Cursor Plan Usage

Dockable Cursor/VS Code sidebar that mirrors **Settings → Plan & Usage**:

- **Cursor Models** — `planUsage.autoPercentUsed`
- **Other Models** — `planUsage.apiPercentUsed`

Plus plan label, billing-cycle end, and a compact status-bar chip (`CM n% · OM n%`).

## Install (VSIX)

```bash
npm install
npm run compile
npm run package
```

In Cursor: **Extensions: Install from VSIX…** → pick the generated `.vsix`.

## Auth

By default the extension **auto-reads** your local Cursor session (never stored by the extension):

| OS | Path |
|---|---|
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

It copies the DB then reads `cursorAuth/accessToken` via `sql.js` (WASM).

**Fallback:** set `cursorPlanUsage.sessionToken` to a `WorkosCursorSessionToken` or raw JWT if auto-detect fails.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `cursorPlanUsage.pollIntervalSeconds` | `120` | `0` disables polling |
| `cursorPlanUsage.sessionToken` | `""` | Optional override |
| `cursorPlanUsage.apiBaseUrl` | `https://api2.cursor.sh` | Dashboard RPC host |

## Commands

- **Plan Usage: Focus** — open the sidebar
- **Plan Usage: Refresh** — fetch now (also on the view title bar)

## Unofficial API disclaimer

Usage is loaded from Cursor’s undocumented Connect-RPC dashboard endpoints:

- `POST …/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
- `POST …/aiserver.v1.DashboardService/GetPlanInfo`

These can change or break without notice. The UI surfaces errors and a Refresh action when that happens.

Tokens are only sent to `cursorPlanUsage.apiBaseUrl`. The extension never logs the token or full DB path in the webview.

## Dev

```bash
npm install
npm run watch
```

Then **Run Extension** from `.vscode/launch.json` (Extension Development Host).

## License

MIT
