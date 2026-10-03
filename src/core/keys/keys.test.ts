import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import keyDocumented from '../../../tests/fixtures/openrouter/key.documented.json';
import { fakeCore, fakeSettings, linkedBuses } from '../api/test-fakes';
import { PBKDF2_ITERATIONS } from '../crypto';
import { KeyLockedError, NoKeyError } from '../errors';
import { LS_KEYS, SS_KEYS } from '../storage/local';
import type { ApiClient, Bus, KeysService, SettingsService, StoredKeysFile } from '../types';
import { InvalidKeyError, keyFormatProblem, maskKey, normalizeKeyInput } from './format';
import { KeysChangedError, WrongPassphraseError, createKeysService } from './keys';

/** Fake keys: the `test`/`x` characters keep them clear of the pre-commit hook's real-key pattern. */
const KEY_A = `sk-or-v1-test${'x'.repeat(56)}a1b2`;
const KEY_B = `sk-or-v1-test${'y'.repeat(56)}c3d4`;

interface Harness {
  keys: KeysService;
  settings: SettingsService;
  bus: Bus & { events: { type: string }[] };
  api: { account: { key: ReturnType<typeof vi.fn> } };
}

function harness(
  overrides: { settings?: SettingsService; bus?: Harness['bus']; iterations?: number } = {},
): Harness {
  const settings = overrides.settings ?? fakeSettings();
  const bus = overrides.bus ?? linkedBuses(1)[0]!;
  const api = { account: { key: vi.fn(() => Promise.resolve(keyDocumented)) } };
  const keys = createKeysService(
    fakeCore({ settings, bus, api: api as unknown as ApiClient }),
    overrides.iterations === 0 ? {} : { pbkdf2Iterations: overrides.iterations ?? 1000 },
  );
  return { keys, settings, bus, api };
}

function storedFile(): StoredKeysFile {
  return JSON.parse(localStorage.getItem(LS_KEYS.keys) ?? 'null') as StoredKeysFile;
}

beforeEach(() => {
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
    await expect(keys.add({ name: 'Bad', secret: 'hello' })).rejects.toBeInstanceOf(
      InvalidKeyError,
    );
    expect(localStorage.getItem(LS_KEYS.keys)).toBeNull();
  });

  it('stores keys, makes the first one default, and never exposes secrets in KeyInfo', async () => {
    const { keys, settings, bus } = harness();
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
    expect(bus.events.filter((e) => e.type === 'keys-changed')).toHaveLength(2);
    expect(changes).toHaveBeenCalledTimes(2);
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

  it('falls back to the first key when the default id is missing (e.g. after a settings reset)', async () => {
    const { keys, settings } = harness();
    const a = await keys.add({ name: 'A', secret: KEY_A });
    settings.reset();
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
  afterEach(() => vi.useRealTimers());

  it('encrypts every secret, stores a verifier and keeps the tab unlocked', async () => {
    const { keys, bus } = harness();
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
    expect(bus.events.at(-1)).toEqual({ type: 'keys-changed' });
    await expect(keys.lock.enable('again')).rejects.toThrow(/already on/);
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
  });

  it('uses 600k PBKDF2 iterations by default', { timeout: 60_000 }, async () => {
    const { keys } = harness({ iterations: 0 });
    await keys.add({ name: 'A', secret: KEY_A });
    await keys.lock.enable('pass');
    expect(storedFile().lock?.iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });
});

describe('other tabs', () => {
  it('notifies subscribers when another tab changes the keys', async () => {
    const [busA, busB] = linkedBuses(2);
    const settings = fakeSettings();
    const tabA = harness({ bus: busA!, settings });
    const tabB = harness({ bus: busB!, settings });
    const changes = vi.fn();
    tabB.keys.subscribe(changes);
    await tabA.keys.add({ name: 'A', secret: KEY_A });
    await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    expect(tabB.keys.list().map((k) => k.name)).toEqual(['A']);
  });

  it('drops an unlocked session that no longer opens the file', async () => {
    const [busA, busB] = linkedBuses(2);
    const settings = fakeSettings();
    const tabA = harness({ bus: busA!, settings });
    const tabB = harness({ bus: busB!, settings });
    await tabA.keys.add({ name: 'A', secret: KEY_A });
    await tabA.keys.lock.enable('old');
    const tabBSession = sessionStorage.getItem(SS_KEYS.unlocked) ?? '';
    tabB.keys.subscribe(() => undefined);

    await tabA.keys.lock.changePassphrase('old', 'new');
    // Tab B's own sessionStorage still holds the key derived from the old passphrase.
    sessionStorage.setItem(SS_KEYS.unlocked, tabBSession);
    busA!.emit({ type: 'keys-changed' });
    await vi.waitFor(() => expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull());
    expect(tabB.keys.lock.unlocked()).toBe(false);
  });
});
