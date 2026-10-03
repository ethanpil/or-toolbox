/**
 * Settings service: localStorage `ortoolbox:settings`, read synchronously when the service is created
 * (page start), validated and repaired on every read and write, and kept in step with other tabs through
 * the `storage` event and the bus.
 */

import type { Bus, CoreServices, Settings, SettingsService } from '../types';
import { LS_KEYS, local, writeJson } from '../storage/local';
import { deepFreeze, deepMerge, jsonCopy } from './merge';
import { SETTINGS_VERSION, defaultSettings, normalizeSettings } from './schema';

export { defaultSettings, normalizeSettings, SETTINGS_VERSION } from './schema';

type Subscriber = (next: Readonly<Settings>, prev: Readonly<Settings>) => void;

function readRaw(): string | null {
  try {
    return local()?.getItem(LS_KEYS.settings) ?? null;
  } catch {
    return null;
  }
}

function parse(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null; // corrupt: the validator falls back to defaults
  }
}

export function createSettingsService(core: CoreServices): SettingsService {
  let raw = readRaw();
  const parsed = parse(raw);
  let current: Readonly<Settings> = deepFreeze(normalizeSettings(parsed));
  const subscribers = new Set<Subscriber>();

  // Persist migrations from an older schema right away, so every page reads the current shape.
  const storedVersion = (parsed as { version?: unknown } | null)?.version;
  if (raw != null && !(typeof storedVersion === 'number' && storedVersion >= SETTINGS_VERSION)) {
    try {
      writeJson(local(), LS_KEYS.settings, current);
      raw = JSON.stringify(current);
    } catch {
      // Storage full or blocked: keep the migrated copy in memory only.
    }
  }

  const notify = (next: Readonly<Settings>, prev: Readonly<Settings>): void => {
    for (const fn of [...subscribers]) {
      try {
        fn(next, prev);
      } catch (error) {
        console.error(error);
      }
    }
  };

  /** Another tab (or a backup import / reset) changed storage: adopt it if it differs. */
  const reload = (): void => {
    const nextRaw = readRaw();
    if (nextRaw === raw) return;
    raw = nextRaw;
    const next = deepFreeze(normalizeSettings(parse(nextRaw)));
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    const prev = current;
    current = next;
    notify(next, prev);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      // key === null: the other tab cleared the whole storage.
      if (event.key === LS_KEYS.settings || event.key === null) reload();
    });
  }

  let wired = false;
  const ensureWired = (): void => {
    if (wired) return;
    const bus = core.bus as Bus | undefined; // absent only while the composition root is still wiring
    if (!bus) return;
    wired = true;
    bus.on('settings-changed', reload);
    bus.on('data-reset', reload);
  };

  const commit = (next: Settings): Readonly<Settings> => {
    const json = JSON.stringify(next);
    if (json === JSON.stringify(current)) return current;
    writeJson(local(), LS_KEYS.settings, next); // throws StorageFullError; nothing changes then
    raw = json;
    const prev = current;
    current = deepFreeze(next);
    notify(current, prev);
    core.bus.emit({ type: 'settings-changed' });
    return current;
  };

  const update = (mutate: (draft: Settings) => void): Readonly<Settings> => {
    ensureWired();
    const draft = structuredClone(current) as Settings;
    mutate(draft);
    return commit(normalizeSettings(draft));
  };

  return {
    get() {
      ensureWired();
      return current;
    },
    update,
    reset() {
      ensureWired();
      // Keys are not affected, and the default key is part of the keys setup.
      commit(normalizeSettings({ ...defaultSettings(), defaultKeyId: current.defaultKeyId }));
    },
    subscribe(fn) {
      ensureWired();
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    toolOptions<T extends Record<string, unknown> = Record<string, unknown>>(
      tool: Parameters<SettingsService['toolOptions']>[0],
    ): T {
      const saved = current.tools[tool.id]?.options ?? {};
      return deepMerge(jsonCopy(tool.defaults), jsonCopy(saved)) as T;
    },
    setToolOptions(tool, options) {
      update((draft) => {
        draft.tools[tool] = { ...draft.tools[tool], options: jsonCopy(options) };
      });
    },
  };
}
