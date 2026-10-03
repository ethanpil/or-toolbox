/**
 * Stats: daily rollups in IndexedDB `stats`, keyed `${day}|${tool}|${model}|${keyId}` (UTC days). Rows are
 * written once per finished run, in the same transaction as the run's final record (see runs), and are
 * independent of history, so pruning or deleting runs does not change spend, budgets or the dashboard.
 */

import type { CoreServices, ModelUsageTotals, RunRecord, StatsRow, StatsService } from '../types';
import { getDb, type StoredStatsRow } from '../storage/db';
import { utcDay, utcMonthStart } from '../util';

export { utcDay };

/** First and last possible day strings of the UTC month containing `ts` (string range, inclusive). */
export function utcMonthRange(ts: number = Date.now()): { from: string; to: string } {
  const from = utcMonthStart(ts);
  return { from, to: `${from.slice(0, 7)}-31` };
}

export function statsKey(row: Pick<StatsRow, 'day' | 'tool' | 'model' | 'keyId'>): string {
  return `${row.day}|${row.tool}|${row.model}|${row.keyId}`;
}

function stripKey(stored: StoredStatsRow): StatsRow {
  const row: Partial<StoredStatsRow> = { ...stored };
  delete row.key;
  return row as StatsRow;
}

/**
 * What a finished run costs the budget: its reported cost, or `max(cost, reservedUsd)` when some request's
 * cost was unknown — unknown is never free.
 */
export function bookedCost(run: Pick<RunRecord, 'usage' | 'reservedUsd'>): number {
  const actual = run.usage.costUsd;
  return run.usage.costUnknown ? Math.max(actual, run.reservedUsd || 0) : actual;
}

/** The part of an object store `addRunToStats` needs; any readwrite `stats` store fits. */
export interface StatsStore {
  get(key: string): Promise<StoredStatsRow | undefined>;
  put(row: StoredStatsRow): Promise<unknown>;
}

const zero = (): ModelUsageTotals => ({
  requests: 0,
  promptTokens: 0,
  completionTokens: 0,
  costUsd: 0,
  latencyMsTotal: 0,
});

/**
 * Adds a finished run to the rollups inside the caller's transaction. The run counts once for every model
 * in `usage.byModel`; a failed run also counts as an error on its primary model, and a run without any
 * usage still counts on its primary model. Booked cost above the reported cost (unknown cost) goes to the
 * primary model. The day is the run's finish day (UTC).
 */
export async function addRunToStats(
  store: StatsStore,
  run: RunRecord,
  isFree: (model: string) => boolean,
): Promise<void> {
  const day = utcDay(run.finishedAt ?? Date.now());
  const byModel: Record<string, ModelUsageTotals> = {};
  for (const [model, totals] of Object.entries(run.usage.byModel)) byModel[model] = { ...totals };
  if (Object.keys(byModel).length === 0 || (run.status === 'error' && !(run.model in byModel))) {
    byModel[run.model] = zero();
  }
  const extra = bookedCost(run) - run.usage.costUsd;
  if (extra > 0) (byModel[run.model] ??= zero()).costUsd += extra;

  for (const [model, totals] of Object.entries(byModel)) {
    const key = statsKey({ day, tool: run.tool, model, keyId: run.keyId });
    const row: StoredStatsRow = (await store.get(key)) ?? {
      key,
      day,
      tool: run.tool,
      model,
      keyId: run.keyId,
      free: isFree(model),
      runs: 0,
      errors: 0,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMsTotal: 0,
    };
    row.runs += 1;
    if (run.status === 'error' && model === run.model) row.errors += 1;
    row.requests += totals.requests;
    row.promptTokens += totals.promptTokens;
    row.completionTokens += totals.completionTokens;
    row.costUsd += totals.costUsd;
    row.latencyMsTotal += totals.latencyMsTotal;
    await store.put(row);
  }
}

/** `addRunToStats` in a transaction of its own (tests, tools). */
export async function recordRunStats(
  run: RunRecord,
  isFree: (model: string) => boolean,
): Promise<void> {
  const tx = (await getDb()).transaction('stats', 'readwrite');
  await Promise.all([addRunToStats(tx.store, run, isFree), tx.done]);
}

export function createStatsService(core: CoreServices): StatsService {
  const rows: StatsService['rows'] = async ({ from, to }) => {
    if (from > to) return [];
    const db = await getDb();
    const stored = await db.getAllFromIndex('stats', 'day', IDBKeyRange.bound(from, to));
    return stored.map(stripKey);
  };

  return {
    rows,
    async monthSpend(opts = {}) {
      const month = await rows(utcMonthRange());
      return month
        .filter((row) => opts.keyId === undefined || row.keyId === opts.keyId)
        .reduce((sum, row) => sum + row.costUsd, 0);
    },
    async freeRequestsToday() {
      const today = utcDay();
      const todays = await rows({ from: today, to: today });
      return todays.filter((row) => row.free).reduce((sum, row) => sum + row.requests, 0);
    },
    async modelSummary(model) {
      let runs = 0;
      let requests = 0;
      let latency = 0;
      let costUsd = 0;
      for (const row of await (await getDb()).getAllFromIndex('stats', 'model', model)) {
        runs += row.runs;
        requests += row.requests;
        latency += row.latencyMsTotal;
        costUsd += row.costUsd;
      }
      return { runs, avgLatencyMs: requests > 0 ? latency / requests : null, costUsd };
    },
    subscribe(fn) {
      const offs = [core.bus.on('stats-changed', fn), core.bus.on('data-reset', fn)];
      return () => offs.forEach((off) => off());
    },
  };
}
