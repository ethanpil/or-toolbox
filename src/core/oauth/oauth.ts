/**
 * "Connect with OpenRouter": OAuth PKCE (S256) in two page loads (docs/openrouter-api.md §11).
 *
 * `start()` keeps `{verifier, state, returnTo, keyLabel}` in sessionStorage `ortoolbox:oauth` and navigates to
 * openrouter.ai/auth. The callback page calls `complete()`, which removes that entry before anything else, so a
 * reload of the callback URL can never exchange a code twice (codes are single-use anyway, and expire after
 * 10 minutes). The exchange needs no key; the returned key is stored with source `oauth`.
 */

import { url } from '../paths';
import { SS_KEYS, readJson, removeItem, session, writeJson } from '../storage/local';
import type { CoreServices, KeyInfo, OAuthService } from '../types';
import { challengeS256, createState, createVerifier } from './pkce';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
/** Pending sign-ins older than this are refused (OpenRouter's codes expire after 10 minutes). */
const PENDING_MAX_AGE_MS = 30 * 60_000;

/** A sign-in that cannot complete. `message` is safe to show. */
export class OAuthError extends Error {
  override readonly name = 'OAuthError';
}

interface PendingSignIn {
  verifier: string;
  state: string;
  returnTo: string | null;
  keyLabel: string | null;
  createdAt: number;
}

export interface OAuthServiceOptions {
  /** Top-level navigation; defaults to `location.assign`. */
  navigate?: (href: string) => void;
  now?: () => number;
}

/** The page OpenRouter sends the browser back to. */
export function callbackUrl(): string {
  return new URL(url('auth/callback/'), globalThis.location.origin).href;
}

/**
 * Accepts only paths inside this site (same origin, under the base path), so `returnTo` can never become an open
 * redirect. Returns the path or null.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return null;
  try {
    const parsed = new URL(value, globalThis.location.origin);
    if (parsed.origin !== globalThis.location.origin || !parsed.pathname.startsWith(url()))
      return null;
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return null;
  }
}

export function createOAuthService(
  core: CoreServices,
  options: OAuthServiceOptions = {},
): OAuthService {
  const now = options.now ?? (() => Date.now());
  const navigate = options.navigate ?? ((href: string) => globalThis.location.assign(href));

  return {
    async start(opts) {
      const verifier = createVerifier();
      const state = createState();
      const keyLabel = opts?.keyLabel?.trim().slice(0, 100) || null;
      const pending: PendingSignIn = {
        verifier,
        state,
        returnTo: safeReturnTo(opts?.returnTo),
        keyLabel,
        createdAt: now(),
      };
      writeJson(session(), SS_KEYS.oauth, pending);
      const params = new URLSearchParams({
        callback_url: callbackUrl(),
        code_challenge: await challengeS256(verifier),
        code_challenge_method: 'S256',
        state,
      });
      if (keyLabel) params.set('key_label', keyLabel);
      navigate(`${OPENROUTER_AUTH_URL}?${params.toString()}`);
    },

    async complete(params) {
      const pending = readJson<PendingSignIn>(session(), SS_KEYS.oauth);
      // Single use: gone before the exchange starts, whatever happens next.
      removeItem(session(), SS_KEYS.oauth);

      const denied = params.get('error');
      if (denied) throw new OAuthError('The sign-in was cancelled or refused on OpenRouter.');
      const code = params.get('code');
      if (!code) throw new OAuthError('This page has no sign-in code. Start the connection again.');
      if (!pending || typeof pending.verifier !== 'string') {
        throw new OAuthError(
          'This sign-in was already used or started in another tab. Start the connection again.',
        );
      }
      if (now() - pending.createdAt > PENDING_MAX_AGE_MS) {
        throw new OAuthError('This sign-in took too long and expired. Start the connection again.');
      }
      if (params.get('state') !== pending.state) {
        throw new OAuthError(
          'The sign-in response did not match this browser tab. Start the connection again.',
        );
      }

      const { key: secret } = await core.api.account.exchangeAuthCode({
        code,
        codeVerifier: pending.verifier,
        codeChallengeMethod: 'S256',
      });
      const key: KeyInfo = await core.keys.add({
        name: pending.keyLabel ?? 'OpenRouter',
        secret,
        source: 'oauth',
      });
      return { key, returnTo: safeReturnTo(pending.returnTo) };
    },
  };
}
