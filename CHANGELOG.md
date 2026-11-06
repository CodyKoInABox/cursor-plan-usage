# Changelog

## 0.4.1

### Fixes

- A usage response with an empty `planUsage` and a billing cycle end now shows 0% instead of an error. Unknown fields still show an error (#49)

### Pipeline

- CI and release run on `ubuntu-24.04` instead of `ubuntu-latest` (#50)

## 0.4.0

### Features

- Burn-rate estimate under each meter: the rate from the last hour and the time to 100%, or a note that the cycle resets first. It is an estimate: the rate is extrapolated from one hour and can change quickly. Not shown when the last-hour window is outdated (#29)

## 0.3.7

### Features

- Warnings when Cursor Models or Other Models usage crosses a threshold (default 80% and 95%). Each threshold fires once per meter per billing cycle. Set `cursorPlanUsage.alerts` to `false` to turn them off, or `cursorPlanUsage.alertThresholds` to change the percentages (#22)
- Time until the billing cycle resets, shown in the panel (ticks every 30s) and in the status bar tooltip (#23)

## 0.3.6

### Features

- The footer shows where the session token came from (Cursor local DB or Session Token override), whether it was decrypted, and how long until it expires (#19)
- Failures show a title, detail, and hint per kind: missing token, expired token, rejected token, decrypt failure, unexpected response, API error (#20)
- `cursorPlanUsage.debug` (off by default) writes refresh, API status, and token-source lines to the "Cursor Plan Usage" output channel. Secrets are redacted (#21)

## 0.3.5

### Fixes

- The cached session token is re-read when Cursor writes `state.vscdb`, at most once a minute, so a rotated token is picked up (#17)
- Windows: failures that come from PowerShell (blocked by AppLocker or WDAC, timed out, or exited) name the cause and point to Set Session Token (#26)

### Dependencies

- `npm audit` reports 0 vulnerabilities. Dev tooling moved to `@vscode/vsce` 4 and `esbuild` 0.28, with a `minimatch` override (#18)

## 0.3.4

### Fixes

- A usage response with no percent fields (schema change) now shows an error instead of 0% (#27)
- Expired session tokens are rejected before any request, with a specific message instead of a 401 (#28)

### Pipeline

- CI packages the extension on pull requests, so packaging failures show before a tag is pushed (#24)
- Release: the GitHub Release is created before publishing to Open VSX. If Open VSX fails, re-run only that job (#25)

## 0.3.3

### Fixes

- Fixed `401 ERROR_NOT_LOGGED_IN` on 0.3.2. When `cursor.storage.authTokenEncryptionAtRest` is on, Cursor stores `cursorAuth/accessToken` as `cursor-safe-storage:v1:` + base64 (Electron safeStorage). 0.3.2 sent that ciphertext as the Bearer token. The token is now decrypted in memory right after it is read from `state.vscdb` and before any request. Windows uses DPAPI for the key plus AES-256-GCM. macOS uses the `Cursor Safe Storage` keychain password plus AES-128-CBC. Linux uses the Secret Service password (or `peanuts`) plus AES-128-CBC. Plain JWTs still pass through unchanged. The `SecretStorage` session-token override is unsealed the same way.
- Decrypted tokens are never written to disk or logged. The Windows key and keychain/keyring passwords are cached per process.
- App-bound (`v20`) tokens and decrypt failures (wrong key, bad GCM tag) now show an explicit error instead of a generic 401.

## 0.3.2

### Fixes

- Cursor keeps `state.vscdb` in WAL mode. The WASM SQLite driver cannot open WAL files, so 0.3.1 failed with `Could not read Cursor session from local DB: unable to open database file`. Copy the DB to a temp file, strip the WAL flag on that copy, then query. The live Cursor database is never written. Non-WAL files still open in place, so multi-GiB state DBs are not copied.
- Decode `ItemTable` BLOB values as UTF-8 so blob-stored access tokens still authenticate.

## 0.3.1

### Fixes

- Read Cursor's local state database through a filesystem-backed SQLite driver instead of copying and loading the entire file into memory. This fixes authentication when `state.vscdb` is larger than 2 GiB ([#12](https://github.com/CodyKoInABox/cursor-plan-usage/issues/12))

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
