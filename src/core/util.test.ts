import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from './util';

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
