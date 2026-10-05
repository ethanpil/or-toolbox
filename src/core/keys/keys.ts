/**
 * API keys and the optional passphrase lock.
 *
 * Storage: `StoredKeysFile` JSON in localStorage `ortoolbox:keys` (never in settings, so settings exports hold no
 * secrets), validated on every read. Lock off: `secret` holds the key. Lock on: every key has `enc` (AES-GCM under
 * a PBKDF2-derived key) and the file has `lock.verifier`, an encrypted constant that proves a passphrase right.
 * Every lock change rewrites the whole file with one `setItem`, so a crash never leaves a half-migrated file, and
 * is refused (KeysChangedError) if another tab changed the file meanwhile. Backup and data reset go through
 * `exportFile`/`replaceFile`/`clear`, never through localStorage directly.
 *
 * Unlocking is per tab: sessionStorage `ortoolbox:unlocked` holds `{key, at}`, the raw AES key (base64) and the
 * time of the last `touch()`. It survives navigation between the site's pages in that tab and dies with the
 * tab. A session key that no longer opens the file (passphrase changed elsewhere) is dropped at page start and
 * before it encrypts anything. After `settings.security.autoLockMinutes` (capped at 24 h; 0 disables it)
 * without `touch()` the entry is deleted.
 *
 * The default key is `settings.defaultKeyId`, set when the first key is added; when it is null or stale (e.g.
 * after a settings reset) the first key acts as default, so a user with keys is never told to add one.
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
import {
  InvalidInputError,
  InvalidKeyError,
  KeyLockedError,
  KeysChangedError,
  NoKeyError,
  WrongPassphraseError,
} from '../errors';
import {
  LS_KEYS,
  SS_KEYS,
  local,
  readJson,
  readRaw,
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
  Settings,
  StoredKey,
  StoredKeysFile,
} from '../types';
import { MAX_TIMEOUT_MS, MINUTE_MS, isFiniteNumber, isRecord, isString } from '../util';
import { keyFormatProblem, maskKey, normalizeKeyInput } from './format';

// Historical import path for these errors (they live in errors.ts).
export { KeysChangedError, WrongPassphraseError } from '../errors';

/** Plaintext of `lock.verifier`. */
const VERIFIER_TEXT = 'ortoolbox-key-lock-v1';
const STATUS_TTL_MS = 60_000;
/** `touch()` writes the activity time at most this often. */
const TOUCH_WRITE_INTERVAL_MS = 5_000;
/** Longest auto-lock delay honoured; larger settings are clamped (setTimeout overflows above ~24.8 days). */
const MAX_AUTO_LOCK_MINUTES = 24 * 60;

interface UnlockedSession {
  key: string;
  at: number;
}

export interface KeysServiceOptions {
  /** PBKDF2 iterations for new locks; tests pass a small number. Existing locks keep their own count. */
  pbkdf2Iterations?: number;
  now?: () => number;
}

// --- validation ------------------------------------------------------------------------------------

/** The blob, null when absent, undefined when malformed. */
function parseEnc(value: unknown): EncryptedBlob | null | undefined {
  if (value == null) return null;
  return isRecord(value) && isString(value['iv']) && isString(value['ct'])
    ? { iv: value['iv'], ct: value['ct'] }
    : undefined;
}

function parseKey(value: unknown): StoredKey | null {
  if (!isRecord(value)) return null;
  const { id, name, colour, masked, source, createdAt, noRetention, secret, enc } = value;
  if (!isString(id) || !id || !isString(name) || !isString(masked)) return null;
  if (source !== 'pasted' && source !== 'oauth') return null;
  if (!isFiniteNumber(createdAt)) return null;
  if (colour != null && !isString(colour)) return null;
  if (secret != null && !isString(secret)) return null;
  const parsedEnc = parseEnc(enc);
  if (parsedEnc === undefined) return null;
  return {
    id,
    name,
    colour: isString(colour) ? colour : null,
    masked,
    source,
    createdAt,
    noRetention: noRetention === true,
    secret: isString(secret) ? secret : null,
    enc: parsedEnc,
  };
}

