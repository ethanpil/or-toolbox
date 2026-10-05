import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsService, defaultSettings, normalizeSettings, SETTINGS_VERSION } from '.';
import { deepMerge } from './merge';
import { MAX_MONTHLY_USD, MAX_PER_RUN_USD, MAX_RETENTION_DAYS } from './schema';
import { createBus } from '../bus';
import type { CoreServices, Settings, ToolManifest } from '../types';
import { LS_KEYS } from '../storage/local';
import { StorageFullError } from '../storage/local';
import { FakeBroadcastChannel } from '../testing/state-fakes';

/** A "tab": its own bus and settings service, sharing localStorage with other tabs. */
function tab() {
  const core = {} as CoreServices;
  core.bus = createBus();
  core.settings = createSettingsService(core);
  return core;
}

const stored = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(LS_KEYS.settings) ?? 'null') as Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  FakeBroadcastChannel.reset();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('defaults and validation', () => {
  it('ships the agreed defaults', () => {
    const d = defaultSettings();
    expect(d.budgets).toEqual({
      mode: 'warn',
      perRunUsd: 0.1,
      monthlyUsd: null,
      perKeyMonthlyUsd: {},
    });
    expect(d.data).toEqual({ retentionDays: 90, recordRecentPrompts: true });
    expect(d.security.autoLockMinutes).toBe(15);
    expect(d.appearance.theme).toBe('system');
    expect(d.freeOnly).toBe(false);
    expect(d.version).toBe(SETTINGS_VERSION);
  });

  it('returns defaults when nothing is stored, as a frozen snapshot', () => {
    const { settings } = tab();
    expect(settings.get()).toEqual(defaultSettings());
    expect(Object.isFrozen(settings.get())).toBe(true);
    expect(Object.isFrozen(settings.get().budgets)).toBe(true);
  });

  it('falls back to defaults for unparsable JSON instead of throwing', () => {
    localStorage.setItem(LS_KEYS.settings, '{not json');
    expect(tab().settings.get()).toEqual(defaultSettings());
  });

  it('repairs each invalid field and keeps the valid ones', () => {
    const repaired = normalizeSettings({
      version: 1,
      onboarding: { completed: 'yes' },
      favoriteTools: ['chat', 'nope', 'chat', 7, 'ocr'],
      defaultKeyId: 42,
      defaultModels: { text: 'openai/gpt-x', bogus: 'x', image: '' },
      freeOnly: true,
      tools: {
        chat: { model: 'm', keyId: '', options: { a: 1, f: () => 1 } },
        unknown: { model: 'm' },
        ocr: 'broken',
      },
      budgets: {
        mode: 'panic',
        perRunUsd: -1,
        monthlyUsd: 25,
        perKeyMonthlyUsd: { k1: 5, k2: null, k3: 'x', k4: -2 },
      },
      appearance: { theme: 'neon', accent: '#ABCDEF', density: 'compact', reducedMotion: 1 },
      data: { retentionDays: 'forever', recordRecentPrompts: false },
      security: { autoLockMinutes: Number.NaN },
      models: {
        favorites: ['a', 'a', '', 3],
        recent: Array.from({ length: 30 }, (_, i) => `m${i}`),
      },
      ui: { 'home.view': 'grid' },
      extra: 'dropped',
    });

    expect(repaired).toEqual<Settings>({
      version: 1,
      onboarding: { completed: false },
      favoriteTools: ['chat', 'ocr'],
      defaultKeyId: null,
      defaultModels: { text: 'openai/gpt-x' },
      freeOnly: true,
      tools: { chat: { model: 'm', options: { a: 1 } } },
      budgets: {
        mode: 'warn',
        perRunUsd: 0, // clamped
        monthlyUsd: 25,
        perKeyMonthlyUsd: { k1: 5, k2: null, k4: 0 },
      },
      appearance: { theme: 'system', accent: '#abcdef', density: 'compact', reducedMotion: false },
      data: { retentionDays: 90, recordRecentPrompts: false },
      security: { autoLockMinutes: 15 },
      models: { favorites: ['a'], recent: Array.from({ length: 20 }, (_, i) => `m${i}`) },
      ui: { 'home.view': 'grid' },
    });
  });

  it('reads favorites saved under the older spelling', () => {
    const settings = normalizeSettings({
      version: 1,
      favouriteTools: ['chat'],
      models: { favourites: ['a/b'] },
    });
    expect(settings.favoriteTools).toEqual(['chat']);
    expect(settings.models.favorites).toEqual(['a/b']);
  });

  it('clamps numbers to sane ranges', () => {
    const clamp = (budgets: object, data: object, security: object) =>
      normalizeSettings({ version: 1, budgets, data, security });
    const low = clamp(
      { perRunUsd: -5, monthlyUsd: -1, perKeyMonthlyUsd: { k: -3 } },
      { retentionDays: 0 },
      { autoLockMinutes: -5 },
    );
    expect(low.budgets).toMatchObject({ perRunUsd: 0, monthlyUsd: 0, perKeyMonthlyUsd: { k: 0 } });
    expect(low.data.retentionDays).toBe(1);
    expect(low.security.autoLockMinutes).toBe(0); // 0 = never auto-lock

    const high = clamp(
      { perRunUsd: 1e12, monthlyUsd: 1e12, perKeyMonthlyUsd: { k: 1e12 } },
      { retentionDays: 1e9 },
      { autoLockMinutes: 1e9 },
    );
    expect(high.budgets).toMatchObject({
      perRunUsd: MAX_PER_RUN_USD,
      monthlyUsd: MAX_MONTHLY_USD,
      perKeyMonthlyUsd: { k: MAX_MONTHLY_USD },
    });
    expect(high.data.retentionDays).toBe(MAX_RETENTION_DAYS);
    expect(high.security.autoLockMinutes).toBe(1440);
  });

  it('never copies prototype keys from stored or imported data', () => {
    const hostile = JSON.parse(
      `{"version":1,
        "budgets":{"perKeyMonthlyUsd":{"__proto__":{"polluted":1},"constructor":5,"k1":5}},
        "tools":{"chat":{"options":{"__proto__":{"polluted":1},"a":1}}},
        "ui":{"__proto__":{"polluted":1},"nested":{"prototype":{"x":1},"ok":true}}}`,
    ) as unknown;
    const settings = normalizeSettings(hostile);
    const perKey = settings.budgets.perKeyMonthlyUsd;
    expect(Object.getPrototypeOf(perKey)).toBe(Object.prototype);
    expect(Object.keys(perKey)).toEqual(['k1']);
    expect(Object.getPrototypeOf(settings.tools.chat?.options)).toBe(Object.prototype);
    expect(settings.tools.chat?.options).toEqual({ a: 1 });
    expect(Object.getPrototypeOf(settings.ui)).toBe(Object.prototype);
    expect(settings.ui).toEqual({ nested: { ok: true } });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    const merged = deepMerge(
      { a: { b: 1 } },
      JSON.parse('{"__proto__":{"polluted":1},"a":{"constructor":{"x":1},"c":2}}') as Record<
        string,
        unknown
      >,
    );
    expect(merged).toEqual({ a: { b: 1, c: 2 } });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
  });

  it('fills a partial object from defaults', () => {
    const partial = normalizeSettings({ version: 1, appearance: { theme: 'dark' } });
    expect(partial).toEqual({
      ...defaultSettings(),
      appearance: { ...defaultSettings().appearance, theme: 'dark' },
    });
  });

  it('migrates unversioned data and persists the current version at page start', () => {
    localStorage.setItem(LS_KEYS.settings, JSON.stringify({ freeOnly: true }));
    const { settings } = tab();
    expect(settings.get().freeOnly).toBe(true);
    expect(stored()).toMatchObject({ version: SETTINGS_VERSION, freeOnly: true });
  });

  it('does not rewrite current-version data at page start', () => {
    const raw = JSON.stringify({ version: SETTINGS_VERSION, freeOnly: true });
    localStorage.setItem(LS_KEYS.settings, raw);
    tab();
    expect(localStorage.getItem(LS_KEYS.settings)).toBe(raw);
  });
});

