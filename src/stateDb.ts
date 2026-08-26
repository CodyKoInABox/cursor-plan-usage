import { Database } from 'node-sqlite3-wasm';
import type { AuthResult } from './types';

const ACCESS_TOKEN_KEY = 'cursorAuth/accessToken';
const MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType';
const EMAIL_KEY = 'cursorAuth/cachedEmail';

function readTextItem(db: Database, key: string): string | undefined {
  const row = db.get('SELECT value FROM ItemTable WHERE key = ?', key);
  if (!row || !('value' in row) || typeof row.value !== 'string') {
    return undefined;
  }
  return row.value;
}

/**
 * Open Cursor's state database in place and query only the pages needed for
 * authentication. The filesystem-backed WASM VFS avoids loading the entire
 * database into memory, which also supports state files larger than 2 GiB.
 */
export function readAuthFromStateDb(dbPath: string): AuthResult | undefined {
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
