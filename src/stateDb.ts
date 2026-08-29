import {
  closeSync,
  constants,
  copyFileSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'node-sqlite3-wasm';
import type { AuthResult } from './types';

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

/** SQLite header: write/read format version. 2 = WAL. */
const WAL_FORMAT_VERSION = 2;
const ROLLBACK_FORMAT_VERSION = 1;

function sqliteText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder('utf-8').decode(value);
  }
  return undefined;
}

function readTextItem(db: Database, key: string): string | undefined {
  const row = db.get('SELECT value FROM ItemTable WHERE key = ?', key);
  if (!row || !('value' in row)) {
    return undefined;
  }
  return sqliteText(row.value);
}

function queryAuth(dbPath: string): AuthResult | undefined {
  const db = new Database(dbPath, { readOnly: true });
  try {
    const accessToken = readTextItem(db, ACCESS_TOKEN_KEY);
    if (!accessToken) {
      return undefined;
    }
    return {
      accessToken,
      membershipType: readTextItem(db, MEMBERSHIP_KEY),
      email: readTextItem(db, EMAIL_KEY),
      source: 'db',
    };
  } finally {
    db.close();
  }
}

function isOpenFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unable to open database file|Could not open the database|SQLITE_CANTOPEN|database is locked|SQLITE_BUSY/i.test(
    msg
  );
}

/** True when the SQLite header says WAL. Never writes the source file. */
function fileUsesWal(dbPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(dbPath, 'r');
    const header = Buffer.alloc(20);
    const n = readSync(fd, header, 0, 20, 0);
    if (n < 20) {
      return false;
    }
    return header[18] === WAL_FORMAT_VERSION || header[19] === WAL_FORMAT_VERSION;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * WASM SQLite is built without WAL/shared-memory, so a WAL-mode file cannot be
 * opened at all. Rewrite the format-version bytes on a copy only.
 */
function disableWalHeader(dbPath: string): void {
  const fd = openSync(dbPath, 'r+');
  try {
    const header = Buffer.alloc(20);
    const n = readSync(fd, header, 0, 20, 0);
    if (n < 20) {
      return;
    }
    if (
      header[18] !== WAL_FORMAT_VERSION &&
      header[19] !== WAL_FORMAT_VERSION
    ) {
      return;
    }
    header[18] = ROLLBACK_FORMAT_VERSION;
    header[19] = ROLLBACK_FORMAT_VERSION;
    writeSync(fd, header, 18, 2, 18);
  } finally {
    closeSync(fd);
  }
}

function queryAuthFromCopy(dbPath: string): AuthResult | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-plan-usage-'));
  const tmpPath = join(dir, 'state.vscdb');
  try {
    copyFileSync(dbPath, tmpPath, constants.COPYFILE_FICLONE);
    disableWalHeader(tmpPath);
    return queryAuth(tmpPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Read Cursor auth keys from `state.vscdb`.
 *
 * Opens the file in place when possible (avoids copying multi-GiB state DBs).
 * Cursor keeps this file in WAL mode, and node-sqlite3-wasm cannot open WAL
 * databases (`unable to open database file`). In that case, and on lock
 * errors, copy to a temp file, strip the WAL flag on the copy, then query.
 * The live Cursor database is never modified.
 */
export function readAuthFromStateDb(dbPath: string): AuthResult | undefined {
  if (!fileUsesWal(dbPath)) {
    try {
      return queryAuth(dbPath);
    } catch (err) {
      if (!isOpenFailure(err)) {
        throw err;
      }
    }
  }
  return queryAuthFromCopy(dbPath);
}
