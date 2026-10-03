import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRunStats, statsKey, utcDay, utcMonthRange } from '.';
import type { CoreServices, ModelUsageTotals, RunRecord } from '../types';
import { getDb } from '../storage/db';
import { createTestCore, isolateChannels, resetDb } from '../testing/state-fakes';

const NOW = Date.UTC(2026, 9, 15, 12); // 2026-10-15
const isFree = (id: string) => id.endsWith(':free');

function totals(partial: Partial<ModelUsageTotals> = {}): ModelUsageTotals {
  return {
    requests: 1,
    promptTokens: 10,
    completionTokens: 20,
    costUsd: 0.01,
    latencyMsTotal: 100,
    ...partial,
  };
}

function run(partial: Partial<RunRecord> = {}): RunRecord {
  const byModel = partial.usage?.byModel ?? { 'openai/gpt-x': totals() };
  return {
    id: crypto.randomUUID(),
    tool: 'chat',
    status: 'ok',
    model: 'openai/gpt-x',
    models: ['openai/gpt-x'],
    keyId: 'k1',
    keyName: 'Work',
    startedAt: NOW - 1000,
    finishedAt: NOW,
    latencyMs: 1000,
    title: 't',
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
      byModel,
    },
    meta: {},
    starred: false,
    groupId: null,
    ...partial,
  };
}

let core: CoreServices;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  core = createTestCore().core;
});
afterEach(() => vi.useRealTimers());

describe('helpers', () => {
  it('uses UTC days and months', () => {
    expect(utcDay(Date.UTC(2026, 0, 31, 23, 59))).toBe('2026-01-31');
    expect(utcMonthRange(Date.UTC(2026, 1, 3))).toEqual({ from: '2026-02-01', to: '2026-02-31' });
    expect(statsKey({ day: '2026-10-15', tool: 'chat', model: 'm', keyId: 'k' })).toBe(
      '2026-10-15|chat|m|k',
    );
  });
});

describe('recordRunStats', () => {
  it('writes one row per day, tool, model and key, and accumulates', async () => {
    await recordRunStats(run(), isFree);
    await recordRunStats(run(), isFree);
    const rows = await (await getDb()).getAll('stats');
    expect(rows).toEqual([
      {
        key: '2026-10-15|chat|openai/gpt-x|k1',
        day: '2026-10-15',
        tool: 'chat',
        model: 'openai/gpt-x',
        keyId: 'k1',
        free: false,
        runs: 2,
        errors: 0,
        requests: 2,
        promptTokens: 20,
        completionTokens: 40,
        costUsd: 0.02,
        latencyMsTotal: 200,
      },
    ]);
  });

  it('counts a run once per model used and flags free models', async () => {
    await recordRunStats(
      run({
        model: 'a/one',
        models: ['a/one', 'b/two:free'],
        usage: {
          ...run().usage,
          byModel: { 'a/one': totals({ requests: 3 }), 'b/two:free': totals({ costUsd: 0 }) },
        },
      }),
      isFree,
    );
    const rows = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    expect(rows.map((r) => [r.model, r.runs, r.requests, r.free])).toEqual([
      ['a/one', 1, 3, false],
      ['b/two:free', 1, 1, true],
    ]);
  });

  it('counts an error on the primary model even without usage', async () => {
    await recordRunStats(run({ status: 'error', usage: { ...run().usage, byModel: {} } }), isFree);
    await recordRunStats(
      run({
        status: 'error',
        model: 'p/primary',
        usage: { ...run().usage, byModel: { 'o/other': totals() } },
      }),
      isFree,
    );
    const rows = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    expect(rows.map((r) => [r.model, r.runs, r.errors, r.requests])).toEqual([
      ['o/other', 1, 0, 1],
      ['openai/gpt-x', 1, 1, 0],
      ['p/primary', 1, 1, 0],
    ]);
  });

  it('books the run on its UTC finish day', async () => {
    await recordRunStats(run({ finishedAt: Date.UTC(2026, 9, 14, 23, 59, 59) }), isFree);
    expect((await core.stats.rows({ from: '2026-10-14', to: '2026-10-14' })).length).toBe(1);
  });
});

describe('stats service', () => {
  beforeEach(async () => {
    await recordRunStats(run({ finishedAt: Date.UTC(2026, 8, 30, 12) }), isFree); // September
    await recordRunStats(run({ finishedAt: Date.UTC(2026, 9, 1, 0, 0, 1) }), isFree);
    await recordRunStats(run({ keyId: 'k2' }), isFree);
    await recordRunStats(
      run({
        model: 'x/y:free',
        usage: { ...run().usage, byModel: { 'x/y:free': totals({ requests: 4, costUsd: 0 }) } },
      }),
      isFree,
    );
    await recordRunStats(
      run({
        model: 'x/y:free',
        finishedAt: NOW - 86_400_000,
        usage: { ...run().usage, byModel: { 'x/y:free': totals({ requests: 7, costUsd: 0 }) } },
      }),
      isFree,
    );
  });

  it('returns rows between two days inclusive', async () => {
    expect(await core.stats.rows({ from: '2026-10-01', to: '2026-10-31' })).toHaveLength(4);
    expect(await core.stats.rows({ from: '2026-09-01', to: '2026-09-30' })).toHaveLength(1);
    expect(await core.stats.rows({ from: '2026-10-31', to: '2026-10-01' })).toEqual([]);
  });

  it('sums spend for the current UTC month, optionally per key', async () => {
    expect(await core.stats.monthSpend()).toBeCloseTo(0.02);
    expect(await core.stats.monthSpend({ keyId: 'k2' })).toBeCloseTo(0.01);
    expect(await core.stats.monthSpend({ keyId: 'nobody' })).toBe(0);
  });

  it('counts free-model requests made today only', async () => {
    expect(await core.stats.freeRequestsToday()).toBe(4);
  });

  it('summarises one model across all rows', async () => {
    expect(await core.stats.modelSummary('openai/gpt-x')).toEqual({
      runs: 3,
      avgLatencyMs: 100,
      costUsd: expect.closeTo(0.03) as number,
    });
    expect(await core.stats.modelSummary('never/used')).toEqual({
      runs: 0,
      avgLatencyMs: null,
      costUsd: 0,
    });
  });

  it('notifies subscribers on stats-changed and data-reset', () => {
    const fn = vi.fn();
    const off = core.stats.subscribe(fn);
    core.bus.emit({ type: 'stats-changed' });
    core.bus.emit({ type: 'data-reset' });
    off();
    core.bus.emit({ type: 'stats-changed' });
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
