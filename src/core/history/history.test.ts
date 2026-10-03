import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreServices, PromptEntry, RunRecord } from '../types';
import { getDb } from '../storage/db';
import { createTestCore, isolateChannels, resetDb } from '../testing/state-fakes';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12);

let core: CoreServices;

function run(n: number, partial: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `r${n}`,
    tool: 'chat',
    status: 'ok',
    model: 'openai/gpt-x',
    models: ['openai/gpt-x'],
    keyId: 'k1',
    keyName: 'Work',
    startedAt: NOW - 1000 * (100 - n),
    finishedAt: NOW,
    latencyMs: 10,
    title: `Run ${n}`,
    prompt: null,
    settings: null,
    output: null,
    error: null,
    usage: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMsTotal: 0,
      costEstimated: false,
      costUnknown: false,
      byModel: {},
    },
    reservedUsd: 0,
    jobId: null,
    meta: {},
    starred: false,
    groupId: null,
    ...partial,
  };
}

async function put(...runs: RunRecord[]): Promise<void> {
  const db = await getDb();
  for (const r of runs) await db.put('runs', r);
}

const ids = (runs: RunRecord[]): string[] => runs.map((r) => r.id);

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  core = createTestCore().core;
});
afterEach(() => vi.useRealTimers());

describe('query', () => {
  beforeEach(async () => {
    await put(
      run(1),
      run(2, { tool: 'ocr', status: 'error', model: 'mistral/ocr', models: ['mistral/ocr'] }),
      run(3, { starred: true, prompt: 'Find the INVOICE total' }),
      run(4, { tool: 'ocr', output: 'Invoice #42', keyId: 'k2' }),
      run(5, { models: ['openai/gpt-x', 'anthropic/claude-x'], title: 'Arena' }),
    );
  });

  it('returns newest first, 50 by default', async () => {
    expect(ids(await core.history.query())).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    await put(...Array.from({ length: 60 }, (_, i) => run(10 + i, { id: `bulk${i}` })));
    expect(await core.history.query()).toHaveLength(50);
  });

  it('paginates with the before cursor', async () => {
    const page1 = await core.history.query({ limit: 2 });
    expect(ids(page1)).toEqual(['r5', 'r4']);
    const page2 = await core.history.query({ limit: 2, before: page1.at(-1)!.startedAt });
    expect(ids(page2)).toEqual(['r3', 'r2']);
    const page3 = await core.history.query({ limit: 2, before: page2.at(-1)!.startedAt });
    expect(ids(page3)).toEqual(['r1']);
  });

  it('filters by tool through the tool index, with paging', async () => {
    expect(ids(await core.history.query({ tool: 'ocr' }))).toEqual(['r4', 'r2']);
    const before = (await core.history.get('r4'))!.startedAt;
    expect(ids(await core.history.query({ tool: 'ocr', before }))).toEqual(['r2']);
  });

  it('filters by status, starred, model (any model of the run) and key', async () => {
    expect(ids(await core.history.query({ status: 'error' }))).toEqual(['r2']);
    expect(ids(await core.history.query({ starred: true }))).toEqual(['r3']);
    expect(ids(await core.history.query({ starred: false }))).toEqual(['r5', 'r4', 'r2', 'r1']);
    expect(ids(await core.history.query({ model: 'anthropic/claude-x' }))).toEqual(['r5']);
    expect(ids(await core.history.query({ keyId: 'k2' }))).toEqual(['r4']);
  });

  it('matches text case-insensitively over title, prompt, output and model', async () => {
    expect(ids(await core.history.query({ text: 'invoice' }))).toEqual(['r4', 'r3']);
    expect(ids(await core.history.query({ text: '  ARENA ' }))).toEqual(['r5']);
    expect(ids(await core.history.query({ text: 'MISTRAL' }))).toEqual(['r2']);
    expect(ids(await core.history.query({ text: 'nothing like this' }))).toEqual([]);
  });

  it('limits by from and to (inclusive)', async () => {
    const r2 = (await core.history.get('r2'))!.startedAt;
    const r4 = (await core.history.get('r4'))!.startedAt;
    expect(ids(await core.history.query({ from: r2, to: r4 }))).toEqual(['r4', 'r3', 'r2']);
    expect(ids(await core.history.query({ from: r2, to: r4, before: r4 }))).toEqual(['r3', 'r2']);
    expect(await core.history.query({ from: r4, to: r2 })).toEqual([]);
    expect(await core.history.query({ from: r4, before: r4 })).toEqual([]);
  });

  it('applies filters before the limit', async () => {
    expect(ids(await core.history.query({ tool: 'chat', limit: 2, text: 'run' }))).toEqual([
      'r3',
      'r1',
    ]);
  });
});

