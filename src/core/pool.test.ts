import { describe, expect, it } from 'vitest';
import { runPool } from './pool';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('runPool', () => {
  it('runs every item, never more than the limit at once, starting in order', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      started.push(item);
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    });
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('starts nothing new once the signal aborts', async () => {
    const controller = new AbortController();
    const done: number[] = [];
    await runPool(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        await tick();
        done.push(item);
        if (item === 1) controller.abort();
      },
      controller.signal,
    );
    expect(done).toEqual([1, 2]);
  });

  it('stops after a failure, lets running work settle, and rejects with the first error', async () => {
    const done: number[] = [];
    await expect(
      runPool([1, 2, 3, 4, 5], 2, async (item) => {
        await tick();
        if (item === 1) throw new Error('one');
        if (item === 2) throw new Error('two');
        done.push(item);
      }),
    ).rejects.toThrow('one');
    expect(done).toEqual([]);
  });

  it('handles an empty list and a silly limit', async () => {
    await expect(runPool([], 3, () => Promise.resolve())).resolves.toBeUndefined();
    const seen: number[] = [];
    await runPool([1, 2], 0, (item) => {
      seen.push(item);
      return Promise.resolve();
    });
    expect(seen).toEqual([1, 2]);
  });
});
