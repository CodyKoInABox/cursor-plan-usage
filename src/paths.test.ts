import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { cursorStateDbPathFor } from './paths';
import { defaultUnsealOptions, KEYCHAIN_LOOKUP_ARGS, SECRET_TOOL_LOOKUPS } from './safeStorage';

const TAIL = path.join('Cursor', 'User', 'globalStorage', 'state.vscdb');

describe('cursorStateDbPathFor', () => {
  it('windows: under APPDATA when set', () => {
    const p = cursorStateDbPathFor('win32', 'C:\\Users\\a', 'C:\\Users\\a\\AppData\\Roaming');
    expect(p.startsWith(path.join('C:\\Users\\a\\AppData\\Roaming'))).toBe(true);
    expect(p.endsWith(TAIL)).toBe(true);
  });

  it('windows: falls back to home/AppData/Roaming without APPDATA', () => {
    const p = cursorStateDbPathFor('win32', 'C:\\Users\\a');
    expect(p).toBe(path.join('C:\\Users\\a', 'AppData', 'Roaming', TAIL));
  });

  it('macOS: under home/Library/Application Support', () => {
    const p = cursorStateDbPathFor('darwin', '/Users/a');
    expect(p).toBe(path.join('/Users/a', 'Library', 'Application Support', TAIL));
  });

  it('linux: under home/.config', () => {
    const p = cursorStateDbPathFor('linux', '/home/a');
    expect(p).toBe(path.join('/home/a', '.config', TAIL));
  });

  it('ignores APPDATA on macOS and Linux', () => {
    expect(cursorStateDbPathFor('darwin', '/Users/a', 'X:\\nope')).toBe(
      cursorStateDbPathFor('darwin', '/Users/a')
    );
    expect(cursorStateDbPathFor('linux', '/home/a', 'X:\\nope')).toBe(
      cursorStateDbPathFor('linux', '/home/a')
    );
  });
});

describe('defaultUnsealOptions platform', () => {
  it('uses the given platform instead of the host', () => {
    expect(defaultUnsealOptions('/x/Cursor/User/globalStorage/state.vscdb', 'darwin').platform).toBe('darwin');
    expect(defaultUnsealOptions('/x/Cursor/User/globalStorage/state.vscdb', 'linux').platform).toBe('linux');
  });
});

describe('OS lookup arguments', () => {
  it('macOS keychain lookup targets the Cursor Safe Storage item', () => {
    expect([...KEYCHAIN_LOOKUP_ARGS]).toEqual([
      'find-generic-password',
      '-s',
      'Cursor Safe Storage',
      '-w',
    ]);
  });

  it('Linux secret-tool lookups try the Electron attributes first, then Cursor Safe Storage', () => {
    expect(SECRET_TOOL_LOOKUPS.length).toBeGreaterThan(0);
    expect(SECRET_TOOL_LOOKUPS[0]).toContain('chrome_libsecret_os_crypt_password_v2');
    expect(SECRET_TOOL_LOOKUPS.some((a) => a.includes('Cursor Safe Storage'))).toBe(true);
  });
});
