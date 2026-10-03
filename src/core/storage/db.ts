/**
 * The single IndexedDB database. Every store is declared here so that all modules agree on names, keys and
 * indexes; bump DB_VERSION and add an upgrade step for any change. Text and JSON only — never binaries.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { JobRecord, PromptEntry, RunRecord, StatsRow } from '../types';

export const DB_NAME = 'ortoolbox';
export const DB_VERSION = 1;

/** `stats` rows are keyed `${day}|${tool}|${model}|${keyId}`. */
export type StoredStatsRow = StatsRow & { key: string };

/**
 * `kv` keys in use: `tool:<toolId>:<key>` (ToolStateStore), `models:catalog`, `models:images`, `models:videos`,
 * `models:endpoints:<modelId>`, `meta:<name>` (bookkeeping such as the last prune time).
 */
export interface KvEntry {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface OrDb extends DBSchema {
  runs: {
    key: string;
    value: RunRecord;
    indexes: {
      startedAt: number;
      tool: string;
      'tool-startedAt': [string, number];
      /** `running` runs: budget reservations and the orphan sweep. */
      status: string;
    };
  };
  prompts: {
    key: string;
    value: PromptEntry;
    indexes: { 'tool-kind': [string, string]; usedAt: number };
  };
  jobs: {
    key: string;
    value: JobRecord;
    indexes: { tool: string; state: string; groupId: string };
  };
  stats: {
    key: string;
    value: StoredStatsRow;
    indexes: { day: string; model: string };
  };
  kv: {
    key: string;
    value: KvEntry;
  };
}

let dbPromise: Promise<IDBPDatabase<OrDb>> | null = null;

/**
 * Shared connection. Closes itself when another tab upgrades the schema, and reopens on next use. A failed
 * open (blocked storage, version error, a synchronous throw from `indexedDB.open`) is reported as a rejected
 * promise and not cached, so the next call tries again.
 */
export function getDb(): Promise<IDBPDatabase<OrDb>> {
  if (dbPromise) return dbPromise;
  let opening: Promise<IDBPDatabase<OrDb>>;
  try {
    opening = openDatabase();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  dbPromise = opening;
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

function openDatabase(): Promise<IDBPDatabase<OrDb>> {
  return openDB<OrDb>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const runs = db.createObjectStore('runs', { keyPath: 'id' });
        runs.createIndex('startedAt', 'startedAt');
        runs.createIndex('tool', 'tool');
        runs.createIndex('tool-startedAt', ['tool', 'startedAt']);
        runs.createIndex('status', 'status');

        const prompts = db.createObjectStore('prompts', { keyPath: 'id' });
        prompts.createIndex('tool-kind', ['tool', 'kind']);
        prompts.createIndex('usedAt', 'usedAt');

        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('tool', 'tool');
        jobs.createIndex('state', 'state');
        // Records with groupId null are simply absent from this index.
        jobs.createIndex('groupId', 'groupId');

        const stats = db.createObjectStore('stats', { keyPath: 'key' });
        stats.createIndex('day', 'day');
        stats.createIndex('model', 'model');

        db.createObjectStore('kv', { keyPath: 'key' });
      }
    },
    blocking() {
      // Another tab wants a newer schema: let it proceed; we reopen lazily.
      void dbPromise?.then((db) => db.close());
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
  });
}

/** Tests only: close and forget the connection (pair with a fresh fake-indexeddb instance). */
export async function closeDbForTests(): Promise<void> {
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
}
