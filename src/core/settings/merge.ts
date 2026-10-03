/** Small helpers for plain JSON objects, shared by settings and backup. */

import { isPlainObject, isUnsafeKey } from '../util';

/** JSON round trip: a detached, JSON-safe copy (functions, undefined and binaries are dropped). */
export function jsonCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Deep-merges plain objects: `over` wins on every leaf, nested plain objects merge key by key, arrays and
 * everything else are replaced. Neither input is modified, and `__proto__`/`constructor`/`prototype` keys
 * are never copied.
 */
export function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!isUnsafeKey(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined || isUnsafeKey(key)) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
