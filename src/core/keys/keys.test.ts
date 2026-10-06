import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import keyDocumented from '../../../tests/fixtures/openrouter/key.documented.json';
import { isolateChannels, testCore } from '../api/test-fakes';
import { PBKDF2_ITERATIONS } from '../crypto';
import { InvalidInputError, KeyLockedError, NoKeyError, errorCode } from '../errors';
import { LS_KEYS, SS_KEYS } from '../storage/local';
import type {
  ApiClient,
  Bus,
  BusEvent,
  KeysService,
  SettingsService,
  StoredKeysFile,
} from '../types';
import { MAX_TIMEOUT_MS } from '../util';
import { InvalidKeyError, keyFormatProblem, maskKey, normalizeKeyInput } from './format';
import { KeysChangedError, WrongPassphraseError, createKeysService } from './keys';

/** Fake keys: the `test`/`x` characters keep them clear of the pre-commit hook's real-key pattern. */
const KEY_A = `sk-or-v1-test${'x'.repeat(56)}a1b2`;
const KEY_B = `sk-or-v1-test${'y'.repeat(56)}c3d4`;

interface Harness {
  keys: KeysService;
  settings: SettingsService;
  bus: Bus;
  /** keys-changed events this tab received (its own and other tabs'). */
  events: BusEvent[];
  api: { account: { key: ReturnType<typeof vi.fn> } };
}

/** One tab: real bus and settings (tabs created in one test talk to each other). */
function harness(iterations = 1000): Harness {
  const api = { account: { key: vi.fn(() => Promise.resolve(keyDocumented)) } };
  const core = testCore({ api: api as unknown as ApiClient });
  const events: BusEvent[] = [];
  core.bus.on('keys-changed', (event) => events.push(event));
  const keys = createKeysService(core, iterations === 0 ? {} : { pbkdf2Iterations: iterations });
  core.keys = keys;
  return { keys, settings: core.settings, bus: core.bus, events, api };
}

function storedFile(): StoredKeysFile {
  return JSON.parse(localStorage.getItem(LS_KEYS.keys) ?? 'null') as StoredKeysFile;
}

beforeEach(() => {
  isolateChannels();
  localStorage.clear();
  sessionStorage.clear();
});

describe('format', () => {
  it('masks keys as sk-or-…last4', () => {
    expect(maskKey(KEY_A)).toBe('sk-or-…a1b2');
  });

  it('validates the shape, not liveness', () => {
    expect(keyFormatProblem(KEY_A)).toBeNull();
    expect(keyFormatProblem('')).toMatch(/Paste/);
    expect(keyFormatProblem('sk-ant-123456789012345678')).toMatch(/start with/);
    expect(keyFormatProblem('sk-or-v1-short')).toMatch(/complete/);
    expect(keyFormatProblem(`${KEY_A.slice(0, 20)} ${KEY_A.slice(20)}`)).toMatch(/spaces/);
  });

  it('cleans pasted input', () => {
    expect(normalizeKeyInput(`  Bearer "${KEY_A}"\n`)).toBe(KEY_A);
    expect(normalizeKeyInput(`'${KEY_A}'`)).toBe(KEY_A);
  });
});

