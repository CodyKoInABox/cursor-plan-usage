import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { type AuthCacheEntry, canReuseAuth } from './authCache';
import { TokenError } from './errors';
import { isExpired, jwtExpiresAtMs } from './jwt';
import { debugLog } from './log';
import { cursorStateDbPathFor } from './paths';
import {
  defaultUnsealOptions,
  isSealed,
  SafeStorageError,
  unsealToken,
} from './safeStorage';
import { readAuthFromStateDb } from './stateDb';
import type { AuthResult } from './types';

/** vscode.SecretStorage key for optional session-token override. */
export const SESSION_TOKEN_SECRET_KEY = 'cursorPlanUsage.sessionToken';

const SECRET_EXPIRED_MESSAGE =
  'The session token override has expired. Set a fresh JWT with “Plan Usage: Set Session Token”, or clear it to use Cursor’s local DB.';
const DB_EXPIRED_MESSAGE =
  'Cursor’s local session token has expired. Sign in to Cursor again so it refreshes the token.';

/** In-memory only — never written to disk by this extension. */
let cachedAuth: AuthCacheEntry | undefined;
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000;
/** Set when Cursor writes state.vscdb. Cleared by the next successful read. */
let authStale = false;

export function clearAuthCache(): void {
  cachedAuth = undefined;
  authStale = false;
}

/** Mark the cached token as possibly outdated. Re-read is rate-limited in canReuseAuth. */
export function markAuthStale(): void {
  authStale = true;
}

/**
 * Watch Cursor's globalStorage folder for state.vscdb writes. Cursor rotates its
 * access token there, so a cached token can go stale between polls.
 */
export function watchStateDbForAuth(): vscode.Disposable {
  const dir = path.dirname(getCursorStateDbPath());
  if (!fs.existsSync(dir)) {
    return { dispose: () => undefined };
  }
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      const name = filename?.toString();
      if (!name || name === 'state.vscdb' || name === 'state.vscdb-wal') {
        markAuthStale();
      }
    });
  } catch {
    return { dispose: () => undefined };
  }
  return {
    dispose: () => {
      try {
        watcher?.close();
      } catch {
        // ignore
      }
    },
  };
}

/** Resolve Cursor's globalStorage state.vscdb for the current OS. */
export function getCursorStateDbPath(): string {
  return cursorStateDbPathFor(process.platform, os.homedir(), process.env.APPDATA);
}

/**
 * WorkosCursorSessionToken is often `user_…::eyJ…`.
 * Prefer the JWT segment when present; otherwise treat the whole string as a bearer token.
 */
export function normalizeSessionToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  const sep = trimmed.indexOf('::');
  if (sep !== -1) {
    const maybeJwt = trimmed.slice(sep + 2).trim();
    if (maybeJwt) {
      return maybeJwt;
    }
  }
  return trimmed;
}

async function readFromStateDb(): Promise<AuthResult | undefined> {
  const dbPath = getCursorStateDbPath();
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(dbPath));
  } catch {
    return undefined;
  }
  return readAuthFromStateDb(dbPath);
}

async function readSecretToken(
  secrets: vscode.SecretStorage
): Promise<{ token: string; sealed: boolean } | undefined> {
  const raw = await secrets.get(SESSION_TOKEN_SECRET_KEY);
  if (!raw) {
    return undefined;
  }
  // Unseal in memory before normalizing. Plain JWTs pass through unchanged.
  const unsealed = unsealToken(
    raw,
    defaultUnsealOptions(getCursorStateDbPath())
  );
  const normalized = normalizeSessionToken(unsealed);
  if (!normalized) {
    return undefined;
  }
  return { token: normalized, sealed: isSealed(raw) };
}

/**
 * One-time migrate leftover `cursorPlanUsage.sessionToken` settings into SecretStorage,
 * then clear the setting from Global/Workspace so it is no longer stored in plaintext.
 */
