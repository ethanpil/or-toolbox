/**
 * Passphrase encryption with WebCrypto: PBKDF2-SHA-256 → AES-GCM-256. Used by the key lock and by backups
 * that include keys. A wrong passphrase surfaces as a rejected decrypt (AES-GCM authentication failure).
 */

import type { EncryptedBlob } from './types';

/** OWASP's current guidance for PBKDF2-HMAC-SHA256. Stored alongside each payload so it can change later. */
export const PBKDF2_ITERATIONS = 600_000;

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive an AES-GCM key from a passphrase. `extractable` is needed only when the raw key must be kept in
 * sessionStorage for the rest of the tab session (the key lock).
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations = PBKDF2_ITERATIONS,
  extractable = false,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  );
}

export async function exportRawKey(key: CryptoKey): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

export async function importRawKey(base64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64(base64), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function encryptString(key: CryptoKey, plain: string): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plain),
  );
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Rejects (OperationError) when the key is wrong or the data was tampered with. */
export async function decryptString(key: CryptoKey, blob: EncryptedBlob): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(blob.iv) },
    key,
    fromBase64(blob.ct),
  );
  return new TextDecoder().decode(plain);
}

/** Self-contained passphrase envelope (used by backups). */
export interface PassphraseEnvelope extends EncryptedBlob {
  salt: string;
  iterations: number;
}

export async function encryptWithPassphrase(
  passphrase: string,
  plain: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<PassphraseEnvelope> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, iterations);
  return { salt: toBase64(salt), iterations, ...(await encryptString(key, plain)) };
}

export async function decryptWithPassphrase(
  passphrase: string,
  envelope: PassphraseEnvelope,
): Promise<string> {
  const key = await deriveKey(passphrase, fromBase64(envelope.salt), envelope.iterations);
  return decryptString(key, envelope);
}