describe('keys', () => {
  it('rejects malformed keys without storing anything', async () => {
    const { keys } = harness();
    const error: unknown = await keys
      .add({ name: 'Bad', secret: 'hello' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidKeyError);
    expect(errorCode(error)).toBe('invalid-key');
    expect(localStorage.getItem(LS_KEYS.keys)).toBeNull();
  });

  it('stores keys, makes the first one default, and never exposes secrets in KeyInfo', async () => {
    const { keys, settings, events } = harness();
    const changes = vi.fn();
    keys.subscribe(changes);
    const a = await keys.add({ name: ' Work ', secret: ` ${KEY_A} `, colour: '#ff0000' });
    const b = await keys.add({ name: 'Sandbox', secret: KEY_B, source: 'oauth' });

    expect(a).toEqual({
      id: a.id,
      name: 'Work',
      colour: '#ff0000',
      masked: 'sk-or-…a1b2',
      source: 'pasted',
      createdAt: expect.any(Number) as number,
      noRetention: false,
      isDefault: true,
    });
    expect(b).toMatchObject({ source: 'oauth', isDefault: false });
    expect(settings.get().defaultKeyId).toBe(a.id);
    expect(keys.list().map((k) => [k.name, k.isDefault])).toEqual([
      ['Work', true],
      ['Sandbox', false],
    ]);
    for (const info of keys.list()) {
      expect(info).not.toHaveProperty('secret');
      expect(info).not.toHaveProperty('enc');
    }
    expect(storedFile()).toMatchObject({ version: 1, lock: null });
    expect(storedFile().keys[0]).toMatchObject({ secret: KEY_A, enc: null });
    expect(events).toHaveLength(2);
    // Two keys-changed events plus the default-key change.
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(3));
  });

  it('makes only the first key default, never overwriting a stale default id', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    settings.update((d) => {
      d.defaultKeyId = 'restored-from-elsewhere';
    });
    await keys.add({ name: 'B', secret: KEY_B });
    expect(settings.get().defaultKeyId).toBe('restored-from-elsewhere');
    // The first-key fallback still resolves sensibly.
    expect(keys.resolve('chat')?.id).toBe(a.id);
  });

  it('updates, sets the default and reassigns it when the default is removed', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const b = await keys.add({ name: 'B', secret: KEY_B });
    keys.update(b.id, { name: 'Renamed', noRetention: true, colour: null });
    expect(keys.get(b.id)).toMatchObject({ name: 'Renamed', noRetention: true });
    keys.update(b.id, { name: '   ' });
    expect(keys.get(b.id)?.name).toBe('Renamed');

    keys.setDefault(b.id);
    expect(settings.get().defaultKeyId).toBe(b.id);
    keys.setDefault('missing');
    expect(settings.get().defaultKeyId).toBe(b.id);

    keys.remove(b.id);
    expect(settings.get().defaultKeyId).toBe(a.id);
    keys.remove(a.id);
    expect(settings.get().defaultKeyId).toBeNull();
    expect(keys.list()).toEqual([]);
  });

  it('resolves override → tool binding → default, skipping removed keys', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const b = await keys.add({ name: 'B', secret: KEY_B });
    settings.update((d) => {
      d.tools.ocr = { keyId: b.id };
    });
    expect(keys.resolve('chat')?.id).toBe(a.id);
    expect(keys.resolve('ocr')?.id).toBe(b.id);
    expect(keys.resolve('chat', b.id)?.id).toBe(b.id);
    expect(keys.resolve('ocr', 'gone')?.id).toBe(b.id);
    expect(keys.resolve()?.id).toBe(a.id);
    settings.update((d) => {
      d.tools.ocr = { keyId: 'gone' };
    });
    expect(keys.resolve('ocr')?.id).toBe(a.id);
  });

  it('falls back to the first key when the default id is missing', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    settings.update((d) => {
      d.defaultKeyId = null;
    });
    expect(keys.resolve('chat')?.id).toBe(a.id);
    expect(keys.list()[0]?.isDefault).toBe(true);
    keys.remove(a.id);
    expect(keys.resolve('chat')).toBeNull();
  });

  it('returns secrets and refuses unknown ids', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    expect(await keys.secret(a.id)).toBe(KEY_A);
    await expect(keys.secret('nope')).rejects.toBeInstanceOf(NoKeyError);
  });

  it('ignores malformed entries in storage', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const file = storedFile() as unknown as { keys: unknown[] };
    file.keys.push({ id: 7 }, null, { ...(file.keys[0] as object) });
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(file));
    expect(keys.list().map((k) => k.id)).toEqual([a.id]);
  });

  it('keeps entries it cannot read on every write instead of dropping them', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const future = { id: 'f1', name: 'Future', source: 'device-code', secret: 'x' };
    const file = storedFile() as unknown as { keys: unknown[] };
    file.keys.push(future);
    localStorage.setItem(LS_KEYS.keys, JSON.stringify(file));

    const b = await keys.add({ name: 'B', secret: KEY_B });
    keys.update(a.id, { name: 'A2' });
    keys.remove(b.id);
    expect((storedFile() as unknown as { keys: unknown[] }).keys).toContainEqual(future);
    expect(keys.list().map((k) => k.name)).toEqual(['A2']);

    // A lock change cannot re-encrypt what it cannot read: refused, nothing written.
    const before = localStorage.getItem(LS_KEYS.keys);
    await expect(keys.lock.enable('pass phrase')).rejects.toBeInstanceOf(KeysChangedError);
    expect(localStorage.getItem(LS_KEYS.keys)).toBe(before);
    // A replacement under the same lock keeps them too (backup merge, Undo of a removal).
    keys.replaceFile({ ...keys.exportFile(), keys: [] }, { expected: keys.exportFile() });
    expect((storedFile() as unknown as { keys: unknown[] }).keys).toEqual([future]);
  });

  it.each([
    ['a newer version', (file: Record<string, unknown>) => ({ ...file, version: 2 })],
    ['a lock it cannot read', (file: Record<string, unknown>) => ({ ...file, lock: { v: 2 } })],
    ['no key list', (file: Record<string, unknown>) => ({ ...file, keys: 'later' })],
  ])('never writes over a stored file of %s', async (_label, change) => {
    const { keys } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    const raw = JSON.stringify(change(storedFile() as unknown as Record<string, unknown>));
    localStorage.setItem(LS_KEYS.keys, raw);

    expect(keys.list()).toEqual([]);
    const refused = [
      keys.add({ name: 'B', secret: KEY_B }),
      keys.lock.enable('pass phrase'),
      Promise.resolve().then(() =>
        keys.replaceFile({ version: 1, keys: [], lock: null }, { expected: keys.exportFile() }),
      ),
    ];
    for (const attempt of refused) {
      const error: unknown = await attempt.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeysChangedError);
      expect((error as Error).message).toMatch(/newer version/);
    }
    expect(localStorage.getItem(LS_KEYS.keys)).toBe(raw);
    // Reset everything still clears it.
    keys.clear();
    expect(localStorage.getItem(LS_KEYS.keys)).toBeNull();
  });

  it('never writes over a stored file that is not JSON', async () => {
    const { keys } = harness();
    localStorage.setItem(LS_KEYS.keys, '{"version":1,"keys":[');
    const error: unknown = await keys.add({ name: 'A', secret: KEY_A }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeysChangedError);
    expect(localStorage.getItem(LS_KEYS.keys)).toBe('{"version":1,"keys":[');
  });

  it('never reports a key as added when the browser blocks storage', async () => {
    const { keys } = harness();
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const error: unknown = await keys.add({ name: 'A', secret: KEY_A }).catch((e: unknown) => e);
    expect(errorCode(error)).toBe('storage-unavailable');
    vi.restoreAllMocks();
    expect(keys.list()).toEqual([]);
  });

  it('maps GET /key to KeyStatus and caches it for 60 s', async () => {
    vi.useFakeTimers();
    try {
      const { keys, api } = harness();
      const a = await keys.add({ name: 'A', secret: KEY_A });
      const [first] = await Promise.all([keys.status(a.id), keys.status(a.id)]);
      expect(first).toEqual({
        label: 'sk-or-v1-au7...890',
        usageUsd: 25.5,
        usageMonthlyUsd: 25.5,
        limitUsd: 100,
        limitRemainingUsd: 74.5,
        limitReset: 'monthly',
        isFreeTier: false,
        freeDaily: { limit: 50, remaining: 38, used: 12 },
        fetchedAt: Date.now(),
      });
      expect(api.account.key).toHaveBeenCalledTimes(1);
      expect(api.account.key).toHaveBeenCalledWith(KEY_A);
      vi.advanceTimersByTime(59_000);
      await keys.status(a.id);
      expect(api.account.key).toHaveBeenCalledTimes(1);
      await keys.status(a.id, { force: true });
      expect(api.account.key).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(60_000);
      await keys.status(a.id);
      expect(api.account.key).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('passphrase lock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('encrypts every secret, stores a verifier and keeps the tab unlocked', async () => {
    const { keys, events } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const b = await keys.add({ name: 'B', secret: KEY_B });
    await keys.lock.enable('correct horse');
    const file = storedFile();
    expect(file.lock).toMatchObject({ iterations: 1000 });
    expect(typeof file.lock?.salt).toBe('string');
    expect(file.keys.every((k) => k.secret === null && k.enc !== null)).toBe(true);
    expect(localStorage.getItem(LS_KEYS.keys)).not.toContain('sk-or-v1-test');
    const unlocked = JSON.parse(sessionStorage.getItem(SS_KEYS.unlocked) ?? '{}') as {
      key: string;
      at: number;
    };
    expect(typeof unlocked.key).toBe('string');
    expect(keys.lock.enabled()).toBe(true);
    expect(keys.lock.unlocked()).toBe(true);
    expect(await keys.secret(a.id)).toBe(KEY_A);
    expect(await keys.secret(b.id)).toBe(KEY_B);
    expect(events.at(-1)).toEqual({ type: 'keys-changed' });
    const again: unknown = await keys.lock.enable('again').catch((e: unknown) => e);
    expect(again).toBeInstanceOf(InvalidInputError);
    await expect(keys.lock.enable('')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('locks, refuses a wrong passphrase and unlocks with the right one', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass-1');
    const changes = vi.fn();
    keys.subscribe(changes);
    keys.lock.lockNow();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(keys.lock.unlocked()).toBe(false);
    await expect(keys.secret(a.id)).rejects.toBeInstanceOf(KeyLockedError);
    await expect(keys.add({ name: 'B', secret: KEY_B })).rejects.toBeInstanceOf(KeyLockedError);
    expect(await keys.lock.unlock('wrong')).toBe(false);
    expect(keys.lock.unlocked()).toBe(false);
    expect(await keys.lock.unlock('pass-1')).toBe(true);
    expect(await keys.secret(a.id)).toBe(KEY_A);
    // Keys added while unlocked are encrypted too.
    const b = await keys.add({ name: 'B', secret: KEY_B });
    expect(storedFile().keys[1]).toMatchObject({ secret: null });
    expect(await keys.secret(b.id)).toBe(KEY_B);
  });

  it('auto-locks after the configured minutes without touch()', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    vi.useFakeTimers();
    await keys.lock.enable('pass');
    const changes = vi.fn();
    keys.subscribe(changes);

    vi.advanceTimersByTime(10 * 60_000);
    keys.lock.touch();
    vi.advanceTimersByTime(10 * 60_000);
    expect(keys.lock.unlocked()).toBe(true);
    vi.advanceTimersByTime(5 * 60_000);
    expect(keys.lock.unlocked()).toBe(false);
    expect(changes).toHaveBeenCalled();
    await expect(keys.secret(a.id)).rejects.toBeInstanceOf(KeyLockedError);

    // 0 minutes disables auto-lock.
    settings.update((d) => {
      d.security.autoLockMinutes = 0;
    });
    expect(await keys.lock.unlock('pass')).toBe(true);
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(keys.lock.unlocked()).toBe(true);
  });

  it('clamps huge auto-lock settings to 24 h and never overflows setTimeout', async () => {
    const { keys, settings } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    settings.update((d) => {
      d.security.autoLockMinutes = 1e9;
    });
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await keys.lock.enable('pass');
    vi.advanceTimersByTime(23 * 60 * 60_000);
    expect(keys.lock.unlocked()).toBe(true);
    vi.advanceTimersByTime(60 * 60_000);
    expect(keys.lock.unlocked()).toBe(false);
    const delays = spy.mock.calls.map((call) => call[1] ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    // One timer per arm, not a re-arm loop.
    expect(spy.mock.calls.length).toBeLessThan(5);
  });

  it('checks expiry synchronously, even if the timer never ran (e.g. a later page load)', async () => {
    const { keys } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    const stale = JSON.parse(sessionStorage.getItem(SS_KEYS.unlocked) ?? '{}') as { key: string };
    sessionStorage.setItem(
      SS_KEYS.unlocked,
      JSON.stringify({ key: stale.key, at: Date.now() - 16 * 60_000 }),
    );
    const nextPage = harness();
    expect(nextPage.keys.lock.unlocked()).toBe(false);
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
  });

  /** Enables the lock with "old", changes it to "new", and puts the old session back (a tab that missed it). */
  async function staleSession(keys: KeysService): Promise<void> {
    await keys.lock.enable('old');
    const old = sessionStorage.getItem(SS_KEYS.unlocked) ?? '';
    await keys.lock.changePassphrase('old', 'new');
    sessionStorage.setItem(SS_KEYS.unlocked, old);
  }

  it('drops a stale session key at page start', async () => {
    const tab = harness();
    await tab.keys.add({ name: 'A', secret: KEY_A });
    await staleSession(tab.keys);
    const nextPage = harness();
    nextPage.keys.list();
    await vi.waitFor(() => expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull());
    expect(nextPage.keys.lock.unlocked()).toBe(false);
  });

  it('never encrypts a new key with a stale session key', async () => {
    const tab = harness();
    await tab.keys.add({ name: 'A', secret: KEY_A });
    await staleSession(tab.keys);
    const before = localStorage.getItem(LS_KEYS.keys);
    const nextPage = createKeysService(testCore(), { pbkdf2Iterations: 1000 });
    // Skip the page-start check to hit add() with the stale key still in place.
    await expect(nextPage.add({ name: 'B', secret: KEY_B })).rejects.toBeInstanceOf(KeyLockedError);
    expect(localStorage.getItem(LS_KEYS.keys)).toBe(before);
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
  });

  it('changes the passphrase in one write', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const b = await keys.add({ name: 'B', secret: KEY_B });
    await keys.lock.enable('old');
    const before = storedFile();

    await expect(keys.lock.changePassphrase('nope', 'new')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    expect(storedFile()).toEqual(before);

    await keys.lock.changePassphrase('old', 'new');
    const after = storedFile();
    expect(after.lock?.salt).not.toBe(before.lock?.salt);
    expect(after.keys.map((k) => k.enc?.ct)).not.toEqual(before.keys.map((k) => k.enc?.ct));
    expect(keys.lock.unlocked()).toBe(true);
    expect(await keys.secret(a.id)).toBe(KEY_A);
    keys.lock.lockNow();
    expect(await keys.lock.unlock('old')).toBe(false);
    expect(await keys.lock.unlock('new')).toBe(true);
    expect(await keys.secret(b.id)).toBe(KEY_B);
  });

  it('never half-migrates: a change made meanwhile in another tab aborts the rewrite', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('old');
    const otherTab = harness();
    const changing = keys.lock.changePassphrase('old', 'new');
    otherTab.keys.update(a.id, { name: 'Renamed elsewhere' });
    const written = localStorage.getItem(LS_KEYS.keys);
    await expect(changing).rejects.toBeInstanceOf(KeysChangedError);
    expect(localStorage.getItem(LS_KEYS.keys)).toBe(written);
    keys.lock.lockNow();
    expect(await keys.lock.unlock('old')).toBe(true);
    expect(await keys.secret(a.id)).toBe(KEY_A);
  });

  it('disables the lock with the right passphrase only', async () => {
    const { keys } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    await expect(keys.lock.disable('wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(keys.lock.enabled()).toBe(true);
    await keys.lock.disable('pass');
    expect(storedFile()).toMatchObject({ lock: null });
    expect(storedFile().keys[0]).toMatchObject({ secret: KEY_A, enc: null });
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(keys.lock.unlocked()).toBe(true);
    expect(await keys.secret(a.id)).toBe(KEY_A);
    await expect(keys.lock.changePassphrase('a', 'b')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('uses 600k PBKDF2 iterations by default', { timeout: 60_000 }, async () => {
    const { keys } = harness(0);
    await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    expect(storedFile().lock?.iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });
});

describe('backup and reset access', () => {
  it('exports the validated file as a copy', async () => {
    const { keys } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    const exported = keys.exportFile();
    expect(exported).toEqual(storedFile());
    exported.keys[0]!.name = 'mutated';
    expect(storedFile().keys[0]?.name).toBe('A');
  });

  it('replaces the file when nothing changed since the export, and announces it', async () => {
    const { keys, events } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    const expected = keys.exportFile();
    const next: StoredKeysFile = {
      ...expected,
      keys: [{ ...expected.keys[0]!, id: 'restored', name: 'Restored' }],
    };
    const before = events.length;
    keys.replaceFile(next, { expected });
    expect(keys.list().map((k) => k.name)).toEqual(['Restored']);
    expect(events.length).toBe(before + 1);
  });

  it('refuses a file changed since the export, and invalid files', async () => {
    const { keys } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    const expected = keys.exportFile();
    await keys.add({ name: 'B', secret: KEY_B });
    const current = localStorage.getItem(LS_KEYS.keys);
    expect(() => keys.replaceFile(expected, { expected })).toThrow(KeysChangedError);

    const lockedWithPlainSecret = {
      ...expected,
      lock: { salt: 'c2FsdA==', iterations: 1000, verifier: { iv: 'aQ==', ct: 'Yw==' } },
    };
    for (const invalid of [
      lockedWithPlainSecret,
      { ...expected, version: 2 },
      { ...expected, keys: [...expected.keys, ...expected.keys] },
      { version: 1, keys: [{ id: 'x' }], lock: null },
    ]) {
      expect(() => keys.replaceFile(invalid as StoredKeysFile)).toThrow(InvalidInputError);
    }
    expect(localStorage.getItem(LS_KEYS.keys)).toBe(current);
  });

  it('drops this tab’s session when the replacement uses another lock', async () => {
    const { keys } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    const locked = keys.exportFile();
    await keys.lock.disable('pass');
    await keys.lock.enable('other');
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).not.toBeNull();
    keys.replaceFile(locked);
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(await keys.lock.unlock('pass')).toBe(true);
    expect(await keys.secret(keys.list()[0]!.id)).toBe(KEY_A);
  });

  it('clears keys, lock and session', async () => {
    const { keys, events } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    const before = events.length;
    keys.clear();
    expect(localStorage.getItem(LS_KEYS.keys)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(keys.list()).toEqual([]);
    expect(keys.lock.enabled()).toBe(false);
    expect(events.length).toBe(before + 1);
  });
});

describe('settings and data reset', () => {
  afterEach(() => vi.useRealTimers());

  it('re-arms the auto-lock as soon as the setting changes', async () => {
    const { keys, settings } = harness();
    await keys.add({ name: 'A', secret: KEY_A });
    vi.useFakeTimers();
    await keys.lock.enable('pass');
    settings.update((d) => {
      d.security.autoLockMinutes = 0;
    });
    vi.advanceTimersByTime(60 * 60_000);
    expect(keys.lock.unlocked()).toBe(true);
    keys.lock.touch();
    settings.update((d) => {
      d.security.autoLockMinutes = 1;
    });
    vi.advanceTimersByTime(60_000);
    // Locked by the timer itself (no call needed to notice).
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();

    expect(await keys.lock.unlock('pass')).toBe(true);
    settings.update((d) => {
      d.security.autoLockMinutes = 30;
    });
    vi.advanceTimersByTime(10 * 60_000);
    settings.update((d) => {
      d.security.autoLockMinutes = 5;
    });
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
  });

  it('tells subscribers when the default key or a tool binding changes, here or in another tab', async () => {
    const tabA = harness();
    const tabB = harness();
    const here = vi.fn();
    const there = vi.fn();
    tabA.keys.subscribe(here);
    tabB.keys.subscribe(there);
    const a = await tabA.keys.add({ name: 'A', secret: KEY_A });
    const b = await tabA.keys.add({ name: 'B', secret: KEY_B });
    await vi.waitFor(() => expect(tabB.settings.get().defaultKeyId).toBe(a.id));
    here.mockClear();
    there.mockClear();

    tabA.settings.update((d) => {
      d.defaultKeyId = b.id;
    });
    expect(here).toHaveBeenCalled();
    await vi.waitFor(() => expect(there).toHaveBeenCalled());
    expect(tabB.keys.resolve('chat')?.id).toBe(b.id);

    here.mockClear();
    tabA.settings.update((d) => {
      d.tools.ocr = { keyId: a.id };
    });
    expect(here).toHaveBeenCalled();
    here.mockClear();
    tabA.settings.update((d) => {
      d.appearance.density = 'compact';
    });
    expect(here).not.toHaveBeenCalled();
  });

  it('removes settings that point at a removed key', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    const b = await keys.add({ name: 'B', secret: KEY_B });
    settings.update((d) => {
      d.defaultKeyId = b.id;
      d.tools.ocr = { keyId: b.id, model: 'm' };
      d.tools.chat = { keyId: a.id };
      d.budgets.perKeyMonthlyUsd = { [a.id]: 5, [b.id]: 1 };
    });
    keys.remove(b.id);
    const s = settings.get();
    expect(s.defaultKeyId).toBe(a.id);
    expect(s.tools.ocr).toEqual({ model: 'm' });
    expect(s.tools.chat).toEqual({ keyId: a.id });
    expect(s.budgets.perKeyMonthlyUsd).toEqual({ [a.id]: 5 });
    expect(keys.resolve('ocr')?.id).toBe(a.id);
  });

  it('cleans references when replaceFile or clear drops keys', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    await keys.add({ name: 'B', secret: KEY_B });
    const file = keys.exportFile();
    settings.update((d) => {
      d.tools.ocr = { keyId: a.id };
      d.budgets.perKeyMonthlyUsd = { [a.id]: 2 };
    });
    keys.replaceFile({ ...file, keys: file.keys.filter((k) => k.id !== a.id) });
    expect(settings.get().tools.ocr).toEqual({});
    expect(settings.get().budgets.perKeyMonthlyUsd).toEqual({});

    settings.update((d) => {
      d.tools.chat = { keyId: keys.list()[0]!.id };
    });
    keys.clear();
    expect(settings.get().defaultKeyId).toBeNull();
    expect(settings.get().tools.chat).toEqual({});
  });

  it('forgets cached key status on data reset, from any tab', async () => {
    const tabA = harness();
    const tabB = harness();
    const a = await tabA.keys.add({ name: 'A', secret: KEY_A });
    tabA.keys.subscribe(() => undefined);
    await tabA.keys.status(a.id);
    tabB.bus.emit({ type: 'data-reset' });
    await vi.waitFor(async () => {
      await tabA.keys.status(a.id);
      expect(tabA.api.account.key).toHaveBeenCalledTimes(2);
    });
  });
});

describe('other tabs', () => {
  it('notifies subscribers when another tab changes the keys', async () => {
    const tabA = harness();
    const tabB = harness();
    const changes = vi.fn();
    tabB.keys.subscribe(changes);
    await tabA.keys.add({ name: 'A', secret: KEY_A });
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    expect(tabB.keys.list().map((k) => k.name)).toEqual(['A']);
  });

  it("reads the file again when another tab's write arrives after its bus message", async () => {
    const tab = harness();
    await tab.keys.add({ name: 'A', secret: KEY_A });
    const changes = vi.fn();
    tab.keys.subscribe(changes);
    // The other tab's rename lands here later than its keys-changed message (Firefox, WebKit): only the storage
    // event says it arrived.
    const file = storedFile();
    localStorage.setItem(
      LS_KEYS.keys,
      JSON.stringify({ ...file, keys: file.keys.map((key) => ({ ...key, name: 'Renamed' })) }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'ortoolbox:something-else' }));
    window.dispatchEvent(new StorageEvent('storage', { key: LS_KEYS.keys }));
    await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    expect(tab.keys.list().map((key) => key.name)).toEqual(['Renamed']);
  });

  it('drops an unlocked session that no longer opens the file', async () => {
    const tabA = harness();
    const tabB = harness();
    await tabA.keys.add({ name: 'A', secret: KEY_A });
    await tabA.keys.lock.enable('old');
    const tabBSession = sessionStorage.getItem(SS_KEYS.unlocked) ?? '';
    tabB.keys.subscribe(() => undefined);

    await tabA.keys.lock.changePassphrase('old', 'new');
    // Tab B's own sessionStorage still holds the key derived from the old passphrase.
    sessionStorage.setItem(SS_KEYS.unlocked, tabBSession);
    tabA.bus.emit({ type: 'keys-changed' });
    await vi.waitFor(() => expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull());
    expect(tabB.keys.lock.unlocked()).toBe(false);
  });
});
