import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAbortError } from '../errors';
import { sleep } from '../util';
import { DEFAULT_RETRY_POLICY, retryDelay, type RetryPolicy } from './retry';
import { FREE_THROTTLE_STORAGE_KEY, FreeModelThrottle } from './throttle';

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, random: () => 0.5 };

describe('retryDelay', () => {
  it('uses full jitter over an exponentially growing window', () => {
    expect(retryDelay(1, policy)).toBe(500);
    expect(retryDelay(2, policy)).toBe(1000);
    expect(retryDelay(1, { ...policy, random: () => 0 })).toBe(0);
    const many = { ...policy, maxAttempts: 10, random: () => 0.999 };
    expect(retryDelay(8, many)).toBeLessThan(policy.maxDelayMs);
  });

  it('stops after the last attempt', () => {
    expect(retryDelay(3, policy)).toBeNull();
  });

  it('honours the server retry-after, but not an excessive one', () => {
    expect(retryDelay(1, policy, 1000)).toBe(1000);
    expect(retryDelay(1, policy, 0)).toBe(0);
    expect(retryDelay(1, policy, 120_000)).toBeNull();
    expect(retryDelay(3, policy, 1000)).toBeNull();
  });
});

describe('sleep', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves after the delay and rejects with AbortError on abort', async () => {
    let done = false;
    void sleep(1000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);

    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('FreeModelThrottle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  async function acquireMany(throttle: FreeModelThrottle, count: number): Promise<number> {
    let granted = 0;
    for (let i = 0; i < count; i++) void throttle.acquire().then(() => granted++);
    await vi.advanceTimersByTimeAsync(0);
    return granted;
  }

  it('lets 20 requests through per rolling minute and queues the rest', async () => {
    const throttle = new FreeModelThrottle();
    let granted = 0;
    for (let i = 0; i < 25; i++) void throttle.acquire().then(() => granted++);
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(20);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(granted).toBe(20);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(granted).toBe(25);
  });

  it('shares the window across tabs through localStorage', async () => {
    const tabA = new FreeModelThrottle();
    const tabB = new FreeModelThrottle();
    expect(await acquireMany(tabA, 12)).toBe(12);
    expect(await acquireMany(tabB, 12)).toBe(8);
    const stored: unknown = JSON.parse(localStorage.getItem(FREE_THROTTLE_STORAGE_KEY) ?? '[]');
    expect(Array.isArray(stored) && stored.length).toBe(20);
  });

  it('falls back to a per-tab window without storage', async () => {
    const tabA = new FreeModelThrottle({ storage: () => undefined });
    const tabB = new FreeModelThrottle({ storage: () => undefined });
    expect(await acquireMany(tabA, 20)).toBe(20);
    expect(await acquireMany(tabB, 20)).toBe(20);
    expect(await acquireMany(tabA, 1)).toBe(0);
  });

  it('survives a corrupt stored value', async () => {
    localStorage.setItem(FREE_THROTTLE_STORAGE_KEY, '{oops');
    expect(await acquireMany(new FreeModelThrottle(), 3)).toBe(3);
  });

  it('rejects an aborted waiter and keeps serving the queue', async () => {
    const throttle = new FreeModelThrottle({ limit: 1, windowMs: 1000 });
    await throttle.acquire();
    const controller = new AbortController();
    const aborted = throttle.acquire(controller.signal).catch((e: unknown) => e);
    let laterGranted = false;
    void throttle.acquire().then(() => (laterGranted = true));
    controller.abort();
    expect(isAbortError(await aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(laterGranted).toBe(true);
  });

  it('rejects an aborted waiter at once, even while queued behind another waiter', async () => {
    const throttle = new FreeModelThrottle({ limit: 1, windowMs: 60_000 });
    await throttle.acquire();
    let firstGranted = false;
    void throttle.acquire().then(() => (firstGranted = true)); // waits a minute
    const controller = new AbortController();
    let outcome: unknown = 'pending';
    void throttle.acquire(controller.signal).then(
      () => (outcome = 'granted'),
      (e: unknown) => (outcome = e),
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(isAbortError(outcome)).toBe(true);
    expect(firstGranted).toBe(false);
    // The aborted caller took no slot: the next minute serves the earlier waiter only.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(firstGranted).toBe(true);
  });

  it('keeps enforcing the window when storage cannot be written', async () => {
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    } as unknown as Storage;
    const throttle = new FreeModelThrottle({ storage: () => readOnly });
    expect(await acquireMany(throttle, 25)).toBe(20);
  });

  it('never lets an unreadable or corrupted store reset the window', async () => {
    let mode: 'ok' | 'throw' | 'corrupt' = 'ok';
    const store = new Map<string, string>();
    const flaky = {
      getItem: (key: string) => {
        if (mode === 'throw') throw new DOMException('blocked', 'SecurityError');
        return mode === 'corrupt' ? '{oops' : (store.get(key) ?? null);
      },
      setItem: (key: string, value: string) => void store.set(key, value),
    } as unknown as Storage;
    const throttle = new FreeModelThrottle({ storage: () => flaky });
    expect(await acquireMany(throttle, 15)).toBe(15);
    mode = 'throw';
    expect(await acquireMany(throttle, 3)).toBe(3);
    mode = 'corrupt';
    expect(await acquireMany(throttle, 5)).toBe(2);
  });
});
