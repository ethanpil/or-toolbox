/**
 * API keys and the optional passphrase lock.
 *
 * Storage: `StoredKeysFile` JSON in localStorage `ortoolbox:keys` (never in settings, so settings exports hold no
 * secrets). Lock off: `secret` holds the key. Lock on: every key has `enc` (AES-GCM under a PBKDF2-derived key)
 * and the file has `lock.verifier`, an encrypted constant that proves a passphrase right. Every lock change
 * rewrites the whole file with one `setItem`, so a crash never leaves a half-migrated file, and is refused if
 * another tab changed the file meanwhile.
 *
 * Unlocking is per tab: sessionStorage `ortoolbox:unlocked` holds `{key, at}`, the raw AES key (base64) and the
 * time of the last `touch()`. It survives navigation between the site's pages in that tab and dies with the
 * tab. After `settings.security.autoLockMinutes` without `touch()` the entry is deleted (0 disables auto-lock).
 *
 * The default key is `settings.defaultKeyId`; when that is null or stale (e.g. after a settings reset) the first
 * key acts as default, so a user with keys is never told to add one.
 */

import {
  PBKDF2_ITERATIONS,
  decryptString,
  deriveKey,
  encryptString,
  exportRawKey,
  fromBase64,
  importRawKey,
  randomBytes,
  toBase64,
} from '../crypto';
import { KeyLockedError, NoKeyError } from '../errors';
import {
  LS_KEYS,
  SS_KEYS,
  local,
  readJson,
  removeItem,
  session,
  writeJson,
} from '../storage/local';
import type {
  CoreServices,
  EncryptedBlob,
  KeyInfo,
  KeyLock,
  KeyStatus,
  KeysService,
  StoredKey,
  StoredKeysFile,
} from '../types';
import { InvalidKeyError, keyFormatProblem, maskKey, normalizeKeyInput } from './format';

/** Plaintext of `lock.verifier`. */
const VERIFIER_TEXT = 'ortoolbox-key-lock-v1';
const STATUS_TTL_MS = 60_000;
/** `touch()` writes the activity time at most this often. */
const TOUCH_WRITE_INTERVAL_MS = 5_000;

/** A lock operation was given the wrong passphrase. */
export class WrongPassphraseError extends Error {
  override readonly name = 'WrongPassphraseError';
  constructor(message = 'Wrong passphrase.') {
    super(message);
  }
}

/** Another tab changed the keys while a lock operation was running; nothing was written. */
export class KeysChangedError extends Error {
  override readonly name = 'KeysChangedError';
  constructor(message = 'Your keys changed in another tab. Try again.') {
    super(message);
  }
}

interface UnlockedSession {
  key: string;
  at: number;
}

export interface KeysServiceOptions {
  /** PBKDF2 iterations for new locks; tests pass a small number. Existing locks keep their own count. */
  pbkdf2Iterations?: number;
  now?: () => number;
}

function readFile(): StoredKeysFile {
  const file = readJson<StoredKeysFile>(local(), LS_KEYS.keys);
  if (!file || file.version !== 1 || !Array.isArray(file.keys)) {
    return { version: 1, keys: [], lock: null };
  }
  return { version: 1, keys: file.keys, lock: file.lock ?? null };
}

function rawFile(): string | null {
  try {
    return local()?.getItem(LS_KEYS.keys) ?? null;
  } catch {
    return null;
  }
}

function writeFile(file: StoredKeysFile): void {
  writeJson(local(), LS_KEYS.keys, file);
}

function readSession(): UnlockedSession | null {
  const value = readJson<UnlockedSession>(session(), SS_KEYS.unlocked);
  return value && typeof value.key === 'string' && typeof value.at === 'number' ? value : null;
}

function toInfo(key: StoredKey, defaultId: string | null): KeyInfo {
  return {
    id: key.id,
    name: key.name,
    colour: key.colour,
    masked: key.masked,
    source: key.source,
    createdAt: key.createdAt,
    noRetention: key.noRetention,
    isDefault: key.id === defaultId,
  };
}

function assertPassphrase(passphrase: string): void {
  if (!passphrase) throw new Error('Enter a passphrase.');
}

