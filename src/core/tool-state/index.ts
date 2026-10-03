/**
 * Per-tool persistent state in IndexedDB `kv` under `tool:<toolId>:<key>` (video sequences, saved deciders,
 * chat threads, …). Values must be JSON-safe: binaries belong in session results, never in storage.
 */

import type { ToolId, ToolStateStore } from '../types';
import { NotJsonSafeError } from '../errors';
import { getDb } from '../storage/db';
import { isPlainObject } from '../util';

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

export function createToolStateStore(tool: ToolId): ToolStateStore {
  const prefix = `${TOOL_STATE_PREFIX}${tool}:`;
  return {
    async get<T>(key: string) {
      return (await (await getDb()).get('kv', prefix + key))?.value as T | undefined;
    },
    async set<T>(key: string, value: T) {
      assertJsonSafe(value);
      const stored = JSON.parse(JSON.stringify(value)) as unknown;
      await (await getDb()).put('kv', { key: prefix + key, value: stored, updatedAt: Date.now() });
    },
    async delete(key) {
      await (await getDb()).delete('kv', prefix + key);
    },
    async keys() {
      const keys = await (await getDb()).getAllKeys('kv', prefixRange(prefix));
      return keys.map((key) => key.slice(prefix.length));
    },
  };
}
