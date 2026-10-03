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

  it('reuses the latest estimate while nothing changed, and recomputes for another model', async () => {
    let model = 'a';
    const compute = vi.fn((m: string) => Promise.resolve(m === 'a' ? 0.1 : 0.2));
    const tracker = createEstimateTracker({ compute, model: () => model, show: vi.fn() });
    expect(await tracker.refresh()).toBe(0.1);
    expect(await tracker.current()).toBe(0.1);
    expect(compute).toHaveBeenCalledTimes(1);
    model = 'b';
    expect(await tracker.current()).toBe(0.2);
    expect(compute).toHaveBeenCalledTimes(2);
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
