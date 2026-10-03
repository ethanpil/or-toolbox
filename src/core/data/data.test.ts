import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BusEvent, CoreServices } from '../types';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS } from '../storage/local';
import { defaultSettings } from '../settings';
import { createTestCore, isolateChannels, resetDb } from '../testing/state-fakes';

let core: CoreServices;
let events: BusEvent['type'][];

async function populate(): Promise<void> {
  localStorage.setItem(LS_KEYS.keys, '{"version":1,"keys":[],"lock":null}');
  for (const tool of ['chat', 'ocr'] as const) {
    const run = await core.runs.begin({ tool, model: 'm/x', prompt: `${tool} prompt` });
    await run.finish({ output: 'out' });
    await core.prompts.save({ tool, text: `${tool} saved`, settings: {} });
  }
  await core.jobs.add({ tool: 'video-studio', type: 'video', payload: {}, keyId: 'k1' });
  await core.toolState('chat').set('thread', { messages: [] });
  const db = await getDb();
  await db.put('kv', { key: 'models:catalog', value: [], updatedAt: 1 });
  await db.put('kv', { key: 'meta:lastPrune', value: 1, updatedAt: 1 });
  core.settings.update((d) => {
    d.freeOnly = true;
  });
}

async function counts() {
  const db = await getDb();
  return {
    runs: await db.count('runs'),
    prompts: await db.count('prompts'),
    jobs: await db.count('jobs'),
    stats: await db.count('stats'),
    kv: (await db.getAllKeys('kv')).sort(),
  };
}

const setStorageManager = (value: unknown): void => {
  Object.defineProperty(navigator, 'storage', { value, configurable: true });
};

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  sessionStorage.clear();
  core = createTestCore().core;
  await populate();
  events = [];
  for (const type of [
    'settings-changed',
    'keys-changed',
    'history-changed',
    'prompts-changed',
    'stats-changed',
    'jobs-changed',
    'data-reset',
  ] as const) {
    core.bus.on(type, (event) => events.push(event.type));
  }
});
afterEach(() => setStorageManager(undefined));

describe('storage estimate', () => {
  it('reports usage and quota', async () => {
    setStorageManager({ estimate: () => Promise.resolve({ usage: 1234, quota: 5678 }) });
    expect(await core.data.storage()).toEqual({ usedBytes: 1234, quotaBytes: 5678 });
  });

  it('reports nulls without a StorageManager', async () => {
    setStorageManager(undefined);
    expect(await core.data.storage()).toEqual({ usedBytes: null, quotaBytes: null });
  });
});

describe('deletion', () => {
  it('deletes one tool’s history and prompts only', async () => {
    await core.data.deleteToolData('chat');
    expect((await core.history.query()).map((r) => r.tool)).toEqual(['ocr']);
    expect(await core.prompts.counts()).toEqual({ ocr: { recent: 1, saved: 1 } });
    expect((await counts()).stats).toBe(2); // stats rows survive
  });

  it('deletes all prompts, history, jobs and tool state, keeping keys, settings and stats', async () => {
    await core.data.deleteAllPromptsAndHistory();
    expect(await counts()).toEqual({
      runs: 0,
      prompts: 0,
      jobs: 0,
      stats: 2, // the budget ledger survives
      kv: ['meta:lastPrune', 'models:catalog'],
    });
    expect(core.settings.get().freeOnly).toBe(true);
    expect(localStorage.getItem(LS_KEYS.keys)).not.toBeNull();
    expect(events).toEqual(['history-changed', 'prompts-changed', 'jobs-changed']);
  });

  it('resets everything, including keys, settings and session secrets', async () => {
    sessionStorage.setItem(SS_KEYS.unlocked, 'material');
    sessionStorage.setItem(SS_KEYS.oauth, 'verifier');
    sessionStorage.setItem('ortoolbox:isolation-reload', '1');

    await core.data.resetEverything();

    expect(await counts()).toEqual({ runs: 0, prompts: 0, jobs: 0, stats: 0, kv: [] });
    expect(localStorage.getItem(LS_KEYS.settings)).toBeNull();
    expect(localStorage.getItem(LS_KEYS.keys)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBeNull();
    expect(sessionStorage.getItem('ortoolbox:isolation-reload')).toBe('1');
    expect(core.settings.get()).toEqual(defaultSettings());
    expect(events).toEqual(['settings-changed', 'keys-changed', 'data-reset']);
  });
});