function parseLock(value: unknown): StoredKeysFile['lock'] | undefined {
  if (!isRecord(value)) return undefined;
  const { salt, iterations, verifier } = value;
  const parsedVerifier = parseEnc(verifier);
  if (!isString(salt) || !isFiniteNumber(iterations) || iterations < 1 || !parsedVerifier) {
    return undefined;
  }
  return { salt, iterations, verifier: parsedVerifier };
}

export interface ParsedKeysFile {
  file: StoredKeysFile;
  /** Stored entries this build cannot read (another version's, or damaged): written back unchanged. */
  unreadable: unknown[];
}

/**
 * Validates a keys file. Anything that is not a version-1 file with a key list and a readable lock (or none) is
 * null. `strict` (replaceFile) also rejects a malformed or duplicate key, or a key whose secret does not match
 * the lock state. Lenient (reading storage) sets malformed and duplicate keys aside as `unreadable`.
 */
export function parseKeysFile(value: unknown, strict: boolean): ParsedKeysFile | null {
  if (!isRecord(value) || value['version'] !== 1 || !Array.isArray(value['keys'])) return null;
  let lock: StoredKeysFile['lock'] = null;
  if (value['lock'] != null) {
    const parsed = parseLock(value['lock']);
    if (parsed === undefined) return null;
    lock = parsed;
  }
  const keys: StoredKey[] = [];
  const unreadable: unknown[] = [];
  const ids = new Set<string>();
  for (const item of value['keys'] as unknown[]) {
    const key = parseKey(item);
    if (!key || ids.has(key.id)) {
      if (strict) return null;
      unreadable.push(item);
      continue;
    }
    const consistent = lock ? key.enc !== null && key.secret === null : key.secret !== null;
    if (strict && !consistent) return null;
    keys.push(key);
    ids.add(key.id);
  }
  return { file: { version: 1, keys, lock }, unreadable };
}

/** What storage holds, as this build reads it. */
interface Stored extends ParsedKeysFile {
  /** A stored file this build cannot read at all (another version, or damaged): it reads as no keys. */
  foreign: boolean;
}

const FOREIGN_FILE =
  'Your keys were saved by a newer version of ORtoolbox, or are damaged, so this page does not change them. Reload the page. If that does not help, Reset everything in Settings → Data removes them.';
const UNREADABLE_KEYS =
  'Some of your keys were saved by a newer version of ORtoolbox, so this page cannot change the lock. Reload the page and try again.';

function rawFile(): string | null {
  return readRaw(local(), LS_KEYS.keys);
}

function load(): Stored {
  const raw = rawFile();
  const parsed =
    raw === null ? null : parseKeysFile(readJson<unknown>(local(), LS_KEYS.keys), false);
  return parsed
    ? { ...parsed, foreign: false }
    : { file: { version: 1, keys: [], lock: null }, unreadable: [], foreign: raw !== null };
}

function readFile(): StoredKeysFile {
  return load().file;
}

/** Refuses to write over a file this build cannot read; for a lock change, also over unreadable entries. */
function assertWritable(stored: Stored, lockChange = false): void {
  if (stored.foreign) throw new KeysChangedError(FOREIGN_FILE);
  if (lockChange && stored.unreadable.length > 0) throw new KeysChangedError(UNREADABLE_KEYS);
}

/** Writes `file` over `stored`, keeping the entries this build could not read. */
function writeFile(stored: Stored, file: StoredKeysFile): void {
  assertWritable(stored);
  writeJson(local(), LS_KEYS.keys, { ...file, keys: [...file.keys, ...stored.unreadable] });
}

