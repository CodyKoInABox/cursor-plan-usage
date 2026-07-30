# Changelog

## 0.2.0

### Features

- Added persistent, resettable **Usage so far** tracking for custom time periods
- Added an optional status bar mode showing usage since the last reset
- Automatically resets local tracking when the billing cycle changes
- Added relative **Last refreshed** time with the exact timestamp on hover
- Marks last-hour data as an outdated sample after long sampling gaps

### UI

- Renamed **Windows** to **Recent usage**
- Simplified the usage and footer layout
- Removed the included-spend display

## 0.1.0

Initial public release.

### Features

- Plan Usage sidebar + status bar chip for Cursor Models / Other Models usage
- Reads access token from Cursor local `state.vscdb` (read-only copy; never writes token to disk)
- Optional session-token override via SecretStorage (`Plan Usage: Set/Clear Session Token`)
- Adaptive polling, AI-activity refresh, billing-cycle progress / projection, session windows
- Shows included spend/limit in the footer when the API provides it

### Publish hardening

- Removed plaintext `cursorPlanUsage.sessionToken` setting; one-time migrate into SecretStorage
- `"extensionKind": ["ui"]` for local DB access (Remote-SSH / WSL)
- Workspace trust / virtual workspace capabilities declared
- Marketplace `icon` metadata (`resources/icon.png` — add before publishing)
- Webview `localResourceRoots` limited to `out/media`
- Error UI no longer resurrected as stale success on panel replay