export async function migrateSessionTokenSetting(
  context: vscode.ExtensionContext
): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorPlanUsage');
  const inspect = config.inspect<string>('sessionToken');
  const candidates = [
    inspect?.workspaceFolderValue,
    inspect?.workspaceValue,
    inspect?.globalValue,
  ];
  let migrated = '';
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      migrated = normalizeSessionToken(value);
      if (migrated) {
        break;
      }
    }
  }

  if (migrated) {
    const existing = await context.secrets.get(SESSION_TOKEN_SECRET_KEY);
    if (!existing) {
      await context.secrets.store(SESSION_TOKEN_SECRET_KEY, migrated);
    }
  }

  // Clear leftover plaintext setting regardless of whether SecretStorage already had a value.
  if (
    inspect?.globalValue !== undefined ||
    inspect?.workspaceValue !== undefined ||
    inspect?.workspaceFolderValue !== undefined
  ) {
    try {
      await config.update('sessionToken', undefined, vscode.ConfigurationTarget.Global);
    } catch {
      // ignore
    }
    try {
      await config.update('sessionToken', undefined, vscode.ConfigurationTarget.Workspace);
    } catch {
      // ignore
    }
    try {
      await config.update(
        'sessionToken',
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder
      );
    } catch {
      // ignore
    }
  }
}

/**
 * Resolve a bearer access token.
 * Precedence: SecretStorage override (if set) → Cursor local state DB.
 * Token is never written to disk by this extension (SecretStorage / memory only).
 */
export async function resolveAuth(
  context: vscode.ExtensionContext,
  opts?: { force?: boolean }
): Promise<AuthResult> {
  const now = Date.now();
  const hit = cachedAuth;
  if (!opts?.force && hit && canReuseAuth(hit, now, { stale: authStale })) {
    return hit.value;
  }
  debugLog(`auth: re-read (forced=${opts?.force === true}, stale=${authStale})`);

  const secret = await readSecretToken(context.secrets);
  if (secret) {
    const value: AuthResult = {
      accessToken: secret.token,
      source: 'secret',
      expiresAt: jwtExpiresAtMs(secret.token),
      ...(secret.sealed ? { sealed: true } : {}),
    };
    return rememberUsable(value, now, SECRET_EXPIRED_MESSAGE);
  }

  try {
    const fromDb = await readFromStateDb();
    if (fromDb?.accessToken) {
      const value: AuthResult = {
        ...fromDb,
        expiresAt: jwtExpiresAtMs(fromDb.accessToken),
      };
      return rememberUsable(value, now, DB_EXPIRED_MESSAGE);
    }
  } catch (err) {
    // Decrypt and expiry errors already say what went wrong; keep them as-is.
    if (err instanceof SafeStorageError || err instanceof TokenError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new TokenError(
      'token-read',
      `Could not read Cursor session from local DB: ${msg}`
    );
  }

  throw new TokenError(
    'token-missing',
    'No Cursor access token found. Sign in to Cursor, or run “Plan Usage: Set Session Token”.'
  );
}

/** Cache the token only if it is still valid. Expired tokens never reach the API. */
function rememberUsable(value: AuthResult, now: number, expiredMessage: string): AuthResult {
  if (isExpired(value.expiresAt, now)) {
    throw new TokenError('token-expired', expiredMessage);
  }
  cachedAuth = {
    value,
    readAt: now,
    expiresAt: now + AUTH_CACHE_TTL_MS,
  };
  authStale = false;
  debugLog(
    `auth: source=${value.source}, token expires in ${
      value.expiresAt === undefined
        ? 'unknown'
        : `${Math.round((value.expiresAt - now) / 60_000)}m`
    }`
  );
  return value;
}

export async function setSessionTokenSecret(
  secrets: vscode.SecretStorage,
  raw: string
): Promise<void> {
  const normalized = normalizeSessionToken(raw);
  if (!normalized) {
    throw new Error('Session token cannot be empty.');
  }
  await secrets.store(SESSION_TOKEN_SECRET_KEY, normalized);
  clearAuthCache();
}

export async function clearSessionTokenSecret(
  secrets: vscode.SecretStorage
): Promise<void> {
  await secrets.delete(SESSION_TOKEN_SECRET_KEY);
  clearAuthCache();
}
