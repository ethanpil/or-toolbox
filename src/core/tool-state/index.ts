/**
 * Per-tool persistent state in IndexedDB `kv` under `tool:<toolId>:<key>` (video sequences, saved deciders,
 * chat threads, …). Values must be JSON-safe: binaries belong in session results, never in storage.
 *
 * Every `set` and `delete` emits `{ type: 'tool-state-changed', tool, key }` on the bus once stored, in this tab
 * and in the others, so a page that shows the value can read it again (Chat threads open in two tabs). So do a
 * data reset, "Delete all prompts and history" and a backup import, for every key they remove or write.
 *
 * After a data reset (`data-reset`, here or in another tab), a page's store refuses (StateResetError) to store a
 * value from before it: a key this page read or wrote before the reset and has not read since, or an object it
 * read from or stored in the store before the reset (a thread a reply was streaming into, say). So the abort a
 * reset causes cannot write the wiped state back. `delete`, keys the page never knew, and values built after a
 * fresh read are stored as usual; `update` reads first.
 */

import { TOOL_IDS } from '../../tools/types';
import type { Bus, ToolId, ToolStateStore } from '../types';
import { NotJsonSafeError, StateResetError } from '../errors';
import { getDb } from '../storage/db';
import { isPlainObject, withLock } from '../util';

export { NotJsonSafeError };

export const TOOL_STATE_PREFIX = 'tool:';

/** The tool and store key of a `kv` key `tool:<toolId>:<key>`; null for anything else. */
export function parseToolStateKey(kvKey: string): { tool: ToolId; key: string } | null {
  if (!kvKey.startsWith(TOOL_STATE_PREFIX)) return null;
  const rest = kvKey.slice(TOOL_STATE_PREFIX.length);
  const colon = rest.indexOf(':');
  const tool = rest.slice(0, colon);
  if (colon < 1 || !(TOOL_IDS as readonly string[]).includes(tool)) return null;
  return { tool: tool as ToolId, key: rest.slice(colon + 1) };
}

/** Announces that `kvKeys` (tool state among them) were written or removed behind the stores' backs. */
export function announceToolState(bus: Pick<Bus, 'emit'>, kvKeys: Iterable<string>): void {
  for (const kvKey of new Set(kvKeys)) {
    const parsed = parseToolStateKey(kvKey);
    if (parsed) bus.emit({ type: 'tool-state-changed', ...parsed });
  }
}

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

/** `bus.on` lets the store see data resets (see the module comment); without it there is no reset guard. */
export function createToolStateStore(
  tool: ToolId,
  bus?: Pick<Bus, 'emit'> & Partial<Pick<Bus, 'on'>>,
): ToolStateStore {
  const prefix = `${TOOL_STATE_PREFIX}${tool}:`;
  const changed = (key: string): void => bus?.emit({ type: 'tool-state-changed', tool, key });

  // The reset guard: how many resets this page has seen, and when it last knew each key and each object.
  let resets = 0;
  bus?.on?.('data-reset', () => {
    resets++;
  });
  const knownKeys = new Map<string, number>();
  const knownValues = new WeakMap<object, number>();
  const know = (key: string, value: unknown, at: number): void => {
    knownKeys.set(key, Math.max(knownKeys.get(key) ?? at, at));
    if (typeof value === 'object' && value !== null) knownValues.set(value, at);
  };
  const fromBeforeReset = (key: string, value: unknown): boolean =>
    (knownKeys.get(key) ?? resets) < resets ||
    (typeof value === 'object' && value !== null && (knownValues.get(value) ?? resets) < resets);

  const get = async <T>(key: string): Promise<T | undefined> => {
    const at = resets; // a read that began before a reset knows the state from before it
    const value = (await (await getDb()).get('kv', prefix + key))?.value as T | undefined;
    know(key, value, at);
    return value;
  };
  const set = async <T>(key: string, value: T): Promise<void> => {
    assertJsonSafe(value);
    const stored = JSON.parse(JSON.stringify(value)) as unknown;
    const db = await getDb();
    if (fromBeforeReset(key, value)) throw new StateResetError();
    know(key, value, resets);
    await db.put('kv', { key: prefix + key, value: stored, updatedAt: Date.now() });
    changed(key);
  };
  const remove = async (key: string): Promise<void> => {
    knownKeys.set(key, resets); // a key this page removed holds nothing from before
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
