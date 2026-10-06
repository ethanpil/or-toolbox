/**
 * The only place that names Web Storage keys. localStorage holds small synchronous state shared by every
 * page; sessionStorage holds per-tab secrets (unlocked key material, the OAuth verifier).
 */

import { StorageFullError, StorageUnavailableError } from '../errors';
import { parseJsonSafe } from '../util';

export const LS_KEYS = {
  /** `Settings` JSON (no secrets). */
  settings: 'ortoolbox:settings',
  /** `StoredKeysFile` JSON. */
  keys: 'ortoolbox:keys',
  /** Fallback channel for cross-tab events when BroadcastChannel is unavailable. */
  bus: 'ortoolbox:bus',
  /** Timestamps of recent `:free` requests, shared by tabs for the 20/min client throttle. */
  freeRequests: 'ortoolbox:free-requests',
} as const;

export const SS_KEYS = {
  /** Base64 raw AES key derived from the passphrase, present while unlocked. */
  unlocked: 'ortoolbox:unlocked',
  /** PKCE verifier + returnTo during the OAuth round trip. */
  oauth: 'ortoolbox:oauth',
  /** One-time reload guard for cross-origin isolation (src/core/sw-register.ts). */
  isolationReload: 'ortoolbox:isolation-reload',
} as const;

/** The raw stored string, or null when missing or storage is unavailable. */
export function readRaw(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse JSON from storage (prototype-safe, see `parseJsonSafe`); returns null when missing, unparsable, or
 * storage is unavailable. The shape is NOT validated: callers must validate before trusting it.
 */
export function readJson<T>(storage: Storage | undefined, key: string): T | null {
  const raw = readRaw(storage, key);
  if (raw == null) return null;
  try {
    return parseJsonSafe(raw) as T;
  } catch {
    return null;
  }
}

/**
 * True for the error a browser raises when a store is over its quota (Web Storage or IndexedDB; Firefox's older
 * name too). By name, since a DOMException may come from another realm.
 */
export function isQuotaError(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : '';
  return (
    name === 'QuotaExceededError' ||
    name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (error instanceof DOMException && error.code === 22)
  );
}

/**
 * Write JSON. Throws `StorageFullError` when the quota is exceeded and `StorageUnavailableError` when the browser
 * blocks storage (absent, or a SecurityError), so callers can tell the user; it never pretends to have saved.
 */
export function writeJson(storage: Storage | undefined, key: string, value: unknown): void {
  if (!storage) throw new StorageUnavailableError();
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (isQuotaError(error)) throw new StorageFullError();
    if ((error as { name?: unknown } | null)?.name === 'SecurityError') {
      throw new StorageUnavailableError();
    }
    throw error;
  }
}

const PROBE_KEY = 'ortoolbox:probe';

/**
 * True when the browser refuses to store anything (no `localStorage`, or a write raises a SecurityError): the page
 * can then tell the user at once, instead of a settings change or a key looking saved and being gone on the next
 * page. A store that is only full is not blocked (`StorageFullError` says that when a write meets it).
 */
export function webStorageBlocked(): boolean {
  const storage = local();
  if (!storage) return true;
  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return false;
  } catch (error) {
    return !isQuotaError(error);
  }
}

export function removeItem(storage: Storage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage unavailable (private mode); nothing to remove.
  }
}

/** localStorage, or undefined when access throws (some privacy modes). */
export function local(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** sessionStorage, or undefined when access throws. */
export function session(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export { StorageFullError, StorageUnavailableError };
