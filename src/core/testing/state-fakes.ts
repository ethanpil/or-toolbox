/**
 * Test support for the core state services (bus, settings, runs, history, prompts, jobs, stats, results,
 * backup, data). Import only from `*.test.ts`. Tests that use it start with `import 'fake-indexeddb/auto'`.
 *
 * `createTestCore()` wires the real services the way the composition root will (an empty object filled in
 * afterwards, so every factory must read its dependencies lazily) plus small fakes for the parts of keys,
 * models and the API client that these services call.
 */

import { IDBFactory } from 'fake-indexeddb';
import type {
  ApiClient,
  CoreServices,
  KeyInfo,
  KeysService,
  ModelsService,
  OAuthService,
  StoredKeysFile,
} from '../types';
import { InvalidInputError, KeysChangedError } from '../errors';
import { isFreeModelId } from '../models/free';
import { closeDbForTests } from '../storage/db';
import {
  LS_KEYS,
  SS_KEYS,
  local,
  readJson,
  removeItem,
  session,
  writeJson,
} from '../storage/local';
import { createBus } from '../bus';
import { createSettingsService } from '../settings';
import { createBudgetsService } from '../budgets';
import { createRunsService } from '../runs';
import { createHistoryService } from '../history';
import { createPromptsService } from '../prompts';
import { createJobsService } from '../jobs';
import { createStatsService } from '../stats';
import { createResultsService } from '../results';
import { createToolStateStore } from '../tool-state';
import { createBackupService } from '../backup';
import { createDataService } from '../data';

/** A fresh, empty IndexedDB for the next test. */
export async function resetDb(): Promise<void> {
  await closeDbForTests();
  globalThis.indexedDB = new IDBFactory();
}

/**
 * Node's setImmediate (tests run in Node; the app's DOM typings do not declare it). fake-indexeddb
 * schedules with it, and tests never fake it, so waiting on it works under fake timers too.
 */
const nextMacrotask = (): Promise<void> =>
  new Promise((resolve) =>
    (globalThis as unknown as { setImmediate: (fn: () => void) => void }).setImmediate(resolve),
  );

/** Lets fake-indexeddb and pending promises settle. */
export async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await nextMacrotask();
}

/** Waits (on real macrotask ticks, so it also works under fake timers) until `check` is true. */
export async function until(check: () => boolean | Promise<boolean>, rounds = 2000): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await check()) return;
    await nextMacrotask();
  }
  throw new Error('until(): condition not met');
}

/** In-process BroadcastChannel: instances with the same name deliver to each other, never to themselves. */
export class FakeBroadcastChannel {
  static readonly channels = new Map<string, Set<FakeBroadcastChannel>>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly name: string;
  private closed = false;

  constructor(name: string) {
    this.name = name;
    let set = FakeBroadcastChannel.channels.get(name);
    if (!set) FakeBroadcastChannel.channels.set(name, (set = new Set()));
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException('Channel is closed', 'InvalidStateError');
    for (const other of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (other === this) continue;
      const copy = structuredClone(data);
      queueMicrotask(() => other.onmessage?.(new MessageEvent('message', { data: copy })));
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }

  /** Disconnects every existing instance (earlier tests' "tabs"); new ones start a fresh network. */
  static reset(): void {
    for (const set of FakeBroadcastChannel.channels.values()) {
      for (const channel of set) channel.closed = true;
    }
    FakeBroadcastChannel.channels.clear();
  }
}

/**
 * Call in `beforeEach` of every test that creates services: isolates this test's "tabs" from buses that
 * earlier tests created (the real Node BroadcastChannel would connect them all).
 */
export function isolateChannels(): void {
  FakeBroadcastChannel.reset();
  globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
}

type FakeLockCallback = (lock: { name: string; mode: 'exclusive' } | null) => unknown;

/**
 * Web Locks with exclusive locks, shared by every "tab" in the test. `ifAvailable` requests get `null` when
 * the lock is held; other requests wait in line. `release(name)` frees a lock as if its tab had closed.
 */
export class FakeLockManager {
  readonly held = new Set<string>();
  private readonly waiting = new Map<string, (() => void)[]>();

