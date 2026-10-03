/**
 * Stats: daily rollups in IndexedDB `stats`, keyed `${day}|${tool}|${model}|${keyId}` (UTC days). Rows are
 * written once per finished run by `recordRunStats` (called by the runs service) and are independent of
 * history, so pruning or deleting runs does not change spend, budgets or the dashboard.
 */

import type { CoreServices, RunRecord, StatsRow, StatsService } from '../types';
import { getDb, type StoredStatsRow } from '../storage/db';

/** UTC day `YYYY-MM-DD` of a timestamp. */
export function utcDay(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** First and last possible day strings of the UTC month containing `ts` (string range, inclusive). */
export function utcMonthRange(ts: number = Date.now()): { from: string; to: string } {
  const month = utcDay(ts).slice(0, 7);
  return { from: `${month}-01`, to: `${month}-31` };
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
 * Adds a finished run to the rollups. The run counts once for every model in `usage.byModel`; a failed run
 * also counts as an error on its primary model, and a run without any usage still counts on its primary
 * model. The day is the run's finish day (UTC).
 */
export async function recordRunStats(
  run: RunRecord,
  isFree: (model: string) => boolean,
): Promise<void> {
  const day = utcDay(run.finishedAt ?? Date.now());
  const byModel = { ...run.usage.byModel };
  const needsPrimary =
    Object.keys(byModel).length === 0 || (run.status === 'error' && !(run.model in byModel));
  if (needsPrimary) {
    byModel[run.model] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMsTotal: 0,
    };
  }

  const db = await getDb();
  const tx = db.transaction('stats', 'readwrite');
  await Promise.all(
    Object.entries(byModel).map(async ([model, totals]) => {
      const key = statsKey({ day, tool: run.tool, model, keyId: run.keyId });
      const row: StoredStatsRow = (await tx.store.get(key)) ?? {
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
      await tx.store.put(row);
    }),
  );
  await tx.done;
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
      const db = await getDb();
      let runs = 0;
      let requests = 0;
      let latency = 0;
      let costUsd = 0;
      for (const row of await db.getAll('stats')) {
        if (row.model !== model) continue;
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
