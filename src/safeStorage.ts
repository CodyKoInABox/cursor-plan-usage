import { spawnSync } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Cursor seals some ItemTable secrets (cursorAuth/accessToken) with Electron
 * safeStorage when cursor.storage.authTokenEncryptionAtRest is on:
 *   `cursor-safe-storage:v1:` + base64(encryptString(value))
 * Plain values (raw JWTs) pass through untouched.
 *
 * Everything here runs in memory. Callers must never persist the result.
 */
export const SEALED_PREFIX = 'cursor-safe-storage:v1:';

const APP_BOUND_MESSAGE =
  'Cursor token uses app-bound encryption (v20), which this extension cannot decrypt. Re-sign into Cursor, or run Plan Usage: Set Session Token with a JWT.';

export class SafeStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafeStorageError';
  }
}

/** OS hooks. Defaults shell out to DPAPI / security / secret-tool. */
export interface SafeStorageProviders {
  /** Windows: CryptUnprotectData, CurrentUser scope. */
  dpapiUnprotect(blob: Buffer): Buffer;
  /** macOS: password of the "Cursor Safe Storage" keychain item. */
  keychainPassword(): string | undefined;
  /** Linux: Secret Service password used for v11 blobs. */
  secretServicePassword(): string | undefined;
}

export interface UnsealOptions {
  platform: NodeJS.Platform;
  /** Windows only: Cursor's `Local State` (holds `os_crypt.encrypted_key`). */
  localStatePath: string;
  /** Test seam. Omit to use the real OS calls. */
  providers?: Partial<SafeStorageProviders>;
}

/** `…/Cursor/User/globalStorage/state.vscdb` → `…/Cursor/Local State`. */
export function localStatePathFor(stateDbPath: string): string {
  return join(dirname(stateDbPath), '..', '..', 'Local State');
}

export function defaultUnsealOptions(stateDbPath: string): UnsealOptions {
  return {
    platform: process.platform,
    localStatePath: localStatePathFor(stateDbPath),
  };
}

export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX);
}

/** Per-process cache. The DPAPI key and keychain/keyring passwords are read once. */
interface KeyCache {
  dpapiKey?: Buffer;
  keychainPassword?: string;
  secretServicePassword?: string;
}
let cache: KeyCache = {};

export function resetSafeStorageCache(): void {
  cache = {};
}

/**
 * Decrypt a Cursor safeStorage value. Returns plain values unchanged.
 * Throws SafeStorageError on unsupported versions or failed decryption.
 */
export function unsealToken(value: string, opts: UnsealOptions): string {
  if (!isSealed(value)) {
    return value;
  }
  const blob = decodeSealedPayload(value.slice(SEALED_PREFIX.length));
  const version = blob.subarray(0, 3).toString('latin1');
  if (version === 'v20') {
    throw new SafeStorageError(APP_BOUND_MESSAGE);
  }
  return toToken(decryptBlob(blob, version, opts));
}

/**
 * Base64-decode the payload. On macOS, encryptString() often returns a Buffer
 * that already holds base64 text, so decode a second time when needed.
 */
function decodeSealedPayload(payload: string): Buffer {
  const once = Buffer.from(payload, 'base64');
  if (hasVersionPrefix(once)) {
    return once;
  }
  const twice = Buffer.from(once.toString('latin1'), 'base64');
  return hasVersionPrefix(twice) ? twice : once;
}

function hasVersionPrefix(buf: Buffer): boolean {
  const tag = buf.subarray(0, 3).toString('latin1');
  return tag === 'v10' || tag === 'v11' || tag === 'v20';
}

function decryptBlob(blob: Buffer, version: string, opts: UnsealOptions): Buffer {
  switch (opts.platform) {
    case 'win32':
      expectVersion(version, 'v10', opts.platform);
      return decryptGcm(blob, windowsKey(opts));
    case 'darwin':
      expectVersion(version, 'v10', opts.platform);
      return decryptCbc(blob, deriveKey(macKeychainPassword(opts), 1003));
    case 'linux':
      if (version === 'v10') {
        return decryptCbc(blob, deriveKey('peanuts', 1));
      }
      expectVersion(version, 'v11', opts.platform);
      return decryptCbc(blob, deriveKey(linuxSecretPassword(opts), 1));
    default:
      throw new SafeStorageError(
        `Cursor token decryption is not supported on ${opts.platform}`
      );
  }
}

function expectVersion(version: string, expected: string, platform: string): void {
  if (version !== expected) {
    throw new SafeStorageError(
      `Unsupported safeStorage blob version "${version}" on ${platform}`
    );
  }
}

/** Windows: v10 | nonce (12) | ciphertext | tag (16), AES-256-GCM. */
function decryptGcm(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 3 + 12 + 16) {
    throw new SafeStorageError('decrypt failed: ciphertext too short');
  }
  const nonce = blob.subarray(3, 15);
  const body = blob.subarray(15, blob.length - 16);
  const tag = blob.subarray(blob.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SafeStorageError(
      'decrypt failed: GCM auth tag mismatch (wrong key or corrupted token)'
    );
  }
}

const CBC_IV = Buffer.alloc(16, 0x20);

/** macOS / Linux: v10|v11 | AES-128-CBC, IV = 16 × 0x20. */
function decryptCbc(blob: Buffer, key: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, CBC_IV);
    return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    throw new SafeStorageError('decrypt failed: bad key or padding');
  }
}

