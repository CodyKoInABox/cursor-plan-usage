# Cursor Plan Usage

**See your Cursor plan usage without leaving the editor.**

Live **Cursor Models** and **Other Models** percentages in a dockable sidebar and status bar chip — so you always know where you stand in the billing cycle.

#### You can easily install the extension through the Extensions tab inside Cursor:
<img width="268" height="228" alt="image" src="https://github.com/user-attachments/assets/2e36d629-3784-4ecd-b4be-677fd1a1ce41" />


[Install on Open VSX](https://open-vsx.org/extension/CodyKoInABox/cursor-plan-usage) · [Report an issue](https://github.com/CodyKoInABox/cursor-plan-usage/issues)

---

## Features

- **Sidebar panel** — CM / OM usage at a glance in the activity bar
- **Status bar chip** — `CM n% · OM n%` always visible while you work
- **Billing cycle** — progress through the period, end time, and a simple projection
- **Session deltas** — last-hour and IDE-session usage while the extension is sampling
- **Usage so far** — custom resettable window that persists across reloads; track any period you care about
- **Smart refresh** — updates on focus and AI activity; pauses when Cursor is unfocused


## UI Example
<img width="374" height="808" alt="Screenshot_1509" src="https://github.com/user-attachments/assets/42b61e48-6113-4b0e-b246-ec3a56f383bf" />


## Cursor only

This extension is built for **[Cursor](https://cursor.com)**, not plain VS Code. It reads Cursor’s local session data and talks to Cursor’s dashboard API. Install and run it inside Cursor.

## Install

#### You can easily install the extension through the Extensions tab inside Cursor:
<img width="268" height="228" alt="image" src="https://github.com/user-attachments/assets/2e36d629-3784-4ecd-b4be-677fd1a1ce41" />


Or via Open VSX: [Open VSX — CodyKoInABox/cursor-plan-usage](https://open-vsx.org/extension/CodyKoInABox/cursor-plan-usage)

Or sideload a `.vsix` from a release.
Or clone the repo and build locally with `npm run package`

After install, open the **Plan Usage** icon in the activity bar, or run **Plan Usage: Focus** from the Command Palette.

## Privacy

- Your access token is read from Cursor’s local DB into memory (or from Cursor **SecretStorage** if you set an override). It is **never written to disk** by this extension.
- The only network traffic is the usage request to Cursor’s API (`api2.cursor.sh` by default).
- No telemetry. Your account email is not shown in the UI.

## Commands

| Command | Description |
| --- | --- |
| **Plan Usage: Focus** | Open the Plan Usage sidebar |
| **Plan Usage: Refresh** | Force-refresh usage from the API |
| **Plan Usage: Set Session Token** | Store an optional session token in SecretStorage (overrides the local DB while set) |
| **Plan Usage: Clear Session Token** | Remove the override and fall back to Cursor’s local DB |

**Auth order:** SecretStorage override (if set) → otherwise token from Cursor’s local `state.vscdb`.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorPlanUsage.pollIntervalSeconds` | `0` | Idle poll interval (seconds) while focused. `0` = adaptive (30s burst for 2 min after AI activity, then 3 min). Polling pauses while unfocused. |
| `cursorPlanUsage.refreshOnAiActivity` | `true` | Refresh when Cursor’s local AI tracking DB updates |
| `cursorPlanUsage.apiBaseUrl` | `https://api2.cursor.sh` | Dashboard API base URL |

There is no `sessionToken` setting — use the Set / Clear Session Token commands instead.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| **No token found** | Sign in to Cursor, or run **Plan Usage: Set Session Token** with a valid session token / JWT. |
| **401 / unauthorized** | Re-sign into Cursor, or set a fresh token via **Plan Usage: Set Session Token**. |
| **Remote-SSH / WSL** | The extension runs in the **local** Cursor UI and uses the local session DB. If usage looks wrong in a remote window, use a local window or set a session token override. |

## Notes

Uses unofficial Cursor Connect-RPC dashboard endpoints. Those APIs can change or break without notice.

## License

[MIT](LICENSE) · Created by [CodyKoInABox](https://github.com/CodyKoInABox)
