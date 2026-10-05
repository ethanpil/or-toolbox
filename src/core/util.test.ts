import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLockManager } from './testing/state-fakes';
import { debounce, holdLock, withLock } from './util';

const setLocks = (value: FakeLockManager | undefined): void => {
  Object.defineProperty(navigator, 'locks', { value, configurable: true });
};

describe('withLock', () => {
  afterEach(() => setLocks(undefined));

  it('runs callers one at a time, in order, also after a failure (no Web Locks: the page queue)', async () => {
    setLocks(undefined);
    const order: string[] = [];
    const step = (name: string, fail = false) =>
      withLock('test:lock', async () => {
        order.push(`${name} start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name} end`);
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([step('a'), step('b', true), step('c')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['a start', 'a end', 'b start', 'b end', 'c start', 'c end']);
  });

  it('holds the Web Lock while it runs', async () => {
    const locks = new FakeLockManager();
    setLocks(locks);
    let held = false;
    await withLock('test:held', () => {
      held = locks.held.has('test:held');
      return Promise.resolve();
    });
    expect(held).toBe(true);
    expect(locks.held.has('test:held')).toBe(false);
  });
});

describe('holdLock', () => {
  afterEach(() => setLocks(undefined));

  it('holds until released; ifAvailable answers null meanwhile', async () => {
    const locks = new FakeLockManager();
    setLocks(locks);
    const release = await holdLock('test:long');
    expect(release).toBeTypeOf('function');
    expect(locks.held.has('test:long')).toBe(true);
    expect(await holdLock('test:long', { ifAvailable: true })).toBeNull();
    release!();
    await vi.waitFor(() => expect(locks.held.has('test:long')).toBe(false));
    const again = await holdLock('test:long', { ifAvailable: true });
    expect(again).toBeTypeOf('function');
    again!();
  });

  it('resolves with a release that does nothing where Web Locks are missing', async () => {
    setLocks(undefined);
    const release = await holdLock('test:none', { ifAvailable: true });
    expect(release).toBeTypeOf('function');
    expect(() => release!()).not.toThrow();
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once, with the latest arguments, after the calls stop', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced('a');
    vi.advanceTimersByTime(60);
    debounced('b');
    vi.advanceTimersByTime(60);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('can run again after it ran', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 10);
    debounced();
    vi.advanceTimersByTime(10);
    debounced();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('drops a pending call on cancel, and cancel without one does nothing', () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 10);
    debounced.cancel();
    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    debounced();
    vi.advanceTimersByTime(10);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
