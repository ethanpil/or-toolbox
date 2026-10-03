/**
 * Puts history runs and stats rows straight into the app's IndexedDB (the schema of src/core/storage/db.ts) and
 * announces the change on the app's bus, as the services would. No tool can run a paid request in e2e, so the
 * Models, History and Stats specs build their data here.
 *
 * Call after the page has loaded once (the app creates the database at page start).
 */
import type { BrowserContext, Page } from '@playwright/test';
import type { RunRecord, StatsRow } from '../../src/core/types';

export const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The UTC day `daysAgo` days before now, `YYYY-MM-DD`. */
export const utcDayAgo = (daysAgo: number): string =>
  new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);

/** Usage of one finished request (1,200 tokens in, 340 out, $0.0123, 1.5 s); override any field. */
export const makeUsage = (partial: Partial<RunRecord['usage']> = {}): RunRecord['usage'] => ({
  requests: 1,
  promptTokens: 1200,
  completionTokens: 340,
  costUsd: 0.0123,
  latencyMsTotal: 1500,
  costEstimated: false,
  costUnknown: false,
  byModel: {
    'test/text-model': {
      requests: 1,
      promptTokens: 1200,
      completionTokens: 340,
      costUsd: 0.0123,
      latencyMsTotal: 1500,
    },
  },
  ...partial,
});

/** A finished chat run `minutesAgo` minutes ago; override anything. */
export function makeRun(
  id: string,
  minutesAgo: number,
  partial: Partial<RunRecord> = {},
): RunRecord {
  const startedAt = Date.now() - minutesAgo * MINUTE_MS;
  return {
    id,
    tool: 'chat',
    status: 'ok',
    model: 'test/text-model',
    models: ['test/text-model'],
    keyId: 'key-test',
    keyName: 'Test key',
    startedAt,
    finishedAt: startedAt + 1500,
    latencyMs: 1500,
    title: id,
    prompt: null,
    settings: null,
    output: null,
    error: null,
    usage: makeUsage(),
    reservedUsd: 0,
    jobId: null,
    meta: {},
    starred: false,
    groupId: null,
    ...partial,
  };
}

/** One daily ledger row. */
export function makeStats(day: string, partial: Partial<StatsRow> = {}): StatsRow {
  return {
    day,
    tool: 'chat',
    model: 'test/text-model',
    keyId: 'key-test',
    free: false,
    runs: 1,
    errors: 0,
    requests: 1,
    promptTokens: 1000,
    completionTokens: 500,
    costUsd: 0.01,
    estimatedUsd: 0,
    latencyMsTotal: 1000,
    ...partial,
  };
}

/** Records every index the page reads (`store.index(...)` queries), as `window.__indexReads`: `stats.model`, `stats.day`. */
export async function recordIndexReads(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const reads: string[] = [];
    (window as unknown as { __indexReads: string[] }).__indexReads = reads;
    const prototype = IDBIndex.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const method of ['getAll', 'get', 'openCursor', 'count', 'getAllKeys'] as const) {
      const original = prototype[method]!;
      prototype[method] = function (this: IDBIndex, ...args: unknown[]) {
        reads.push(`${this.objectStore.name}.${this.name}`);
        return original.apply(this, args);
      };
    }
  });
}

/** The indexes read so far (needs `recordIndexReads`). */
export const indexReads = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __indexReads?: string[] }).__indexReads ?? []);

export const clearIndexReads = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __indexReads?: string[] }).__indexReads?.splice(0);
  });

/** Writes runs and stats rows, then tells the open pages (live updates). */
export async function seedDb(
  page: Page,
  data: { runs?: RunRecord[]; stats?: StatsRow[] },
): Promise<void> {
  const stats = (data.stats ?? []).map((row) => ({
    ...row,
    key: `${row.day}|${row.tool}|${row.model}|${row.keyId}`,
  }));
  await page.evaluate(
    async ({ runs, stats }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ortoolbox');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
      });
      const tx = db.transaction(['runs', 'stats'], 'readwrite');
      for (const run of runs) tx.objectStore('runs').put(run);
      for (const row of stats) tx.objectStore('stats').put(row);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      });
      db.close();
      const bus = new BroadcastChannel('ortoolbox');
      if (runs.length > 0) bus.postMessage({ type: 'history-changed' });
      if (stats.length > 0) bus.postMessage({ type: 'stats-changed' });
      bus.close();
    },
    { runs: data.runs ?? [], stats },
  );
}
