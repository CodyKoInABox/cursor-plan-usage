# Changelog

## 0.3.0

### Features

- Added **Since last commit** usage window: plan % burned while the working tree is dirty, re-anchored on every HEAD move (automatic; no manual reset). Hidden when the tree is clean or the workspace is not a git repo
- Added **This branch** usage window: plan % while a feature branch is checked out, with active-time pause/resume so spend on other branches does not inflate the counter (hidden on the default branch)
- Optional status bar modes `sinceLastCommit` and `thisBranch`
- **Last hour** usage now persists across IDE reloads when sampling continued in the prior hour

### UI

- Timestamps use 24-hour format
- Git-aware windows wait for the built-in git API before rendering (no flicker / stale placeholders on startup)

### Docs

- Landing page and README updated for the git-aware windows

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
