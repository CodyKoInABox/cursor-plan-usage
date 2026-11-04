import { randomBytes } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dpapiFailureMessage,
  localStatePathFor,
  resetSafeStorageCache,
  SafeStorageError,
  type UnsealOptions,
  unsealToken,
} from './safeStorage';
import {
  sealLinux,
  sealMacV10,
  sealWindowsV10,
  writeLocalState,
} from './safeStorage.testUtils';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyXzAxIn0.c2lnbmF0dXJl';
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-plan-usage-ss-'));
  tempDirs.push(dir);
  return dir;
}

function windowsOpts(
  key: Buffer,
  unprotect = vi.fn((_blob: Buffer) => key)
): UnsealOptions {
  const localStatePath = writeLocalState(tempDir(), Buffer.from('wrapped-by-dpapi'));
  return {
    platform: 'win32',
    localStatePath,
    providers: { dpapiUnprotect: unprotect },
  };
}

beforeEach(() => {
  resetSafeStorageCache();
});

afterEach(() => {
  resetSafeStorageCache();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('unsealToken: plain values', () => {
  it('passes a raw JWT through untouched without touching any OS hook', () => {
    const boom = () => {
      throw new Error('must not be called');
    };
    const opts: UnsealOptions = {
      platform: 'win32',
      localStatePath: '/does/not/exist',
      providers: {
        dpapiUnprotect: boom,
        keychainPassword: boom,
        secretServicePassword: boom,
      },
    };

    expect(unsealToken(JWT, opts)).toBe(JWT);
  });

  it('derives Local State from the original state.vscdb path', () => {
    const db = join('C:', 'x', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    expect(localStatePathFor(db)).toBe(join('C:', 'x', 'Cursor', 'Local State'));
  });
});

describe('dpapiFailureMessage', () => {
  const base = { status: 0, signal: null as NodeJS.Signals | null };

  it('says PowerShell could not start, with the policy workaround', () => {
    const msg = dpapiFailureMessage({
      ...base,
      error: Object.assign(new Error('spawn powershell.exe EPERM'), { code: 'EPERM' }),
      status: null,
    });
    expect(msg).toMatch(/could not start \(EPERM\)/);
    expect(msg).toMatch(/Set Session Token/);
  });

  it('distinguishes a timeout', () => {
    const msg = dpapiFailureMessage({
      ...base,
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      status: null,
    });
    expect(msg).toMatch(/timed out/);
  });

  it('reports a kill by signal', () => {
    expect(dpapiFailureMessage({ ...base, status: null, signal: 'SIGKILL' })).toMatch(
      /killed \(SIGKILL\)/
    );
  });

  it('includes only the first line of PowerShell stderr on a non-zero exit', () => {
    const msg = dpapiFailureMessage({
      ...base,
      status: 1,
      stderr: 'This program is blocked by group policy.\r\nat line 1',
    });
    expect(msg).toMatch(/exited with code 1\. PowerShell said: This program is blocked by group policy\./);
    expect(msg).not.toMatch(/at line 1/);
  });
});

describe('unsealToken: Windows (v10, AES-256-GCM, DPAPI key)', () => {
  it('round-trips with an injected DPAPI key', () => {
    const key = randomBytes(32);
    const opts = windowsOpts(key);

    expect(unsealToken(sealWindowsV10(JWT, key), opts)).toBe(JWT);
  });

  it('unwraps the DPAPI blob by stripping the "DPAPI" prefix', () => {
    const key = randomBytes(32);
    const unprotect = vi.fn((_blob: Buffer) => key);
    const opts = windowsOpts(key, unprotect);

    unsealToken(sealWindowsV10(JWT, key), opts);

    expect(unprotect).toHaveBeenCalledOnce();
    expect(unprotect.mock.calls[0][0].toString()).toBe('wrapped-by-dpapi');
  });

  it('caches the 32-byte key for the process', () => {
    const key = randomBytes(32);
    const unprotect = vi.fn((_blob: Buffer) => key);
    const opts = windowsOpts(key, unprotect);

    unsealToken(sealWindowsV10(JWT, key), opts);
    unsealToken(sealWindowsV10('second.jwt.value', key), opts);

    expect(unprotect).toHaveBeenCalledOnce();
  });

  it('throws a decrypt error (not a silent pass-through) with the wrong key', () => {
    const right = randomBytes(32);
    const wrong = randomBytes(32);
    const opts = windowsOpts(right);

    expect(() => unsealToken(sealWindowsV10(JWT, wrong), opts)).toThrow(
      /decrypt failed/
    );
    expect(() => unsealToken(sealWindowsV10(JWT, wrong), opts)).toThrow(
      SafeStorageError
    );
  });

  it('treats a bad GCM tag as a decrypt error', () => {
    const key = randomBytes(32);
    const opts = windowsOpts(key);
    const sealed = sealWindowsV10(JWT, key);
    const blob = Buffer.from(sealed.slice('cursor-safe-storage:v1:'.length), 'base64');
    blob[blob.length - 1] ^= 0x01;
    const tampered = `cursor-safe-storage:v1:${blob.toString('base64')}`;

    expect(() => unsealToken(tampered, opts)).toThrow(/GCM auth tag mismatch/);
  });

  it('rejects app-bound v20 without calling DPAPI', () => {
    const key = randomBytes(32);
    const unprotect = vi.fn((_blob: Buffer) => key);
    const opts = windowsOpts(key, unprotect);
    const v20 = `cursor-safe-storage:v1:${Buffer.concat([
      Buffer.from('v20'),
      randomBytes(60),
    ]).toString('base64')}`;

    expect(() => unsealToken(v20, opts)).toThrow(/v20/);
    expect(unprotect).not.toHaveBeenCalled();
  });

  it('rejects a DPAPI key that is not 32 bytes', () => {
    const opts = windowsOpts(randomBytes(32), vi.fn(() => randomBytes(16)));

    expect(() =>
      unsealToken(sealWindowsV10(JWT, randomBytes(32)), opts)
    ).toThrow(/not 32 bytes/);
  });
});

describe('unsealToken: macOS (v10, AES-128-CBC, keychain password, 1003 rounds)', () => {
  const PASSWORD = 'keychain-pw-for-tests';

  it('round-trips the double-base64 buffer shape with an injected keychain password', () => {
    const keychain = vi.fn(() => PASSWORD);
    const opts: UnsealOptions = {
      platform: 'darwin',
      localStatePath: '/unused',
      providers: { keychainPassword: keychain },
    };

    expect(unsealToken(sealMacV10(JWT, PASSWORD), opts)).toBe(JWT);
  });

  it('caches the keychain password so it is read once per process', () => {
    const keychain = vi.fn(() => PASSWORD);
    const opts: UnsealOptions = {
      platform: 'darwin',
      localStatePath: '/unused',
      providers: { keychainPassword: keychain },
    };

    unsealToken(sealMacV10(JWT, PASSWORD), opts);
    unsealToken(sealMacV10('second.jwt.value', PASSWORD), opts);

    expect(keychain).toHaveBeenCalledOnce();
  });

  it('fails with a decrypt error on the wrong keychain password', () => {
    const opts: UnsealOptions = {
      platform: 'darwin',
      localStatePath: '/unused',
      providers: { keychainPassword: () => 'some-other-password' },
    };

    expect(() => unsealToken(sealMacV10(JWT, PASSWORD), opts)).toThrow(
      /decrypt failed/
    );
  });
});

describe('unsealToken: Linux (AES-128-CBC, 1 PBKDF2 round)', () => {
  it('decrypts v11 with the Secret Service password', () => {
    const opts: UnsealOptions = {
      platform: 'linux',
      localStatePath: '/unused',
      providers: { secretServicePassword: () => 'linux-keyring-pw' },
    };

    expect(unsealToken(sealLinux(JWT, 'v11', 'linux-keyring-pw'), opts)).toBe(JWT);
  });

  it('decrypts v10 with the built-in "peanuts" password and never reads the keyring', () => {
    const keyring = vi.fn(() => 'unused');
    const opts: UnsealOptions = {
      platform: 'linux',
      localStatePath: '/unused',
      providers: { secretServicePassword: keyring },
    };

    expect(unsealToken(sealLinux(JWT, 'v10', 'peanuts'), opts)).toBe(JWT);
    expect(keyring).not.toHaveBeenCalled();
  });

  it('falls back to "peanuts" for v11 when the keyring has no entry', () => {
    const opts: UnsealOptions = {
      platform: 'linux',
      localStatePath: '/unused',
      providers: { secretServicePassword: () => undefined },
    };

    expect(unsealToken(sealLinux(JWT, 'v11', 'peanuts'), opts)).toBe(JWT);
  });

  it('fails with a decrypt error on the wrong keyring password', () => {
    const opts: UnsealOptions = {
      platform: 'linux',
      localStatePath: '/unused',
      providers: { secretServicePassword: () => 'wrong' },
    };

    expect(() =>
      unsealToken(sealLinux(JWT, 'v11', 'right'), opts)
    ).toThrow(/decrypt failed/);
  });
});
