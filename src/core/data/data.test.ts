import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent, CoreServices, JobRecord } from '../types';
import { getDb } from '../storage/db';
import { LS_KEYS, SS_KEYS } from '../storage/local';
import { defaultSettings } from '../settings';
import { createTestCore, isolateChannels, resetDb, until } from '../testing/state-fakes';

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
    for (const key of Object.values(LS_KEYS)) localStorage.setItem(key, '"x"');
    for (const key of Object.values(SS_KEYS)) sessionStorage.setItem(key, 'x');
    localStorage.setItem('unrelated-site-key', 'kept');
    const clearKeys = vi.spyOn(core.keys, 'clear');

    await core.data.resetEverything();

    expect(clearKeys).toHaveBeenCalledOnce();
    expect(await counts()).toEqual({ runs: 0, prompts: 0, jobs: 0, stats: 0, kv: [] });
    for (const key of Object.values(LS_KEYS)) expect(localStorage.getItem(key)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.unlocked)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.oauth)).toBeNull();
    expect(sessionStorage.getItem(SS_KEYS.isolationReload)).toBe('x'); // the reload-loop guard stays
    expect(localStorage.getItem('unrelated-site-key')).toBe('kept');
    expect(core.settings.get()).toEqual(defaultSettings());
    expect(events).toEqual(['keys-changed', 'settings-changed', 'jobs-changed', 'data-reset']);
  });

  it('stops live work: running runs abort without booking, polling stops, jobs report removal', async () => {
    core.settings.update((d) => {
      d.freeOnly = false;
    });
    const run = await core.runs.begin({ tool: 'chat', model: 'm/x', prompt: 'still going' });
    run.addUsage({
      model: 'm/x',
      promptTokens: 1,
      completionTokens: 1,
      costUsd: 0.5,
      costEstimated: false,
      latencyMs: 1,
    });
    const poll = vi.fn(() => Promise.resolve({ state: 'running' as const }));
    core.jobs.register('video', { poll, intervalMs: 50 });
    const [job] = await core.jobs.list();
    const seen: JobRecord[] = [];
    core.jobs.subscribe((j) => seen.push(j));
    core.jobs.resume();
    await until(() => poll.mock.calls.length > 0);

    await core.data.resetEverything();
    expect(run.signal.aborted).toBe(true);
    await run.finish({ output: 'late' }); // the tool did not notice the reset
    const calls = poll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(poll.mock.calls.length).toBe(calls);
    expect(await counts()).toEqual({ runs: 0, prompts: 0, jobs: 0, stats: 0, kv: [] });
    expect(core.runs.active()).toEqual([]);
    await until(() => seen.some((j) => j.removed));
    expect(seen.filter((j) => j.removed)).toEqual([
      expect.objectContaining({ id: job!.id, state: 'cancelled', removed: true }),
    ]);
  });

  it('reports a removed job to subscribers', async () => {
    const [job] = await core.jobs.list();
    const seen: JobRecord[] = [];
    core.jobs.subscribe((j) => seen.push(j));
    await core.jobs.remove(job!.id);
    await until(() => seen.length > 0);
    expect(seen).toEqual([{ ...job, state: 'cancelled', removed: true }]);
  });
});
