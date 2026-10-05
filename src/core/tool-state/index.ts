/**
 * Per-tool persistent state in IndexedDB `kv` under `tool:<toolId>:<key>` (video sequences, saved deciders,
 * chat threads, …). Values must be JSON-safe: binaries belong in session results, never in storage.
 *
 * Every `set` and `delete` emits `{ type: 'tool-state-changed', tool, key }` on the bus once stored, in this tab
 * and in the others, so a page that shows the value can read it again (Chat threads open in two tabs).
 */

import type { Bus, ToolId, ToolStateStore } from '../types';
import { NotJsonSafeError } from '../errors';
import { getDb } from '../storage/db';
import { isPlainObject, withLock } from '../util';

export { NotJsonSafeError };

export const TOOL_STATE_PREFIX = 'tool:';

/** Every string key that starts with `prefix`. */
export function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff));
}

function describe(value: unknown): string {
  if (value instanceof Blob) return 'a Blob';
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return 'binary data';
  if (typeof value === 'number' || value === undefined) return String(value);
  if (typeof value === 'object' && value !== null) {
    return `a ${(value as { constructor?: { name?: string } }).constructor?.name ?? 'object'}`;
  }
  return `a ${typeof value}`;
}

/** Throws NotJsonSafeError naming the first value that would not survive JSON unchanged. */
export function assertJsonSafe(value: unknown, path = 'value'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) assertJsonSafe(child, `${path}.${key}`);
    }
    return;
  }
  throw new NotJsonSafeError(
    `Tool state must be JSON-safe (no binaries); ${path} is ${describe(value)}.`,
  );
}

export function createToolStateStore(tool: ToolId, bus?: Pick<Bus, 'emit'>): ToolStateStore {
  const prefix = `${TOOL_STATE_PREFIX}${tool}:`;
  const changed = (key: string): void => bus?.emit({ type: 'tool-state-changed', tool, key });

  const get = async <T>(key: string): Promise<T | undefined> =>
    (await (await getDb()).get('kv', prefix + key))?.value as T | undefined;
  const set = async <T>(key: string, value: T): Promise<void> => {
    assertJsonSafe(value);
    const stored = JSON.parse(JSON.stringify(value)) as unknown;
    await (await getDb()).put('kv', { key: prefix + key, value: stored, updatedAt: Date.now() });
    changed(key);
  };
  const remove = async (key: string): Promise<void> => {
    await (await getDb()).delete('kv', prefix + key);
    changed(key);
  };

  return {
    get,
    set,
    delete: remove,
    async keys() {
      const keys = await (await getDb()).getAllKeys('kv', prefixRange(prefix));
      return keys.map((key) => key.slice(prefix.length));
    },
    update<T>(key: string, fn: (current: T | undefined) => T | undefined | Promise<T | undefined>) {
      return withLock(`ortoolbox:tool-state:${tool}:${key}`, async () => {
        const current = await get<T>(key);
        const next = await fn(current);
        if (next === current) return current;
        if (next === undefined) await remove(key);
        else await set(key, next);
        return next;
      });
    },
  };
}
