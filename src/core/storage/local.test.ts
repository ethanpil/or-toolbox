import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageFullError, StorageUnavailableError, errorCode } from '../errors';
import { local, writeJson } from './local';

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