describe('update, reset, subscribe', () => {
  it('persists, notifies with next and prev, and broadcasts', () => {
    const core = tab();
    const fn = vi.fn();
    const busFn = vi.fn();
    core.settings.subscribe(fn);
    core.bus.on('settings-changed', busFn);

    const next = core.settings.update((draft) => {
      draft.freeOnly = true;
    });

    expect(next.freeOnly).toBe(true);
    expect(core.settings.get()).toBe(next);
    expect(stored()).toMatchObject({ freeOnly: true });
    expect(fn).toHaveBeenCalledOnce();
    const [n, p] = fn.mock.calls[0] as [Settings, Settings];
    expect(n.freeOnly).toBe(true);
    expect(p.freeOnly).toBe(false);
    expect(busFn).toHaveBeenCalledOnce();
  });

  it('keeps appearance.theme where public/theme-init.js reads it', () => {
    tab().settings.update((draft) => {
      draft.appearance.theme = 'dark';
    });
    expect((stored()['appearance'] as { theme: string }).theme).toBe('dark');
  });

  it('validates the mutated draft', () => {
    const next = tab().settings.update((draft) => {
      draft.budgets.perRunUsd = -5;
      (draft.appearance as { theme: string }).theme = 'neon';
    });
    expect(next.budgets.perRunUsd).toBe(0); // clamped
    expect(next.appearance.theme).toBe('system');
  });

  it('does nothing for an update that changes nothing', () => {
    const core = tab();
    const fn = vi.fn();
    core.settings.subscribe(fn);
    core.settings.update(() => undefined);
    expect(fn).not.toHaveBeenCalled();
    expect(localStorage.getItem(LS_KEYS.settings)).toBeNull();
  });

  it('leaves memory untouched when storage is full', () => {
    const core = tab();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() =>
      core.settings.update((draft) => {
        draft.freeOnly = true;
      }),
    ).toThrow(StorageFullError);
    expect(core.settings.get().freeOnly).toBe(false);
  });

  it('resets to defaults but keeps the default key', () => {
    const { settings } = tab();
    settings.update((draft) => {
      draft.defaultKeyId = 'k1';
      draft.freeOnly = true;
      draft.appearance.theme = 'dark';
    });
    settings.reset();
    expect(settings.get()).toEqual({ ...defaultSettings(), defaultKeyId: 'k1' });
  });

  it('stops notifying after unsubscribe', () => {
    const { settings } = tab();
    const fn = vi.fn();
    settings.subscribe(fn)();
    settings.update((draft) => {
      draft.freeOnly = true;
    });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('tool options', () => {
  const manifest = {
    id: 'isolated-image',
    defaults: { size: 2000, format: 'jpg', advanced: { margin: 0.08, threshold: 245 } },
  } as unknown as ToolManifest;

  it('returns the manifest defaults when nothing is saved', () => {
    expect(tab().settings.toolOptions(manifest)).toEqual(manifest.defaults);
  });

  it('deep-merges saved options over the manifest defaults', () => {
    const { settings } = tab();
    settings.setToolOptions('isolated-image', { format: 'png', advanced: { threshold: 250 } });
    expect(settings.toolOptions(manifest)).toEqual({
      size: 2000,
      format: 'png',
      advanced: { margin: 0.08, threshold: 250 },
    });
  });

  it('returns a detached, mutable copy', () => {
    const { settings } = tab();
    const options = settings.toolOptions<{ advanced: { margin: number } }>(manifest);
    options.advanced.margin = 1;
    expect(settings.toolOptions(manifest)).toEqual(manifest.defaults);
  });

  it('keeps the rest of the tool binding when saving options', () => {
    const { settings } = tab();
    settings.update((draft) => {
      draft.tools.chat = { model: 'm1', keyId: 'k1' };
    });
    settings.setToolOptions('chat', { temperature: 0.2 });
    expect(settings.get().tools.chat).toEqual({
      model: 'm1',
      keyId: 'k1',
      options: { temperature: 0.2 },
    });
  });
});

describe('cross-tab', () => {
  it('picks up a change from another tab through the bus', async () => {
    const a = tab();
    const b = tab();
    const fn = vi.fn();
    b.settings.subscribe(fn);

    a.settings.update((draft) => {
      draft.appearance.theme = 'dark';
    });
    await Promise.resolve();

    expect(b.settings.get().appearance.theme).toBe('dark');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('picks up a change from the storage event alone', () => {
    const b = tab();
    const fn = vi.fn();
    b.settings.subscribe(fn);
    const raw = JSON.stringify({ ...defaultSettings(), freeOnly: true });
    localStorage.setItem(LS_KEYS.settings, raw);
    window.dispatchEvent(new StorageEvent('storage', { key: LS_KEYS.settings, newValue: raw }));
    expect(b.settings.get().freeOnly).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('notifies once when both the storage event and the bus arrive', async () => {
    const a = tab();
    const b = tab();
    const fn = vi.fn();
    b.settings.subscribe(fn);
    a.settings.update((draft) => {
      draft.freeOnly = true;
    });
    window.dispatchEvent(new StorageEvent('storage', { key: LS_KEYS.settings }));
    await Promise.resolve();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('returns to defaults after a data reset in another tab', async () => {
    const a = tab();
    const b = tab();
    b.settings.update((draft) => {
      draft.freeOnly = true;
    });
    localStorage.removeItem(LS_KEYS.settings);
    a.bus.emit({ type: 'data-reset' });
    await Promise.resolve();
    expect(b.settings.get()).toEqual(defaultSettings());
  });

  it('applies an update on top of a change another tab made moments before', () => {
    const a = tab();
    // Another tab wrote, but neither its storage event nor its bus message has arrived yet.
    localStorage.setItem(
      LS_KEYS.settings,
      JSON.stringify({
        ...defaultSettings(),
        appearance: { ...defaultSettings().appearance, theme: 'dark' },
      }),
    );
    a.settings.update((draft) => {
      draft.freeOnly = true;
    });
    expect(stored()).toMatchObject({ freeOnly: true, appearance: { theme: 'dark' } });
    expect(a.settings.get().appearance.theme).toBe('dark');
  });

  it.each([
    [
      'pageshow from the back/forward cache',
      () => new PageTransitionEvent('pageshow', { persisted: true }),
    ],
    ['visibilitychange to visible', () => new Event('visibilitychange')],
  ])('re-syncs from storage on %s', (_label, event) => {
    const a = tab();
    const fn = vi.fn();
    a.settings.subscribe(fn);
    localStorage.setItem(
      LS_KEYS.settings,
      JSON.stringify({ ...defaultSettings(), freeOnly: true }),
    );
    const target = event().type === 'visibilitychange' ? document : window;
    target.dispatchEvent(event());
    expect(a.settings.get().freeOnly).toBe(true);
    expect(fn).toHaveBeenCalledOnce();
  });
});