  async request(
    name: string,
    optionsOrCallback: { ifAvailable?: boolean } | FakeLockCallback,
    maybeCallback?: FakeLockCallback,
  ): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(name) ?? [];
        queue.push(resolve);
        this.waiting.set(name, queue);
      });
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.release(name);
    }
  }

  /** Frees `name` and hands it to the next waiter, if any. */
  release(name: string): void {
    const next = this.waiting.get(name)?.shift();
    if (next) next();
    else this.held.delete(name);
  }
}

export function fakeKey(partial: Partial<KeyInfo> & { id: string }): KeyInfo {
  return {
    name: partial.id,
    colour: null,
    masked: 'sk-or-…test',
    source: 'pasted',
    createdAt: 0,
    noRetention: false,
    isDefault: false,
    ...partial,
  };
}

export interface KeyState {
  keys: KeyInfo[];
  locked: boolean;
}

export interface TestCore {
  core: CoreServices;
  keyState: KeyState;
}

const EMPTY_KEYS_FILE: StoredKeysFile = { version: 1, keys: [], lock: null };

/**
 * Real state services plus fakes for keys (list/get/resolve/lock, and the backup/reset file operations on
 * localStorage `ortoolbox:keys`), models (isFree) and api (unused).
 */
export function createTestCore(opts: { keys?: KeyInfo[]; locked?: boolean } = {}): TestCore {
  const keyState: KeyState = {
    keys: opts.keys ?? [fakeKey({ id: 'k1', name: 'Work' })],
    locked: opts.locked ?? false,
  };
  const core = {} as CoreServices;

  const get = (id: string | null | undefined): KeyInfo | undefined =>
    keyState.keys.find((key) => key.id === id);
  const storedFile = (): StoredKeysFile => {
    const file = readJson<StoredKeysFile>(local(), LS_KEYS.keys);
    return file && Array.isArray(file.keys) ? file : EMPTY_KEYS_FILE;
  };
  const keys: Pick<
    KeysService,
    'list' | 'get' | 'resolve' | 'subscribe' | 'exportFile' | 'replaceFile' | 'clear'
  > & {
    lock: Pick<KeysService['lock'], 'enabled' | 'unlocked'>;
  } = {
    list: () => keyState.keys,
    get,
    resolve: (tool, override) =>
      get(override) ??
      get(tool ? core.settings.get().tools[tool]?.keyId : undefined) ??
      get(core.settings.get().defaultKeyId) ??
      keyState.keys[0] ??
      null,
    subscribe: () => () => undefined,
    lock: { enabled: () => keyState.locked, unlocked: () => !keyState.locked },
    exportFile: storedFile,
    replaceFile(next, { expected } = {}) {
      if (next.version !== 1 || !Array.isArray(next.keys)) {
        throw new InvalidInputError('The keys file is not valid.');
      }
      const current = storedFile();
      if (expected && JSON.stringify(expected) !== JSON.stringify(current)) {
        throw new KeysChangedError();
      }
      writeJson(local(), LS_KEYS.keys, next);
      if (JSON.stringify(current.lock) !== JSON.stringify(next.lock)) {
        removeItem(session(), SS_KEYS.unlocked);
      }
      core.bus.emit({ type: 'keys-changed' });
    },
    clear() {
      removeItem(local(), LS_KEYS.keys);
      removeItem(session(), SS_KEYS.unlocked);
      core.bus.emit({ type: 'keys-changed' });
    },
  };
  const models: Pick<ModelsService, 'isFree'> = { isFree: isFreeModelId };

  core.bus = createBus();
  core.settings = createSettingsService(core);
  core.keys = keys as unknown as KeysService;
  core.oauth = {} as OAuthService;
  core.models = models as unknown as ModelsService;
  core.api = {} as ApiClient;
  core.budgets = createBudgetsService(core);
  core.runs = createRunsService(core);
  core.history = createHistoryService(core);
  core.prompts = createPromptsService(core);
  core.jobs = createJobsService(core);
  core.stats = createStatsService(core);
  core.results = createResultsService(core);
  core.backup = createBackupService(core);
  core.data = createDataService(core);
  core.toolState = (tool) => createToolStateStore(tool, core.bus);
  return { core, keyState };
}