export function createKeysService(
  core: CoreServices,
  options: KeysServiceOptions = {},
): KeysService {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  const statusCache = new Map<string, KeyStatus>();
  const statusInflight = new Map<string, Promise<KeyStatus>>();
  let wired = false;
  let imported: { raw: string; key: CryptoKey } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function notify(): void {
    for (const fn of [...listeners]) fn();
  }

  /** Announce a change of the stored file; the bus delivers it to this tab's listeners too. */
  function changed(): void {
    core.bus.emit({ type: 'keys-changed' });
  }

  /** Subscribes to the bus on first use (never in the factory body, so the composition root can wire freely). */
  function wire(): void {
    if (wired) return;
    wired = true;
    core.bus.on('keys-changed', () => {
      void reconcileSession().finally(notify);
    });
    if (readSession()) scheduleAutoLock();
  }

  function defaultId(file: StoredKeysFile): string | null {
    const id = core.settings.get().defaultKeyId;
    return file.keys.some((k) => k.id === id) ? id : (file.keys[0]?.id ?? null);
  }

  function autoLockMs(): number | null {
    const minutes = core.settings.get().security.autoLockMinutes;
    return minutes > 0 ? minutes * 60_000 : null;
  }

  function expired(unlocked: UnlockedSession): boolean {
    const ms = autoLockMs();
    return ms !== null && now() - unlocked.at >= ms;
  }

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Forget the unlocked key in this tab. */
  function lockLocal(): void {
    const had = readSession() !== null;
    removeItem(session(), SS_KEYS.unlocked);
    imported = null;
    clearTimer();
    if (had) notify();
  }

  function scheduleAutoLock(): void {
    clearTimer();
    const unlocked = readSession();
    const ms = autoLockMs();
    if (!unlocked || ms === null) return;
    timer = setTimeout(
      () => {
        timer = null;
        const current = readSession();
        if (!current) return;
        if (expired(current)) lockLocal();
        else scheduleAutoLock();
      },
      Math.max(0, unlocked.at + ms - now()),
    );
  }

  /** The unlocked session when the lock is on and this tab holds a live one; locks on expiry. */
  function activeSession(): UnlockedSession | null {
    const unlocked = readSession();
    if (!unlocked || readFile().lock === null) return null;
    if (expired(unlocked)) {
      lockLocal();
      return null;
    }
    return unlocked;
  }

  async function sessionCryptoKey(unlocked: UnlockedSession): Promise<CryptoKey> {
    if (imported?.raw === unlocked.key) return imported.key;
    const key = await importRawKey(unlocked.key);
    imported = { raw: unlocked.key, key };
    return key;
  }

  function startSession(raw: string): void {
    const value: UnlockedSession = { key: raw, at: now() };
    writeJson(session(), SS_KEYS.unlocked, value);
    imported = null;
    scheduleAutoLock();
  }

  /** After a change elsewhere: drop a session key that no longer opens the file (lock off or passphrase changed). */
  async function reconcileSession(): Promise<void> {
    const unlocked = readSession();
    if (!unlocked) return;
    const lock = readFile().lock;
    if (!lock) {
      lockLocal();
      return;
    }
    try {
      await decryptString(await sessionCryptoKey(unlocked), lock.verifier);
    } catch {
      lockLocal();
    }
  }

  /** Derives the key for `lock` and proves it against the verifier. */
  async function verifiedKey(
    passphrase: string,
    lock: NonNullable<StoredKeysFile['lock']>,
  ): Promise<CryptoKey> {
    const key = await deriveKey(passphrase, fromBase64(lock.salt), lock.iterations, true);
    try {
      await decryptString(key, lock.verifier);
    } catch {
      throw new WrongPassphraseError();
    }
    return key;
  }

  async function encryptAll(
    key: CryptoKey,
    secrets: string[],
    file: StoredKeysFile,
  ): Promise<StoredKey[]> {
    return Promise.all(
      file.keys.map(async (k, i) => ({
        ...k,
        secret: null,
        enc: await encryptString(key, secrets[i] ?? ''),
      })),
    );
  }

  /** Writes `next` only if the stored file is still `before` (no await between the check and the write). */
  function commit(before: string | null, next: StoredKeysFile): void {
    if (rawFile() !== before) throw new KeysChangedError();
    writeFile(next);
  }

  const lock: KeyLock = {
    enabled() {
      return readFile().lock !== null;
    },

    unlocked() {
      wire();
      return readFile().lock === null || activeSession() !== null;
    },

    async enable(passphrase) {
      wire();
      assertPassphrase(passphrase);
      const before = rawFile();
      const file = readFile();
      if (file.lock) throw new Error('The passphrase lock is already on.');
      const salt = randomBytes(16);
      const iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
      const key = await deriveKey(passphrase, salt, iterations, true);
      const keys = await encryptAll(
        key,
        file.keys.map((k) => k.secret ?? ''),
        file,
      );
      const verifier: EncryptedBlob = await encryptString(key, VERIFIER_TEXT);
      const raw = await exportRawKey(key);
      commit(before, { version: 1, keys, lock: { salt: toBase64(salt), iterations, verifier } });
      startSession(raw);
      changed();
    },

    async disable(passphrase) {
      wire();
      const before = rawFile();
      const file = readFile();
      if (!file.lock) return;
      const key = await verifiedKey(passphrase, file.lock);
      const keys = await Promise.all(
        file.keys.map(async (k) => ({
          ...k,
          secret: k.enc ? await decryptString(key, k.enc) : k.secret,
          enc: null,
        })),
      );
      commit(before, { version: 1, keys, lock: null });
      lockLocal();
      changed();
    },

    async unlock(passphrase) {
      wire();
      const file = readFile();
      if (!file.lock) return true;
      let key: CryptoKey;
      try {
        key = await verifiedKey(passphrase, file.lock);
      } catch (error) {
        if (error instanceof WrongPassphraseError) return false;
        throw error;
      }
      startSession(await exportRawKey(key));
      notify();
      return true;
    },

    lockNow() {
      lockLocal();
    },

    async changePassphrase(oldPassphrase, newPassphrase) {
      wire();
      assertPassphrase(newPassphrase);
      const before = rawFile();
      const file = readFile();
      if (!file.lock) throw new Error('The passphrase lock is off.');
      const oldKey = await verifiedKey(oldPassphrase, file.lock);
      const secrets = await Promise.all(
        file.keys.map((k) =>
          k.enc ? decryptString(oldKey, k.enc) : Promise.resolve(k.secret ?? ''),
        ),
      );
      const salt = randomBytes(16);
      const iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
      const newKey = await deriveKey(newPassphrase, salt, iterations, true);
      const keys = await encryptAll(newKey, secrets, file);
      const verifier = await encryptString(newKey, VERIFIER_TEXT);
      const raw = await exportRawKey(newKey);
      // One write: the file is either entirely old or entirely new.
      commit(before, { version: 1, keys, lock: { salt: toBase64(salt), iterations, verifier } });
      startSession(raw);
      changed();
    },

    touch() {
      wire();
      const unlocked = readSession();
      if (!unlocked || readFile().lock === null) return;
      if (expired(unlocked)) {
        lockLocal();
        return;
      }
      const t = now();
      if (t - unlocked.at < TOUCH_WRITE_INTERVAL_MS) return;
      writeJson(session(), SS_KEYS.unlocked, {
        key: unlocked.key,
        at: t,
      } satisfies UnlockedSession);
      scheduleAutoLock();
    },
  };

  const service: KeysService = {
    list() {
      wire();
      const file = readFile();
      const id = defaultId(file);
      return file.keys.map((k) => toInfo(k, id));
    },

    get(id) {
      const file = readFile();
      const key = file.keys.find((k) => k.id === id);
      return key ? toInfo(key, defaultId(file)) : undefined;
    },

    async add(input) {
      wire();
      const secret = normalizeKeyInput(input.secret);
      const problem = keyFormatProblem(secret);
      if (problem) throw new InvalidKeyError(problem);
      const before = readFile();
      const stored: StoredKey = {
        id: crypto.randomUUID(),
        name: input.name.trim() || 'OpenRouter key',
        colour: input.colour ?? null,
        masked: maskKey(secret),
        source: input.source ?? 'pasted',
        createdAt: now(),
        noRetention: false,
        secret: null,
        enc: null,
      };
      if (before.lock) {
        const unlocked = activeSession();
        if (!unlocked) throw new KeyLockedError();
        stored.enc = await encryptString(await sessionCryptoKey(unlocked), secret);
      } else {
        stored.secret = secret;
      }
      // Re-read after the await so a key added meanwhile in another tab is kept.
      const file = readFile();
      if (JSON.stringify(file.lock) !== JSON.stringify(before.lock)) throw new KeysChangedError();
      file.keys.push(stored);
      writeFile(file);
      const settings = core.settings.get();
      if (!file.keys.some((k) => k.id === settings.defaultKeyId)) {
        core.settings.update((draft) => {
          draft.defaultKeyId = stored.id;
        });
      }
      changed();
      return toInfo(stored, defaultId(file));
    },

    update(id, patch) {
      wire();
      const file = readFile();
      const key = file.keys.find((k) => k.id === id);
      if (!key) return;
      if (patch.name !== undefined) key.name = patch.name.trim() || key.name;
      if (patch.colour !== undefined) key.colour = patch.colour;
      if (patch.noRetention !== undefined) key.noRetention = patch.noRetention;
      writeFile(file);
      changed();
    },

    remove(id) {
      wire();
      const file = readFile();
      const keys = file.keys.filter((k) => k.id !== id);
      if (keys.length === file.keys.length) return;
      writeFile({ ...file, keys });
      statusCache.delete(id);
      if (core.settings.get().defaultKeyId === id) {
        core.settings.update((draft) => {
          draft.defaultKeyId = keys[0]?.id ?? null;
        });
      }
      changed();
    },

    setDefault(id) {
      wire();
      if (!readFile().keys.some((k) => k.id === id)) return;
      core.settings.update((draft) => {
        draft.defaultKeyId = id;
      });
      changed();
    },

    resolve(tool, overrideKeyId) {
      const file = readFile();
      const fallback = defaultId(file);
      const binding = tool ? core.settings.get().tools[tool]?.keyId : undefined;
      for (const id of [overrideKeyId, binding, fallback]) {
        const key = id ? file.keys.find((k) => k.id === id) : undefined;
        if (key) return toInfo(key, fallback);
      }
      return null;
    },

    async secret(id) {
      wire();
      const file = readFile();
      const key = file.keys.find((k) => k.id === id);
      if (!key)
        throw new NoKeyError('That key was removed. Choose another key in Settings → Keys.');
      if (!file.lock) {
        if (key.secret) return key.secret;
        throw new NoKeyError('This key has no stored secret. Remove it and add it again.');
      }
      const unlocked = activeSession();
      if (!unlocked || !key.enc) throw new KeyLockedError();
      try {
        return await decryptString(await sessionCryptoKey(unlocked), key.enc);
      } catch {
        // The session key no longer matches (passphrase changed in another tab).
        lockLocal();
        throw new KeyLockedError();
      }
    },

    status(id, opts) {
      const cached = statusCache.get(id);
      if (!opts?.force && cached && now() - cached.fetchedAt < STATUS_TTL_MS) {
        return Promise.resolve(cached);
      }
      let pending = statusInflight.get(id);
      if (!pending) {
        pending = (async () => {
          const { data } = await core.api.account.key(await service.secret(id));
          const status: KeyStatus = {
            label: data.label ?? null,
            usageUsd: data.usage,
            usageMonthlyUsd: data.usage_monthly ?? null,
            limitUsd: data.limit,
            limitRemainingUsd: data.limit_remaining,
            limitReset: data.limit_reset ?? null,
            isFreeTier: data.is_free_tier,
            freeDaily: data.free_model_daily_requests ?? null,
            fetchedAt: now(),
          };
          statusCache.set(id, status);
          return status;
        })().finally(() => statusInflight.delete(id));
        statusInflight.set(id, pending);
      }
      return pending;
    },

    lock,

    subscribe(fn) {
      wire();
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };

  return service;
}
