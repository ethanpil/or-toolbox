/** PKCE helpers (RFC 7636, S256), as OpenRouter's OAuth flow uses them (docs/openrouter-api.md §11). */

import { randomBytes, toBase64 } from '../crypto';

export function base64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 43-character verifier from 32 random bytes (within RFC 7636's 43-128 range). */
export function createVerifier(): string {
  return base64Url(randomBytes(32));
}

/** S256 challenge: base64url (no padding) of SHA-256 of the verifier. */
export async function challengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** Random `state` for CSRF protection. */
export function createState(): string {
  return base64Url(randomBytes(16));
}
