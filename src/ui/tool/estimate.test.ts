import { describe, expect, it, vi } from 'vitest';
import { createEstimateTracker } from './estimate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createEstimateTracker', () => {
  it('shows only the newest answer when answers arrive out of order', async () => {
    const answers = [deferred<number | null>(), deferred<number | null>()];
    let call = 0;
    const show = vi.fn();
    const tracker = createEstimateTracker({
      compute: () => answers[call++]!.promise,
      model: () => 'm',
      show,
    });
    const first = tracker.refresh();
    const second = tracker.refresh();
    answers[1]!.resolve(0.02);
    await second;
    answers[0]!.resolve(0.01); // stale: must not overwrite
    await first;
    expect(show.mock.calls).toEqual([[0.02]]);
  });

  it('computes afresh for the run, so input changed since the last refresh is what gets booked', async () => {
    let chars = 100;
    let model = 'a';
    const compute = vi.fn((m: string) => Promise.resolve((m === 'a' ? 1 : 2) * chars * 0.001));
    const show = vi.fn();
    const tracker = createEstimateTracker({ compute, model: () => model, show });
    expect(await tracker.refresh()).toBeCloseTo(0.1);
    chars = 5000; // pasted, and Run pressed before the tool's debounced refresh
    expect(await tracker.current()).toBeCloseTo(5);
    expect(show).toHaveBeenLastCalledWith(5); // the badge shows what was booked
    model = 'b';
    expect(await tracker.current()).toBeCloseTo(10);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('treats a missing model, a failing or a nonsense estimate as unknown', async () => {
    const show = vi.fn();
    const none = createEstimateTracker({
      compute: () => Promise.resolve(1),
      model: () => null,
      show,
    });
    expect(await none.refresh()).toBeNull();
    const failing = createEstimateTracker({
      compute: () => Promise.reject(new Error('offline')),
      model: () => 'm',
      show,
    });
    expect(await failing.refresh()).toBeNull();
    const nonsense = createEstimateTracker({
      compute: () => Promise.resolve(-1),
      model: () => 'm',
      show,
    });
    expect(await nonsense.refresh()).toBeNull();
    const noHook = createEstimateTracker({ compute: () => null, model: () => 'm', show });
    expect(await noHook.refresh()).toBeNull();
  });

  it('lets a tool set its own value, which stays current until the next refresh', async () => {
    const compute = vi.fn(() => Promise.resolve(0.5));
    const show = vi.fn();
    const tracker = createEstimateTracker({ compute, model: () => 'm', show });
    tracker.set(0.07, 'for 3 pages');
    expect(show).toHaveBeenLastCalledWith(0.07, 'for 3 pages');
    expect(await tracker.current()).toBe(0.07);
    expect(compute).not.toHaveBeenCalled();
  });
});
