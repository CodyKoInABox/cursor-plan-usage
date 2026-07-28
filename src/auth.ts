import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import type { AuthResult } from './types';

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

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

/**
 * Resolve a bearer access token.
 * Prefer Cursor's local state DB; fall back to `cursorPlanUsage.sessionToken`.
 * Token is never persisted by this extension (memory cache only).
 */
export async function resolveAuth(
  extensionPath: string,
  opts?: { force?: boolean }
): Promise<AuthResult> {
  const now = Date.now();
  if (!opts?.force && cachedAuth && cachedAuth.expiresAt > now) {
    return cachedAuth.value;
  }

  const config = vscode.workspace.getConfiguration('cursorPlanUsage');
  const override = normalizeSessionToken(config.get<string>('sessionToken', ''));

  try {
    const fromDb = await readFromStateDb(extensionPath);
    if (fromDb?.accessToken) {
      cachedAuth = { value: fromDb, expiresAt: now + AUTH_CACHE_TTL_MS };
      return fromDb;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!override) {
      throw new Error(`Could not read Cursor session from local DB: ${msg}`);
    }
  }

  if (override) {
    const value: AuthResult = { accessToken: override, source: 'setting' };
    cachedAuth = { value, expiresAt: now + AUTH_CACHE_TTL_MS };
    return value;
  }

  throw new Error(
    'No Cursor access token found. Sign in to Cursor, or set cursorPlanUsage.sessionToken (WorkosCursorSessionToken / JWT).'
  );
}
