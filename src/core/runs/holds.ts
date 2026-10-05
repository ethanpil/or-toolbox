/**
 * Holds: while a run is `running`, `kv` `meta:run-hold:<id>` holds what it counts against budgets (its key and
 * max(reservation, spend)). The runs service writes it in the same transactions as the record (begin, every
 * persist) and deletes it with the final record, so budget checks read these few small entries instead of every
 * running record with its output (up to 500 KB each).
 */

import type { KvEntry } from '../storage/db';
import type { RunRecord } from '../types';
import { isFiniteNumber, isPlainObject, isString } from '../util';

export const RUN_HOLD_PREFIX = 'meta:run-hold:';
export const holdKey = (id: string): string => `${RUN_HOLD_PREFIX}${id}`;

/** What a running run counts against budgets: its reservation, or what it has spent if that is more. */
export interface RunHold {
  keyId: string;
  usd: number;
}

export function parseHold(value: unknown): RunHold | null {
  if (!isPlainObject(value)) return null;
  const { keyId, usd } = value;
  return isString(keyId) && isFiniteNumber(usd) ? { keyId, usd } : null;
}

/** What a running record holds. */
export function holdOf(run: Pick<RunRecord, 'keyId' | 'reservedUsd' | 'usage'>): RunHold {
  return { keyId: run.keyId, usd: Math.max(run.reservedUsd || 0, run.usage?.costUsd ?? 0) };
}

/** The `kv` hold entry of a running record. */
export function holdEntry(run: Pick<RunRecord, 'id' | 'keyId' | 'reservedUsd' | 'usage'>): KvEntry {
  return { key: holdKey(run.id), value: holdOf(run), updatedAt: Date.now() };
}
