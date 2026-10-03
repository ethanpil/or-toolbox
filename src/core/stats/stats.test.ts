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
      costUnknown: false,
      byModel,
    },
    reservedUsd: 0,
    jobId: null,
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
        estimatedUsd: 0,
        latencyMsTotal: 200,
      },
    ]);
  });

  it('counts a run once, on its primary model, and flags free models', async () => {
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
    // The other model gains requests, tokens and cost, but is not another run.
    expect(rows.map((r) => [r.model, r.runs, r.requests, r.free])).toEqual([
      ['a/one', 1, 3, false],
      ['b/two:free', 0, 1, true],
    ]);
    expect(rows.reduce((sum, r) => sum + r.runs, 0)).toBe(1);
  });

  it('a failed run that called several models is one run and one error', async () => {
    await recordRunStats(
      run({
        status: 'error',
        model: 'a/one',
        models: ['a/one', 'b/two'],
        usage: { ...run().usage, byModel: { 'a/one': totals(), 'b/two': totals() } },
      }),
      isFree,
    );
    const rows = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    expect(rows.reduce((sum, r) => sum + r.runs, 0)).toBe(1);
    expect(rows.reduce((sum, r) => sum + r.errors, 0)).toBe(1);
    expect(rows.map((r) => [r.model, r.runs, r.errors])).toEqual([
      ['a/one', 1, 1],
      ['b/two', 0, 0],
    ]);
  });

  it('counts the primary run even when only other models reported usage', async () => {
    await recordRunStats(
      run({ model: 'p/primary', usage: { ...run().usage, byModel: { 'o/other': totals() } } }),
      isFree,
    );
    const rows = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    expect(rows.map((r) => [r.model, r.runs, r.requests])).toEqual([
      ['o/other', 0, 1],
      ['p/primary', 1, 0],
    ]);
  });

  it('marks costs estimated from catalog prices, and reservations booked for unknown costs', async () => {
    // Exact cost: nothing is estimated.
    await recordRunStats(
      run({ model: 'e/exact', usage: { ...run().usage, byModel: { 'e/exact': totals() } } }),
      isFree,
    );
    // The response carried no cost (TTS): the whole run's cost is an estimate, across its models.
    await recordRunStats(
      run({
        model: 'e/estimated',
        models: ['e/estimated', 'e/second'],
        usage: {
          ...run().usage,
          costEstimated: true,
          byModel: {
            'e/estimated': totals({ costUsd: 0.03 }),
            'e/second': totals({ costUsd: 0.02 }),
          },
        },
      }),
      isFree,
    );
    // Unknown cost: the reservation is booked, and all of it is an estimate.
    await recordRunStats(
      run({
        model: 'e/unknown',
        reservedUsd: 0.5,
        usage: {
          ...run().usage,
          costUnknown: true,
          byModel: { 'e/unknown': totals({ costUsd: 0 }) },
        },
      }),
      isFree,
    );
    // Part known, part unknown: the known part stays exact, the rest of the reservation is estimated.
    await recordRunStats(
      run({
        model: 'e/mixed',
        reservedUsd: 0.5,
        usage: {
          ...run().usage,
          costUnknown: true,
          costUsd: 0.1,
          byModel: { 'e/mixed': totals({ costUsd: 0.1 }) },
        },
      }),
      isFree,
    );
    const rows = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    const by = Object.fromEntries(rows.map((r) => [r.model, [r.costUsd, r.estimatedUsd]]));
    expect(by['e/exact']).toEqual([0.01, 0]);
    expect(by['e/estimated']).toEqual([0.03, 0.03]);
    expect(by['e/second']).toEqual([0.02, 0.02]);
    expect(by['e/unknown']).toEqual([0.5, 0.5]);
    expect(by['e/mixed']![0]).toBeCloseTo(0.5);
    expect(by['e/mixed']![1]).toBeCloseTo(0.4);
    for (const r of rows) expect(r.estimatedUsd).toBeLessThanOrEqual(r.costUsd + 1e-12);
  });

  it('accumulates the estimated part over runs', async () => {
    const estimated = run({
      model: 'e/estimated',
      usage: {
        ...run().usage,
        costEstimated: true,
        byModel: { 'e/estimated': totals({ costUsd: 0.03 }) },
      },
    });
    await recordRunStats(estimated, isFree);
    await recordRunStats({ ...estimated, id: 'other' }, isFree);
    await recordRunStats(
      run({
        model: 'e/estimated',
        usage: { ...run().usage, byModel: { 'e/estimated': totals({ costUsd: 0.01 }) } },
      }),
      isFree,
    );
    const [row] = await core.stats.rows({ from: '2026-10-15', to: '2026-10-15' });
    expect(row?.costUsd).toBeCloseTo(0.07);
    expect(row?.estimatedUsd).toBeCloseTo(0.06);
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
      ['o/other', 0, 0, 1],
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
