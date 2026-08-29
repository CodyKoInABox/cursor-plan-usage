import { spawnSync } from 'child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { readAuthFromStateDb } from './stateDb';

const TWO_GIB = 2 * 1024 ** 3;
const tempDirs: string[] = [];
const hasNativeSqlite3 =
  spawnSync('sqlite3', ['-version'], { encoding: 'utf8' }).status === 0;

function createStateDb(
  entries: Array<[string, string | Uint8Array]>
): string {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-plan-usage-'));
  tempDirs.push(dir);
  const dbPath = join(dir, 'state.vscdb');
  const db = new Database(dbPath);
  try {
    db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)');
    for (const [key, value] of entries) {
      db.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [key, value]);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/** Stamp WAL format-version bytes. WASM SQLite cannot open this file in place. */
function stampWalHeader(dbPath: string): void {
  const fd = openSync(dbPath, 'r+');
  try {
    writeSync(fd, Buffer.from([2, 2]), 0, 2, 18);
  } finally {
    closeSync(fd);
  }
}

function readHeaderVersions(dbPath: string): [number, number] {
  const fd = openSync(dbPath, 'r');
  try {
    const header = Buffer.alloc(20);
    readSync(fd, header, 0, 20, 0);
    return [header[18], header[19]];
  } finally {
    closeSync(fd);
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readAuthFromStateDb', () => {
  it('reads authentication values from ItemTable', () => {
    const dbPath = createStateDb([
      ['cursorAuth/accessToken', 'access-token'],
      ['cursorAuth/stripeMembershipType', 'pro'],
      ['cursorAuth/cachedEmail', 'user@example.com'],
    ]);

    expect(readAuthFromStateDb(dbPath)).toEqual({
      accessToken: 'access-token',
      membershipType: 'pro',
      email: 'user@example.com',
      source: 'db',
    });
  });

  it('returns undefined when the access token is absent', () => {
    const dbPath = createStateDb([
      ['cursorAuth/stripeMembershipType', 'pro'],
    ]);

    expect(readAuthFromStateDb(dbPath)).toBeUndefined();
  });

  it('reads a state database larger than 2 GiB without buffering the file', () => {
    const dbPath = createStateDb([
      ['cursorAuth/accessToken', 'large-db-token'],
    ]);
    truncateSync(dbPath, TWO_GIB + 4096);

    expect(statSync(dbPath).size).toBeGreaterThan(TWO_GIB);
    expect(readAuthFromStateDb(dbPath)?.accessToken).toBe('large-db-token');
  });

  it('reads a WAL-mode database that WASM SQLite cannot open in place', () => {
    const dbPath = createStateDb([
      ['cursorAuth/accessToken', 'wal-token'],
      ['cursorAuth/stripeMembershipType', 'pro'],
      ['cursorAuth/cachedEmail', 'user@example.com'],
    ]);
    stampWalHeader(dbPath);

    expect(() => {
      const db = new Database(dbPath, { readOnly: true });
      try {
        db.get('SELECT value FROM ItemTable WHERE key = ?', 'cursorAuth/accessToken');
      } finally {
        db.close();
      }
    }).toThrow(/unable to open database file/);

    expect(readAuthFromStateDb(dbPath)).toEqual({
      accessToken: 'wal-token',
      membershipType: 'pro',
      email: 'user@example.com',
      source: 'db',
    });
    expect(readHeaderVersions(dbPath)).toEqual([2, 2]);
  });

  it('decodes ItemTable BLOB values as UTF-8', () => {
    const dbPath = createStateDb([
      ['cursorAuth/accessToken', Buffer.from('blob-token', 'utf8')],
      ['cursorAuth/stripeMembershipType', Buffer.from('pro', 'utf8')],
      ['cursorAuth/cachedEmail', Buffer.from('user@example.com', 'utf8')],
    ]);

    expect(readAuthFromStateDb(dbPath)).toEqual({
      accessToken: 'blob-token',
      membershipType: 'pro',
      email: 'user@example.com',
      source: 'db',
    });
  });

  it.skipIf(!hasNativeSqlite3)(
    'reads a native sqlite3 WAL database including sidecar files',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cursor-plan-usage-'));
      tempDirs.push(dir);
      const dbPath = join(dir, 'state.vscdb');
      const sql = [
        'PRAGMA journal_mode=WAL;',
        'CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);',
        "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/accessToken', 'native-wal-token');",
        "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/stripeMembershipType', 'pro');",
        "INSERT INTO ItemTable (key, value) VALUES ('cursorAuth/cachedEmail', 'user@example.com');",
      ].join('\n');
      const created = spawnSync('sqlite3', [dbPath], {
        input: sql,
        encoding: 'utf8',
      });
      expect(created.status).toBe(0);
      expect(readHeaderVersions(dbPath)).toEqual([2, 2]);

      expect(readAuthFromStateDb(dbPath)).toEqual({
        accessToken: 'native-wal-token',
        membershipType: 'pro',
        email: 'user@example.com',
        source: 'db',
      });
      expect(readHeaderVersions(dbPath)).toEqual([2, 2]);
    }
  );
});
