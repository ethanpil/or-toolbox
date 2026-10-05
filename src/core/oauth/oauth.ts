/**
 * "Connect with OpenRouter": OAuth PKCE (S256) in two page loads (docs/openrouter-api.md §11).
 *
 * `start()` keeps `{verifier, state, returnTo, keyLabel}` in sessionStorage `ortoolbox:oauth` and navigates to
 * openrouter.ai/auth. The callback page calls `complete()`, which removes that entry before the exchange, so a
 * reload of the callback URL can never exchange a code twice (codes are single-use anyway, and expire after
 * 10 minutes). The exchange needs no key; the returned key is stored with source `oauth`.
 *
 * Both refuse with KeyLockedError while the passphrase lock is on and this tab is locked: the new key could not
 * be stored (it must be encrypted), and a consumed code cannot be exchanged again. `complete()` checks before it
 * touches anything, so after unlocking the caller retries with the same params.
 *
 * Once the code is exchanged, the key exists on OpenRouter and the code is spent. If storing it still fails (the
 * tab auto-locked during the exchange, storage is full, keys changed in another tab), `complete()` throws
 * KeyNotSavedError, which holds the key in memory: its `save()` tries again (after unlocking, for example).
 * Leaving the page loses it; the key then stays on the OpenRouter account.
 */

import { KeyLockedError, OAuthError, userMessage } from '../errors';
import { maskKey } from '../keys/format';
import { url } from '../paths';
import { SS_KEYS, readJson, removeItem, session, writeJson } from '../storage/local';
import type { CoreServices, KeyInfo, OAuthService } from '../types';
import { isFiniteNumber, isRecord, isString } from '../util';
import { challengeS256, createState, createVerifier } from './pkce';

// Historical import path (the class lives in errors.ts).
export { OAuthError } from '../errors';

type Completed = Awaited<ReturnType<OAuthService['complete']>>;

/**
 * The key was made on OpenRouter but could not be stored here. Only this error holds it: `save()` stores it
 * (rejecting with the reason when it still cannot); nothing is exchanged again.
 */
export class KeyNotSavedError extends OAuthError {
  /** Why storing failed (KeyLockedError, StorageFullError, KeysChangedError…). */
  readonly reason: unknown;
  readonly save: () => Promise<Completed>;

  constructor(reason: unknown, save: () => Promise<Completed>) {
    super(
      `Your new key was created on OpenRouter but could not be saved here. ${userMessage(reason)}`,
      {
        cause: reason,
      },
    );
    this.reason = reason;
    this.save = save;
  }
}

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
/** Pending sign-ins older than this are refused (OpenRouter's codes expire after 10 minutes). */
const PENDING_MAX_AGE_MS = 30 * 60_000;

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

function readPending(): PendingSignIn | null {
  const value = readJson<unknown>(session(), SS_KEYS.oauth);
  if (!isRecord(value)) return null;
  const { verifier, state, returnTo, keyLabel, createdAt } = value;
  if (!isString(verifier) || !isString(state) || !isFiniteNumber(createdAt)) return null;
  return {
    verifier,
    state,
    returnTo: isString(returnTo) ? returnTo : null,
    keyLabel: isString(keyLabel) ? keyLabel : null,
    createdAt,
  };
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
      if (!core.keys.lock.unlocked()) throw new KeyLockedError();
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
      // Before anything is consumed: a locked tab could not store the key.
      if (!core.keys.lock.unlocked()) throw new KeyLockedError();
      const pending = readPending();
      // Single use: gone before the exchange starts, whatever happens next.
      removeItem(session(), SS_KEYS.oauth);

      const denied = params.get('error');
      if (denied) throw new OAuthError('The sign-in was canceled or refused on OpenRouter.');
      const code = params.get('code');
      if (!code) throw new OAuthError('This page has no sign-in code. Start the connection again.');
      if (!pending) {
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
      const returnTo = safeReturnTo(pending.returnTo);
      const save = async (): Promise<Completed> => {
        const before = new Set(core.keys.list().map((k) => k.id));
        try {
          const key: KeyInfo = await core.keys.add({
            name: pending.keyLabel ?? 'OpenRouter',
            secret,
            source: 'oauth',
          });
          return { key, returnTo };
        } catch (error) {
          // Stored before a later step failed (the default-key setting): saving again would add it twice.
          const landed = core.keys
            .list()
            .find((k) => !before.has(k.id) && k.source === 'oauth' && k.masked === maskKey(secret));
          if (landed) return { key: landed, returnTo };
          throw error;
        }
      };
      try {
        return await save();
      } catch (error) {
        throw new KeyNotSavedError(error, save);
      }
    },
  };
}
