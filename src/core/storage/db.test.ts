import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, getDb } from './db';
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
