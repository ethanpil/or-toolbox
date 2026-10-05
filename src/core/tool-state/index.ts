/**
 * Per-tool persistent state in IndexedDB `kv` under `tool:<toolId>:<key>` (video sequences, saved deciders,
 * chat threads, …). Values must be JSON-safe: binaries belong in session results, never in storage.
 *
 * Every `set` and `delete` emits `{ type: 'tool-state-changed', tool, key }` on the bus once stored, in this tab
 * and in the others, so a page that shows the value can read it again (Chat threads open in two tabs). So do a
 * data reset, "Delete all prompts and history" and a backup import, for every key they remove or write.
 *
 * After a data reset (here or in another tab), a page's store refuses (StateResetError) to store a value from
 * before it: a key this page read or wrote before the reset and has not read since, or an object it read from or
 * stored in the store before the reset (a thread a reply was streaming into, say). So the abort a reset causes
 * cannot write the wiped state back. `delete`, keys the page never knew, and values built after a fresh read are
 * stored as usual; `update` reads first.
 *
 * The guard lives in storage, not in the bus: Reset everything bumps a generation (`kv` `meta:reset-generation`)
 * in the same transaction that clears `kv` (`wipeKv`), every read notes the generation it read in, and every write
 * compares inside its own readwrite transaction. IndexedDB runs the two transactions one after the other, so a
 * write either lands before the wipe (and is wiped) or sees the new generation and is refused; none lands behind
 * it, whenever the `data-reset` event arrives.
 */

import { TOOL_IDS } from '../../tools/types';
import type { Bus, ToolId, ToolStateStore } from '../types';
import { NotJsonSafeError, StateResetError } from '../errors';
import { getDb, type KvEntry } from '../storage/db';
import { isFiniteNumber, isPlainObject, lockRunner, type LockRunner } from '../util';

export { NotJsonSafeError };

export const TOOL_STATE_PREFIX = 'tool:';

/** `kv` key of the reset generation: how many times Reset everything has wiped `kv` (absent before the first). */
export const RESET_GENERATION_KEY = 'meta:reset-generation';

const generationOf = (entry: { value: unknown } | undefined): number =>
  isFiniteNumber(entry?.value) ? entry.value : 0;

/** The part of a readwrite `kv` object store that `wipeKv` needs. */
export interface KvWipeStore {
  get(key: string): Promise<KvEntry | undefined>;
  clear(): Promise<unknown>;
  put(entry: KvEntry): Promise<unknown>;
}

/**
 * Reset everything's part for `kv`, inside the caller's readwrite transaction: clears it and bumps the reset
 * generation, so every page's tool state store refuses what it held from before (see the module comment).
 */
export async function wipeKv(kv: KvWipeStore): Promise<void> {
  const generation = generationOf(await kv.get(RESET_GENERATION_KEY));
  await kv.clear();
  await kv.put({ key: RESET_GENERATION_KEY, value: generation + 1, updatedAt: Date.now() });
}

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

export function createToolStateStore(tool: ToolId, bus?: Pick<Bus, 'emit'>): ToolStateStore {
  const prefix = `${TOOL_STATE_PREFIX}${tool}:`;
  const changed = (key: string): void => bus?.emit({ type: 'tool-state-changed', tool, key });

  // The reset guard: the reset generation in which this page last knew each key and each object.
  const knownKeys = new Map<string, number>();
  const knownValues = new WeakMap<object, number>();
  const know = (key: string, value: unknown, generation: number): void => {
    knownKeys.set(key, Math.max(knownKeys.get(key) ?? generation, generation));
    if (typeof value === 'object' && value !== null) knownValues.set(value, generation);
  };
  const fromBeforeReset = (key: string, value: unknown, generation: number): boolean =>
    (knownKeys.get(key) ?? generation) < generation ||
    (typeof value === 'object' &&
      value !== null &&
      (knownValues.get(value) ?? generation) < generation);

  const get = async <T>(key: string): Promise<T | undefined> => {
    const tx = (await getDb()).transaction('kv');
    const [mark, entry] = await Promise.all([
      tx.store.get(RESET_GENERATION_KEY),
      tx.store.get(prefix + key),
      tx.done,
    ]);
    const value = entry?.value as T | undefined;
    know(key, value, generationOf(mark)); // the generation this read saw, in the same transaction
    return value;
  };
  const set = async <T>(key: string, value: T): Promise<void> => {
    assertJsonSafe(value);
    const stored = JSON.parse(JSON.stringify(value)) as unknown;
    const tx = (await getDb()).transaction('kv', 'readwrite');
    const done = tx.done;
    done.catch(() => undefined); // observed below; a refusal aborts it
    // Compared inside the write's own transaction: a wipe either ran before it (refused) or runs after it.
    const generation = generationOf(await tx.store.get(RESET_GENERATION_KEY));
    if (fromBeforeReset(key, value, generation)) {
      tx.abort();
      throw new StateResetError();
    }
    await tx.store.put({ key: prefix + key, value: stored, updatedAt: Date.now() });
    await done;
    know(key, value, generation);
    changed(key);
  };
  const remove = async (key: string): Promise<void> => {
    const tx = (await getDb()).transaction('kv', 'readwrite');
    const [mark] = await Promise.all([
      tx.store.get(RESET_GENERATION_KEY),
      tx.store.delete(prefix + key),
      tx.done,
    ]);
    knownKeys.set(key, generationOf(mark)); // a key this page removed holds nothing from before
    changed(key);
  };

  /** `update`'s lock per key, made on first use. */
  const keyLocks = new Map<string, LockRunner>();

  return {
    get,
    set,
    delete: remove,
    async keys() {
      const keys = await (await getDb()).getAllKeys('kv', prefixRange(prefix));
      return keys.map((key) => key.slice(prefix.length));
    },
    update<T>(key: string, fn: (current: T | undefined) => T | undefined | Promise<T | undefined>) {
      let locked = keyLocks.get(key);
      if (!locked) {
        locked = lockRunner(`ortoolbox:tool-state:${tool}:${key}`);
        keyLocks.set(key, locked);
      }
      return locked(async () => {
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
