/**
 * The only place that names Web Storage keys. localStorage holds small synchronous state shared by every
 * page; sessionStorage holds per-tab secrets (unlocked key material, the OAuth verifier).
 */

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
  /** One-time reload guard for cross-origin isolation. */
  coiReload: 'ortoolbox:coi-reload',
} as const;

/** Parse JSON from storage; returns null when missing, unparsable, or storage is unavailable. */
export function readJson<T>(storage: Storage | undefined, key: string): T | null {
  try {
    const raw = storage?.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** Write JSON. Throws `StorageFullError` when the quota is exceeded so callers can tell the user. */
export function writeJson(storage: Storage | undefined, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === 'QuotaExceededError' || error.code === 22)
    ) {
      throw new StorageFullError();
    }
    throw error;
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

export class StorageFullError extends Error {
  override readonly name = 'StorageFullError';
  constructor(message = 'Browser storage is full. Delete some history in Settings → Data.') {
    super(message);
  }
}
