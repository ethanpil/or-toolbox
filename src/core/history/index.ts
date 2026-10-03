/**
 * History: text-only run records in IndexedDB `runs`. Queries walk the `startedAt` / `tool-startedAt` indexes
 * newest first; `before` is the pagination cursor (pass the last row's `startedAt`).
 */

import type { CoreServices, HistoryQuery, HistoryService, RunRecord } from '../types';
import { getDb } from '../storage/db';
import { DAY_MS } from '../util';

const PRUNE_KEY = 'meta:lastPrune';
const DEFAULT_LIMIT = 50;

function matches(run: RunRecord, q: HistoryQuery, needle: string | null): boolean {
  if (q.status !== undefined && run.status !== q.status) return false;
  if (q.starred !== undefined && run.starred !== q.starred) return false;
  if (q.model !== undefined && run.model !== q.model && !run.models.includes(q.model)) return false;
  if (q.keyId !== undefined && run.keyId !== q.keyId) return false;
  if (needle) {
    const haystack = [run.title, run.prompt ?? '', run.output ?? '', run.model, ...run.models];
    if (!haystack.some((text) => text.toLowerCase().includes(needle))) return false;
  }
  return true;
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
      const needle = q.text?.trim().toLowerCase() || null;

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
        if (matches(cursor.value, q, needle)) out.push(cursor.value);
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
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      await Promise.all([...runs.map((run) => tx.store.put(run)), tx.done]);
      changed(runs.map((run) => run.id));
    },

    async clear(scope = {}) {
      const db = await getDb();
      const tx = db.transaction('runs', 'readwrite');
      let removed: number;
      if (scope.tool) {
        const keys = await tx.store.index('tool').getAllKeys(scope.tool);
        await Promise.all(keys.map((key) => tx.store.delete(key)));
        removed = keys.length;
      } else {
        removed = await tx.store.count();
        await tx.store.clear();
      }
      await tx.done;
      if (removed > 0) changed();
      return removed;
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
        if (!cursor.value.starred) {
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
      const offs = [core.bus.on('history-changed', fn), core.bus.on('data-reset', fn)];
      return () => offs.forEach((off) => off());
    },
  };
}