describe('changes', () => {
  beforeEach(async () => {
    await put(run(1), run(2, { tool: 'ocr' }), run(3));
  });

  it('stars and unstars, and announces it', async () => {
    const fn = vi.fn();
    core.history.subscribe(fn);
    await core.history.setStarred('r1', true);
    expect((await core.history.get('r1'))?.starred).toBe(true);
    await core.history.setStarred('nope', true);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('removes runs by id', async () => {
    const events: unknown[] = [];
    core.bus.on('history-changed', (e) => events.push(e));
    await core.history.remove(['r1', 'r3']);
    expect(ids(await core.history.query())).toEqual(['r2']);
    expect(events).toEqual([{ type: 'history-changed', ids: ['r1', 'r3'] }]);
  });

  it('clears one tool or everything and reports how many', async () => {
    expect(await core.history.count()).toBe(3);
    expect(await core.history.count({ tool: 'chat' })).toBe(2);
    expect(await core.history.clear({ tool: 'chat' })).toBe(2);
    expect(ids(await core.history.query())).toEqual(['r2']);
    expect(await core.history.clear()).toBe(1);
    expect(await core.history.count()).toBe(0);
    expect(await core.history.clear()).toBe(0);
  });

  it('notifies subscribers on data reset, and stops after unsubscribe', () => {
    const fn = vi.fn();
    const off = core.history.subscribe(fn);
    core.bus.emit({ type: 'data-reset' });
    off();
    core.bus.emit({ type: 'history-changed' });
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('exportJson', () => {
  it('exports readable JSON, newest first, or only the chosen runs', async () => {
    await put(run(1), run(2));
    const all = await core.history.exportJson();
    expect(all.type).toBe('application/json');
    const text = await all.text();
    expect(text).toContain('\n  "runs": [');
    const parsed = JSON.parse(text) as { format: string; version: number; runs: RunRecord[] };
    expect(parsed.format).toBe('ortoolbox-history');
    expect(parsed.version).toBe(1);
    expect(ids(parsed.runs)).toEqual(['r2', 'r1']);

    const some = JSON.parse(await (await core.history.exportJson(['r1', 'gone'])).text()) as {
      runs: RunRecord[];
    };
    expect(ids(some.runs)).toEqual(['r1']);
  });
});

describe('prune', () => {
  const prompt = (id: string, kind: PromptEntry['kind'], usedAt: number): PromptEntry => ({
    id,
    tool: 'chat',
    kind,
    name: null,
    text: id,
    settings: {},
    createdAt: usedAt,
    usedAt,
  });

  beforeEach(async () => {
    await put(
      run(1, { startedAt: NOW - 91 * DAY }),
      run(2, { startedAt: NOW - 91 * DAY, starred: true }),
      run(3, { startedAt: NOW - 80 * DAY }),
    );
    const db = await getDb();
    await db.put('prompts', prompt('old-recent', 'recent', NOW - 100 * DAY));
    await db.put('prompts', prompt('old-saved', 'saved', NOW - 100 * DAY));
    await db.put('prompts', prompt('new-recent', 'recent', NOW - DAY));
  });

  it('removes runs and recent prompts past retention, keeping starred runs and saved prompts', async () => {
    const events: unknown[] = [];
    core.bus.on('history-changed', (e) => events.push(e));
    core.bus.on('prompts-changed', (e) => events.push(e));

    expect(await core.history.prune()).toBe(1);
    expect(ids(await core.history.query()).sort()).toEqual(['r2', 'r3']);
    const prompts = (await (await getDb()).getAll('prompts')).map((p) => p.id).sort();
    expect(prompts).toEqual(['new-recent', 'old-saved']);
    expect(events).toEqual([
      { type: 'history-changed', ids: undefined },
      { type: 'prompts-changed', tool: 'all' },
    ]);
  });

  it('follows the retention setting', async () => {
    core.settings.update((d) => {
      d.data.retentionDays = 30;
    });
    expect(await core.history.prune()).toBe(2);
  });

  it('runs at most once a day', async () => {
    expect(await core.history.prune()).toBe(1);
    await put(run(4, { startedAt: NOW - 200 * DAY }));
    vi.setSystemTime(NOW + 23 * 3_600_000);
    expect(await core.history.prune()).toBe(0);
    expect(await core.history.get('r4')).toBeDefined();
    vi.setSystemTime(NOW + 25 * 3_600_000);
    expect(await core.history.prune()).toBe(1);
    expect(await core.history.get('r4')).toBeUndefined();
  });
});
