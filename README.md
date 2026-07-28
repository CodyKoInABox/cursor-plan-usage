# Cursor Plan Usage

Dockable sidebar + status bar chip for **Cursor Models** and **Other Models** plan usage percentages — without leaving the editor.

## Cursor only

This extension targets **Cursor**, not plain VS Code. It reads Cursor’s local session DB (`state.vscdb`) and calls Cursor’s dashboard API. Install and run it inside Cursor.

## How it works

1. Reads your access token from Cursor’s local `state.vscdb` (copy → memory; **never writes** the token to disk).
2. Optionally uses a token override stored in VS Code/Cursor **SecretStorage** (Command Palette), not `settings.json`.
3. Calls unofficial Connect-RPC endpoints on `api2.cursor.sh` (`DashboardService/GetCurrentPeriodUsage`, `GetPlanInfo`). These can change or break without notice.

## Privacy

The only data that leaves your machine is your **bearer access token** (and the resulting usage request) sent to Cursor’s API (`api2.cursor.sh` by default). No telemetry from this extension. Account email is not shown in the UI.

## Install / publish targets

- **Cursor marketplace** (preferred when available)
- **Open VSX**
- **Sideload** a `.vsix` (`npm run package`)

The classic VS Code Marketplace is an awkward fit (Cursor-specific DB paths + unofficial Cursor APIs).

### Marketplace icon (required for publish)

Add a **128×128 PNG** at:

`resources/icon.png`

`package.json` already points `"icon": "resources/icon.png"`. The activity-bar SVG (`resources/icon.svg`) is separate and already present.

## Commands

| Command | What it does |
| --- | --- |
| **Plan Usage: Focus** | Opens the Plan Usage sidebar |
| **Plan Usage: Refresh** | Force-refresh usage from the API |
| **Plan Usage: Set Session Token** | Store an optional WorkosCursorSessionToken / JWT in SecretStorage (overrides DB while set) |
| **Plan Usage: Clear Session Token** | Remove the SecretStorage override and fall back to the local Cursor DB |

### Auth precedence

1. **SecretStorage** token — if set via **Plan Usage: Set Session Token** (intentional override)
2. Else token from Cursor’s local **`state.vscdb`**

On activate, any leftover plaintext `cursorPlanUsage.sessionToken` setting is migrated into SecretStorage once and cleared from settings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorPlanUsage.pollIntervalSeconds` | `0` | Idle poll interval (seconds) while focused. `0` = adaptive (30s burst for 2 min after AI activity, then 3 min). `>0` overrides the idle interval. Polling pauses while unfocused. |
| `cursorPlanUsage.refreshOnAiActivity` | `true` | Refresh when Cursor’s local AI tracking DB updates |
| `cursorPlanUsage.apiBaseUrl` | `https://api2.cursor.sh` | Dashboard API base URL |

There is **no** `sessionToken` setting anymore — use the Set/Clear Session Token commands.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **No token found** | Sign in to Cursor. Or run **Plan Usage: Set Session Token** with a valid WorkosCursorSessionToken / JWT. |
| **401 / unauthorized** | Extension clears the auth cache and retries. If it still fails, re-sign into Cursor or set a fresh SecretStorage token. |
| **Remote-SSH / WSL** | Extension runs as `"extensionKind": ["ui"]` so it uses the **local** Cursor UI process and local `state.vscdb`. If you’re in a remote window and usage looks wrong, focus a local Cursor window or set a session token override. |

## What you get

- Live CM / OM percentages in a Plan Usage sidebar
- Status bar chip: `CM n% · OM n%`
- Billing cycle progress + end time + simple projection
- Included spend/limit in the footer when the API provides it
- Last-hour and IDE-session usage deltas while sampling
- Adaptive refresh on focus / AI activity; pauses when unfocused

## Open source

Bug reports and PRs: [GitHub Issues](https://github.com/CodyKoInABox/cursor-plan-usage/issues).

## License

[MIT](LICENSE)

Created by [CodyKoInABox](https://github.com/CodyKoInABox)