function deriveKey(password: string, rounds: number): Buffer {
  return pbkdf2Sync(password, 'saltysalt', rounds, 16, 'sha1');
}

/**
 * CBC has no integrity check, so a wrong key can still yield valid padding
 * (about 1 in 256). A real token is printable ASCII with no spaces, so anything
 * else is a wrong key.
 */
function toToken(plaintext: Buffer): string {
  const text = plaintext.toString('utf8');
  if (!/^[\x21-\x7e]+$/.test(text)) {
    throw new SafeStorageError('decrypt failed: result is not a token (wrong key?)');
  }
  return text;
}

function windowsKey(opts: UnsealOptions): Buffer {
  if (cache.dpapiKey) {
    return cache.dpapiKey;
  }
  let localState: { os_crypt?: { encrypted_key?: unknown } };
  try {
    localState = JSON.parse(readFileSync(opts.localStatePath, 'utf8'));
  } catch {
    throw new SafeStorageError(
      `Could not read Cursor Local State at ${opts.localStatePath}`
    );
  }
  const encrypted = localState.os_crypt?.encrypted_key;
  if (typeof encrypted !== 'string') {
    throw new SafeStorageError('Cursor Local State has no os_crypt.encrypted_key');
  }
  const wrapped = Buffer.from(encrypted, 'base64');
  if (wrapped.subarray(0, 5).toString('latin1') !== 'DPAPI') {
    throw new SafeStorageError('os_crypt.encrypted_key is missing the DPAPI prefix');
  }
  const unprotect = opts.providers?.dpapiUnprotect ?? dpapiUnprotect;
  const key = unprotect(wrapped.subarray(5));
  if (key.length !== 32) {
    throw new SafeStorageError('DPAPI returned a key that is not 32 bytes');
  }
  cache.dpapiKey = key;
  return key;
}

const DPAPI_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$b = [Convert]::FromBase64String($env:CPU_DPAPI_BLOB)',
  '$k = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($k))',
].join('; ');

/**
 * Explain a failed DPAPI call. Covers PowerShell that never started (for
 * example AppLocker or WDAC), a timeout, a kill, and a non-zero exit.
 * stderr is PowerShell's own message, never the blob or the key.
 */
export function dpapiFailureMessage(result: {
  error?: NodeJS.ErrnoException;
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr?: string;
}): string {
  const workaround =
    'If PowerShell is blocked on this machine (AppLocker or WDAC), use Plan Usage: Set Session Token instead.';
  if (result.error) {
    const reason =
      result.error.code === 'ETIMEDOUT'
        ? 'timed out'
        : `could not start (${result.error.code ?? 'unknown error'})`;
    return `DPAPI unprotect failed: PowerShell ${reason}. ${workaround}`;
  }
  if (result.signal) {
    return `DPAPI unprotect failed: PowerShell was killed (${result.signal}). ${workaround}`;
  }
  const firstLine = (result.stderr ?? '').trim().split(/\r?\n/)[0]?.slice(0, 200);
  const detail = firstLine ? ` PowerShell said: ${firstLine}.` : '';
  return `DPAPI unprotect failed: PowerShell exited with code ${result.status}.${detail} ${workaround}`;
}

/** Blob goes through the environment, not argv. The script is -EncodedCommand. */
function dpapiUnprotect(blob: Buffer): Buffer {
  const res = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64'),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, CPU_DPAPI_BLOB: blob.toString('base64') },
    }
  );
  if (res.error || res.status !== 0 || res.signal) {
    throw new SafeStorageError(dpapiFailureMessage(res));
  }
  return Buffer.from(res.stdout.trim(), 'base64');
}

function macKeychainPassword(opts: UnsealOptions): string {
  if (cache.keychainPassword === undefined) {
    const read = opts.providers?.keychainPassword ?? readKeychainPassword;
    const password = read();
    if (!password) {
      throw new SafeStorageError(
        'Could not read "Cursor Safe Storage" from the macOS keychain'
      );
    }
    cache.keychainPassword = password;
  }
  return cache.keychainPassword;
}

function readKeychainPassword(): string | undefined {
  const res = spawnSync(
    'security',
    ['find-generic-password', '-s', 'Cursor Safe Storage', '-w'],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 }
  );
  if (res.error || res.status !== 0) {
    return undefined;
  }
  return res.stdout.replace(/\r?\n$/, '') || undefined;
}

/** Electron/Chromium libsecret entries, in lookup order. */
const SECRET_TOOL_LOOKUPS: string[][] = [
  ['xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', 'cursor'],
  ['service', 'Cursor Safe Storage', 'account', 'Cursor'],
  ['service', 'Cursor Safe Storage', 'account', 'cursor'],
];

function linuxSecretPassword(opts: UnsealOptions): string {
  if (cache.secretServicePassword === undefined) {
    const read = opts.providers?.secretServicePassword ?? readSecretServicePassword;
    // No keyring entry: Chromium's basic backend falls back to "peanuts".
    cache.secretServicePassword = read() ?? 'peanuts';
  }
  return cache.secretServicePassword;
}

function readSecretServicePassword(): string | undefined {
  for (const attrs of SECRET_TOOL_LOOKUPS) {
    const res = spawnSync('secret-tool', ['lookup', ...attrs], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (!res.error && res.status === 0 && res.stdout.length > 0) {
      return res.stdout.replace(/\r?\n$/, '');
    }
  }
  return undefined;
}
