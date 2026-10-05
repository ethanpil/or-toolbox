/**
 * History: text-only run records in IndexedDB `runs`. Queries walk the `startedAt` / `tool-startedAt` indexes
 * newest first; `before` is the pagination cursor (pass the last row's `startedAt`). `clear` and `prune` never
 * delete a `running` run: it must still book its spend when it ends (a handed-off video run may outlive both).
 */

import type { CoreServices, HistoryQuery, HistoryService, RunRecord } from '../types';
import { getDb } from '../storage/db';
import { DAY_MS } from '../util';

const PRUNE_KEY = 'meta:lastPrune';
const DEFAULT_LIMIT = 50;

/**
 * A case-insensitive matcher for the search text. It tests each field in place (a regular expression with the `i`
 * flag) instead of lowercasing a copy of it, so a run's output (up to 500 KB) is scanned once and never copied, and
 * the short fields are tried before the output.
 */
function textMatcher(text: string | undefined): ((run: RunRecord) => boolean) | null {
  const needle = text?.trim();
  if (!needle) return null;
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  return (run) =>
    pattern.test(run.title) ||
    pattern.test(run.model) ||
    run.models.some((model) => pattern.test(model)) ||
    (run.prompt !== null && pattern.test(run.prompt)) ||
    (run.output !== null && pattern.test(run.output));
}

function matches(
  run: RunRecord,
  q: HistoryQuery,
  text: ((run: RunRecord) => boolean) | null,
): boolean {
  if (q.status !== undefined && run.status !== q.status) return false;
  if (q.starred !== undefined && run.starred !== q.starred) return false;
  if (q.model !== undefined && run.model !== q.model && !run.models.includes(q.model)) return false;
  if (q.keyId !== undefined && run.keyId !== q.keyId) return false;
  return text === null || text(run);
}

/** The `startedAt` bounds of a query, or null when the range is empty. */
function bounds(q: HistoryQuery): { lower?: number; upper?: number; upperOpen: boolean } | null {
  let upper = q.to;
  let upperOpen = false;
  if (q.before !== undefined && (upper === undefined || q.before <= upper)) {
    upper = q.before;
    upperOpen = true;
  }
  const lower = q.from;
  if (lower !== undefined && upper !== undefined) {
    if (lower > upper || (lower === upper && upperOpen)) return null;
  }
  return { lower, upper, upperOpen };
}

export function createHistoryService(core: CoreServices): HistoryService {
  const changed = (ids?: string[]): void => core.bus.emit({ type: 'history-changed', ids });

  return {
    async query(q = {}) {
      const limit = q.limit ?? DEFAULT_LIMIT;
      const range = bounds(q);
      if (!range || limit <= 0) return [];
      const { lower, upper, upperOpen } = range;
      const text = textMatcher(q.text);

      const db = await getDb();
      const tx = db.transaction('runs');
      const iterator = q.tool
        ? tx.store
            .index('tool-startedAt')
            .iterate(
              IDBKeyRange.bound(
                [q.tool, lower ?? -Infinity],
                [q.tool, upper ?? Infinity],
                false,
                upperOpen,
              ),
              'prev',
            )
        : tx.store
            .index('startedAt')
            .iterate(
              IDBKeyRange.bound(lower ?? -Infinity, upper ?? Infinity, false, upperOpen),
              'prev',
            );

      const out: RunRecord[] = [];
      for await (const cursor of iterator) {
        if (matches(cursor.value, q, text)) out.push(cursor.value);
        if (out.length >= limit) break;
      }
      return out;
    },

    async get(id) {
      return (await getDb()).get('runs', id);
    },

    async setStarred(id, starred) {
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      const run = await tx.store.get(id);
      if (run && run.starred !== starred) await tx.store.put({ ...run, starred });
      await tx.done;
      if (run) changed([id]);
    },

    async remove(ids) {
      if (ids.length === 0) return;
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
      changed(ids);
    },

    async restore(runs) {
      if (runs.length === 0) return;
      const now = Date.now();
      // A restored run never comes back `running`: no page owns it, and a running record would hold a budget
      // reservation and be finalized (and booked again) by the sweep. Stats are never touched here.
      const records = runs.map((run): RunRecord =>
        run.status === 'running'
          ? {
              ...run,
              status: 'aborted',
              finishedAt: Math.max(now, run.startedAt),
              latencyMs: Math.max(now, run.startedAt) - run.startedAt,
              error: run.error ?? 'The run was interrupted.',
            }
          : run,
      );
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      await Promise.all([...records.map((run) => tx.store.put(run)), tx.done]);
      changed(runs.map((run) => run.id));
    },

    async clear(scope = {}) {
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      const keys = scope.tool
        ? await tx.store.index('tool').getAllKeys(scope.tool)
        : await tx.store.getAllKeys();
      // Running runs stay: a live or handed-off run must still book its spend when it ends.
      const running = new Set(await tx.store.index('status').getAllKeys('running'));
      const doomed = keys.filter((key) => !running.has(key));
      await Promise.all([...doomed.map((key) => tx.store.delete(key)), tx.done]);
      const removed = doomed.length;
      if (removed > 0) changed();
      return { removed, kept: keys.length - removed };
    },

    async count(scope = {}) {
      const db = await getDb();
      return scope.tool ? db.countFromIndex('runs', 'tool', scope.tool) : db.count('runs');
    },

    async exportJson(ids) {
      const db = await getDb();
      let runs: RunRecord[];
      if (ids) {
        const found = await Promise.all(ids.map((id) => db.get('runs', id)));
        runs = found.filter((run): run is RunRecord => run !== undefined);
      } else {
        runs = await db.getAllFromIndex('runs', 'startedAt');
        runs.reverse();
      }
      const file = {
        format: 'ortoolbox-history',
        version: 1,
        exportedAt: new Date().toISOString(),
        runs,
      };
      return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    },

    async prune() {
      const db = await getDb();
      const now = Date.now();
      const last = (await db.get('kv', PRUNE_KEY))?.value;
      if (typeof last === 'number' && now - last < DAY_MS && last <= now) return 0;

      const cutoff = now - core.settings.get().data.retentionDays * DAY_MS;
      const tx = db.transaction(['runs', 'prompts', 'kv'], 'readwrite');
      let runsRemoved = 0;
      for await (const cursor of tx
        .objectStore('runs')
        .index('startedAt')
        .iterate(IDBKeyRange.upperBound(cutoff, true))) {
        // Running runs stay (a long video job outlives a short retention): they must still book their spend.
        if (!cursor.value.starred && cursor.value.status !== 'running') {
          await cursor.delete();
          runsRemoved++;
        }
      }
      // Recent prompts follow the same retention; saved prompts never expire.
      let promptsRemoved = 0;
      for await (const cursor of tx
        .objectStore('prompts')
        .index('usedAt')
        .iterate(IDBKeyRange.upperBound(cutoff, true))) {
        if (cursor.value.kind === 'recent') {
          await cursor.delete();
          promptsRemoved++;
        }
      }
      await tx.objectStore('kv').put({ key: PRUNE_KEY, value: now, updatedAt: now });
      await tx.done;

      if (runsRemoved > 0) changed();
      if (promptsRemoved > 0) core.bus.emit({ type: 'prompts-changed', tool: 'all' });
      return runsRemoved;
    },

    subscribe(fn) {
      const offs = [
        core.bus.on('history-changed', (event) => fn(event.ids)),
        core.bus.on('data-reset', () => fn()),
      ];
      return () => offs.forEach((off) => off());
    },
  };
}
