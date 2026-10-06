import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageFullError, StorageUnavailableError, errorCode } from '../errors';
import { local, webStorageBlocked, writeJson } from './local';

afterEach(() => vi.restoreAllMocks());

describe('writeJson', () => {
  it('refuses, never pretends, when the browser blocks storage', () => {
    const error: unknown = (() => {
      try {
        writeJson(undefined, 'k', 1);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(StorageUnavailableError);
    expect(errorCode(error)).toBe('storage-unavailable');
  });

  it('maps a blocked write and a full store to errors the user can act on', () => {
    const storage = local()!;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => writeJson(storage, 'k', 1)).toThrow(StorageUnavailableError);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => writeJson(storage, 'k', 1)).toThrow(StorageFullError);
  });
});

describe('webStorageBlocked', () => {
  it('is false while a write works, and leaves nothing behind', () => {
    expect(webStorageBlocked()).toBe(false);
    expect(local()!.length).toBe(0);
  });

  it('is true when the browser refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(webStorageBlocked()).toBe(true);
  });

  it('is false when the store is only full: that is another message', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(webStorageBlocked()).toBe(false);
  });
});