function readSession(): UnlockedSession | null {
  const value = readJson<unknown>(session(), SS_KEYS.unlocked);
  return isRecord(value) && isString(value['key']) && isFiniteNumber(value['at'])
    ? { key: value['key'], at: value['at'] }
    : null;
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

/** Tool → pinned key id, as a comparable string. */
function keyBindings(settings: Readonly<Settings>): string {
  return JSON.stringify(
    Object.entries(settings.tools)
      .map(([tool, binding]) => [tool, binding?.keyId ?? null])
      .filter(([, keyId]) => keyId !== null),
  );
}

function assertPassphrase(passphrase: string): void {
  if (!passphrase) throw new InvalidInputError('Enter a passphrase.');
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

  /**
   * Subscribes to the bus and settings and checks a session left by an earlier page, on first use (never in the
   * factory body, so the composition root can wire freely).
   */
  function wire(): void {
    if (wired) return;
    wired = true;
    core.bus.on('keys-changed', () => {
      void reconcileSession().finally(notify);
    });
    core.bus.on('data-reset', () => {
      statusCache.clear();
      statusInflight.clear();
      imported = null;
      void reconcileSession().finally(notify);
    });
    // Local and other-tab settings changes: the auto-lock delay and which key is default or pinned.
    core.settings.subscribe((next, prev) => {
      if (next.security.autoLockMinutes !== prev.security.autoLockMinutes) {
        const unlocked = readSession();
        if (unlocked && expired(unlocked)) lockLocal();
        else scheduleAutoLock();
      }
      if (next.defaultKeyId !== prev.defaultKeyId || keyBindings(next) !== keyBindings(prev)) {
        notify();
      }
    });
    if (readSession()) {
      scheduleAutoLock();
      void reconcileSession();
    }
  }

  /**
   * Removes settings that point at keys that no longer exist: the default (reassigned to the first remaining
   * key), tool bindings (the tool then uses the default) and per-key budgets. Done before the keys file is
   * written, so a failed settings write changes nothing; a capped tool never silently keeps a stale binding.
   */
  function forgetKeys(removed: Set<string>, remaining: StoredKey[]): void {
    if (removed.size === 0) return;
    const settings = core.settings.get();
    const stale =
      (settings.defaultKeyId !== null && removed.has(settings.defaultKeyId)) ||
      Object.values(settings.tools).some((b) => b?.keyId !== undefined && removed.has(b.keyId)) ||
      Object.keys(settings.budgets.perKeyMonthlyUsd).some((id) => removed.has(id));
    if (!stale) return;
    core.settings.update((draft) => {
      if (draft.defaultKeyId !== null && removed.has(draft.defaultKeyId)) {
        draft.defaultKeyId = remaining[0]?.id ?? null;
      }
      for (const binding of Object.values(draft.tools)) {
        if (binding?.keyId !== undefined && removed.has(binding.keyId)) delete binding.keyId;
      }
      for (const id of removed) delete draft.budgets.perKeyMonthlyUsd[id];
    });
  }

  function defaultId(file: StoredKeysFile): string | null {
    const id = core.settings.get().defaultKeyId;
    return file.keys.some((k) => k.id === id) ? id : (file.keys[0]?.id ?? null);
  }

  function autoLockMs(): number | null {
    const minutes = core.settings.get().security.autoLockMinutes;
    if (!isFiniteNumber(minutes) || minutes <= 0) return null;
    return Math.min(minutes, MAX_AUTO_LOCK_MINUTES) * MINUTE_MS;
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

  /** One timer for the next possible expiry; re-armed only when activity moved it. */
  function scheduleAutoLock(): void {
    clearTimer();
    const unlocked = readSession();
    const ms = autoLockMs();
    if (!unlocked || ms === null) return;
    const delay = Math.min(Math.max(0, unlocked.at + ms - now()), MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      timer = null;
      const current = readSession();
      if (!current) return;
      if (expired(current)) lockLocal();
      else scheduleAutoLock();
    }, delay);
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

  /** This tab's session key, proven against `lock.verifier`; a stale one is dropped (KeyLockedError). */
  async function verifiedSessionKey(lock: NonNullable<StoredKeysFile['lock']>): Promise<CryptoKey> {
    const unlocked = activeSession();
    if (!unlocked) throw new KeyLockedError();
    try {
      const key = await sessionCryptoKey(unlocked);
      await decryptString(key, lock.verifier);
      return key;
    } catch {
      lockLocal();
      throw new KeyLockedError();
    }
  }

  function startSession(raw: string): void {
    const value: UnlockedSession = { key: raw, at: now() };
    writeJson(session(), SS_KEYS.unlocked, value);
    imported = null;
    scheduleAutoLock();
  }

  /** Drop a session key that no longer opens the file (lock off, or passphrase changed in another tab). */
  async function reconcileSession(): Promise<void> {
    if (!readSession()) return;
    const lock = readFile().lock;
    if (!lock) {
      lockLocal();
      return;
    }
    await verifiedSessionKey(lock).catch(() => undefined);
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

  /** The stored file before a lock change; refused when the change could lose something. */
  function lockChangeSource(): StoredKeysFile {
    const stored = load();
    assertWritable(stored, true);
    return stored.file;
  }

  /**
   * Writes a lock change only if the stored file is still `before` (no await between the check and the write),
   * which `lockChangeSource()` found writable with nothing unreadable in it.
   */
  function commit(before: string | null, next: StoredKeysFile): void {
    if (rawFile() !== before) throw new KeysChangedError();
    writeJson(local(), LS_KEYS.keys, next);
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
      const file = lockChangeSource();
      if (file.lock) throw new InvalidInputError('The passphrase lock is already on.');
      const salt = randomBytes(16);
      const iterations = options.pbkdf2Iterations ?? PBKDF2_ITERATIONS;
      const key = await deriveKey(passphrase, salt, iterations, true);
      const keys = await encryptAll(
        key,
        file.keys.map((k) => k.secret ?? ''),
        file,
      );
      const verifier = await encryptString(key, VERIFIER_TEXT);
      const raw = await exportRawKey(key);
      commit(before, { version: 1, keys, lock: { salt: toBase64(salt), iterations, verifier } });
      startSession(raw);
      changed();
    },

    async disable(passphrase) {
      wire();
      const before = rawFile();
      const file = lockChangeSource();
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
      const file = lockChangeSource();
      if (!file.lock) throw new InvalidInputError('The passphrase lock is off.');
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
      const loaded = load();
      assertWritable(loaded);
      const before = loaded.file;
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
        stored.enc = await encryptString(await verifiedSessionKey(before.lock), secret);
      } else {
        stored.secret = secret;
      }
      // Re-read after the await so a key added meanwhile in another tab is kept.
      const latest = load();
      const file = latest.file;
      if (JSON.stringify(file.lock) !== JSON.stringify(before.lock)) throw new KeysChangedError();
      file.keys.push(stored);
      writeFile(latest, file);
      // Only the first key becomes default; a stale default id is covered by the first-key fallback.
      if (file.keys.length === 1) {
        core.settings.update((draft) => {
          draft.defaultKeyId = stored.id;
        });
      }
      changed();
      return toInfo(stored, defaultId(file));
    },

    update(id, patch) {
      wire();
      const stored = load();
      const key = stored.file.keys.find((k) => k.id === id);
      if (!key) return;
      if (patch.name !== undefined) key.name = patch.name.trim() || key.name;
      if (patch.colour !== undefined) key.colour = patch.colour;
      if (patch.noRetention !== undefined) key.noRetention = patch.noRetention;
      writeFile(stored, stored.file);
      changed();
    },

    remove(id) {
      wire();
      const stored = load();
      const file = stored.file;
      const keys = file.keys.filter((k) => k.id !== id);
      if (keys.length === file.keys.length) return;
      forgetKeys(new Set([id]), keys);
      writeFile(stored, { ...file, keys });
      statusCache.delete(id);
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

    exportFile() {
      return structuredClone(readFile());
    },

    replaceFile(next, opts) {
      wire();
      const valid = parseKeysFile(next, true)?.file;
      if (!valid)
        throw new InvalidInputError('The keys in this file are invalid; nothing was changed.');
      const stored = load();
      const current = stored.file;
      const lockChanged = JSON.stringify(current.lock) !== JSON.stringify(valid.lock);
      // Entries this build cannot read are kept, which works only under the lock they were written with.
      assertWritable(stored, lockChanged);
      if (opts?.expected !== undefined) {
        const expected = parseKeysFile(opts.expected, false)?.file;
        if (JSON.stringify(expected) !== JSON.stringify(current)) throw new KeysChangedError();
      }
      const kept = new Set(valid.keys.map((k) => k.id));
      forgetKeys(new Set(current.keys.map((k) => k.id).filter((id) => !kept.has(id))), valid.keys);
      writeFile(stored, valid);
      statusCache.clear();
      // A session key from another lock cannot open the new file.
      if (lockChanged) lockLocal();
      changed();
    },

    clear() {
      wire();
      forgetKeys(new Set(readFile().keys.map((k) => k.id)), []);
      removeItem(local(), LS_KEYS.keys);
      statusCache.clear();
      lockLocal();
      changed();
    },
  };

  return service;
}
