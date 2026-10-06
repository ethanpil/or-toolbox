import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, getDb } from './db';
import { StorageFullError } from '../errors';
import { resetDb } from '../testing/state-fakes';

/** Runs one raw IndexedDB request to completion. */
function request(make: () => IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = make();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('request failed'));
  });
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('quota errors', () => {
  it('turn into StorageFullError for every store, so the user gets the storage-full help', async () => {
    const db = await getDb();
    for (const store of ['kv', 'runs', 'prompts', 'jobs', 'stats'] as const) {
      const open = vi.spyOn(IDBDatabase.prototype, 'transaction');
      const tx = db.transaction(store, 'readwrite');
      const raw = open.mock.results[0]?.value as { _abort(name: string): void };
      open.mockRestore();
      // fake-indexeddb's own abort path, as a browser aborts a transaction over its quota.
      raw._abort('QuotaExceededError');
      await expect(tx.done).rejects.toBeInstanceOf(StorageFullError);
      // The same promise every time, so observing one copy is enough.
      expect(tx.done).toBe(tx.done);
    }
  });
});

describe('getDb', () => {
  it('does not cache a failed open', async () => {
    // A newer schema already exists: opening version 1 fails with VersionError.
    const newer = (await request(() => indexedDB.open(DB_NAME, 5))) as IDBDatabase;
    newer.close();
    await expect(getDb()).rejects.toThrow();

    await request(() => indexedDB.deleteDatabase(DB_NAME));
    await expect(getDb()).resolves.toBeDefined();
  });

  it('turns a synchronous throw into a rejection, and tries again next time', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = getDb();
    }).not.toThrow();
    await expect(pending).rejects.toThrow('Storage is blocked');
    await expect(getDb()).resolves.toBeDefined();
  });

  it('shares one connection', async () => {
    expect(await getDb()).toBe(await getDb());
  });
});
