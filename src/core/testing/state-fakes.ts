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
} from '../types';
import { closeDbForTests } from '../storage/db';
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

/** Web Locks with exclusive locks and `ifAvailable`, shared by every "tab" in the test. */
export class FakeLockManager {
  readonly held = new Set<string>();

  async request(
    name: string,
    options: { ifAvailable?: boolean },
    callback: (lock: { name: string; mode: 'exclusive' } | null) => Promise<unknown>,
  ): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('FakeLockManager only supports ifAvailable requests');
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.held.delete(name);
    }
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

/** Real state services plus fakes for keys (list/get/resolve/lock), models (isFree) and api (unused). */
export function createTestCore(opts: { keys?: KeyInfo[]; locked?: boolean } = {}): TestCore {
  const keyState: KeyState = {
    keys: opts.keys ?? [fakeKey({ id: 'k1', name: 'Work' })],
    locked: opts.locked ?? false,
  };
  const core = {} as CoreServices;

  const get = (id: string | null | undefined): KeyInfo | undefined =>
    keyState.keys.find((key) => key.id === id);
  const keys: Pick<KeysService, 'list' | 'get' | 'resolve' | 'subscribe'> & {
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
  };
  const models: Pick<ModelsService, 'isFree'> = {
    isFree: (id) => id.endsWith(':free') || id === 'openrouter/free',
  };

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
  core.toolState = createToolStateStore;
  return { core, keyState };
}
