import { mkdtempSync, rmSync, statSync, truncateSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { readAuthFromStateDb } from './stateDb';

const TWO_GIB = 2 * 1024 ** 3;
const tempDirs: string[] = [];

function createStateDb(entries: Array<[string, string]>): string {
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
});
