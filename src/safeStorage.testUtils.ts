import { createCipheriv, pbkdf2Sync, randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { SEALED_PREFIX } from './safeStorage';

/** Test-only: seal like Electron safeStorage does, so round trips are real. */

const CBC_IV = Buffer.alloc(16, 0x20);

/** Windows v10: `v10 | nonce(12) | ciphertext | tag(16)`, AES-256-GCM. */
export function sealWindowsV10(
  plain: string,
  key: Buffer,
  nonce: Buffer = randomBytes(12)
): string {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const blob = Buffer.concat([
    Buffer.from('v10'),
    nonce,
    body,
    cipher.getAuthTag(),
  ]);
  return SEALED_PREFIX + blob.toString('base64');
}

/**
 * macOS: AES-128-CBC, key = PBKDF2-SHA1(keychain pw, 'saltysalt', 1003, 16).
 * `encryptString()` returned the base64 text of the blob, so the stored
 * payload is base64 of that text (the double-encoded case).
 */
export function sealMacV10(plain: string, password: string): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, CBC_IV);
  const blob = Buffer.concat([
    Buffer.from('v10'),
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const encryptStringBuffer = Buffer.from(blob.toString('base64'), 'utf8');
  return SEALED_PREFIX + encryptStringBuffer.toString('base64');
}

/** Linux: AES-128-CBC with 1 PBKDF2 round. `version` picks v10 or v11. */
export function sealLinux(
  plain: string,
  version: 'v10' | 'v11',
  password: string
): string {
  const key = pbkdf2Sync(password, 'saltysalt', 1, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, CBC_IV);
  const blob = Buffer.concat([
    Buffer.from(version),
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return SEALED_PREFIX + blob.toString('base64');
}

/** Writes a Local State with a DPAPI-wrapped key and returns its path. */
export function writeLocalState(dir: string, wrappedKey: Buffer): string {
  const path = join(dir, 'Local State');
  const encryptedKey = Buffer.concat([
    Buffer.from('DPAPI'),
    wrappedKey,
  ]).toString('base64');
  writeFileSync(
    path,
    JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } })
  );
  return path;
}
