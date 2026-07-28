import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { AuthResult } from './types';

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

/** vscode.SecretStorage key for optional session-token override. */
export const SESSION_TOKEN_SECRET_KEY = 'cursorPlanUsage.sessionToken';

let sqlPromise: Promise<SqlJsStatic> | undefined;

/** In-memory only — never written to disk by this extension. */
let cachedAuth: { value: AuthResult; expiresAt: number } | undefined;
const AUTH_CACHE_TTL_MS = 10 * 60 * 1000;

export function clearAuthCache(): void {
  cachedAuth = undefined;
}

function getSql(extensionPath: string): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    const wasmPath = path.join(extensionPath, 'out', 'sql-wasm.wasm');
    sqlPromise = initSqlJs({
      locateFile: () => wasmPath,
    });
  }
  return sqlPromise;
}

/** Resolve Cursor's globalStorage state.vscdb for the current OS. */
export function getCursorStateDbPath(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
    case 'darwin':
      return path.join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
    default:
      return path.join(
        home,
        '.config',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      );
  }
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

function readItemTable(db: Database, key: string): string | undefined {
  const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ?');
  try {
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as { value?: string };
      return typeof row.value === 'string' ? row.value : undefined;
    }
  } finally {
    stmt.free();
  }
  return undefined;
}

async function readFromStateDb(extensionPath: string): Promise<AuthResult | undefined> {
  const dbPath = getCursorStateDbPath();
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-plan-usage-${process.pid}-${Date.now()}.vscdb`
  );

  try {
    fs.copyFileSync(dbPath, tmpPath);
    const SQL = await getSql(extensionPath);
    const fileBuffer = fs.readFileSync(tmpPath);
    const db = new SQL.Database(fileBuffer);
    try {
      const accessToken = readItemTable(db, ACCESS_TOKEN_KEY);
      if (!accessToken) {
        return undefined;
      }
      return {
        accessToken,
        membershipType: readItemTable(db, MEMBERSHIP_KEY),
        email: readItemTable(db, EMAIL_KEY),
        source: 'db',
      };
    } finally {
      db.close();
    }
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore tmp cleanup failures
    }
  }
}

async function readSecretToken(
  secrets: vscode.SecretStorage
): Promise<string | undefined> {
  const raw = await secrets.get(SESSION_TOKEN_SECRET_KEY);
  if (!raw) {
    return undefined;
  }
  const normalized = normalizeSessionToken(raw);
  return normalized || undefined;
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
  if (!opts?.force && cachedAuth && cachedAuth.expiresAt > now) {
    return cachedAuth.value;
  }

  const secretToken = await readSecretToken(context.secrets);
  if (secretToken) {
    const value: AuthResult = { accessToken: secretToken, source: 'secret' };
    cachedAuth = { value, expiresAt: now + AUTH_CACHE_TTL_MS };
    return value;
  }

  try {
    const fromDb = await readFromStateDb(context.extensionPath);
    if (fromDb?.accessToken) {
      cachedAuth = { value: fromDb, expiresAt: now + AUTH_CACHE_TTL_MS };
      return fromDb;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read Cursor session from local DB: ${msg}`);
  }

  throw new Error(
    'No Cursor access token found. Sign in to Cursor, or run “Plan Usage: Set Session Token”.'
  );
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
