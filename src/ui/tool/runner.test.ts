import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunCancelledError } from '../../core/errors';
import { createRunner } from './runner';

afterEach(() => {
  document.body.replaceChildren();
});

describe('createRunner', () => {
  it('runs once at a time and shows Stop while busy', async () => {
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const runner = createRunner({ run }, true);
    document.body.append(runner.element);
    expect(runner.stopButton.hidden).toBe(true);

    const first = runner.trigger();
    expect(runner.busy).toBe(true);
    expect(runner.stopButton.hidden).toBe(false);
    expect(runner.button.getAttribute('aria-disabled')).toBe('true');
    expect(runner.button.textContent).toContain('Running…');
    void runner.trigger(); // ignored while busy
    expect(run).toHaveBeenCalledOnce();

    finish();
    await first;
    expect(runner.busy).toBe(false);
    expect(runner.stopButton.hidden).toBe(true);
    expect(runner.button.getAttribute('aria-disabled')).toBe('false');
  });

  it('aborts the signal on Stop and stays quiet about the abort', async () => {
    let seen: AbortSignal | undefined;
    const runner = createRunner(
      {
        run: (signal) =>
          new Promise<void>((_, reject) => {
            seen = signal;
            signal.addEventListener('abort', () => reject(signal.reason as Error));
          }),
      },
      true,
    );
    document.body.append(runner.element);
    const pending = runner.trigger();
    runner.stopButton.click();
    await pending;
    expect(seen?.aborted).toBe(true);
    expect(document.querySelector('[data-testid="error-toast"]')).toBeNull();
  });

  it('does not run while disabled, and shows the reason', async () => {
    const run = vi.fn(() => Promise.resolve());
    const runner = createRunner({ run, hint: 'Ready' }, false);
    runner.setDisabled('Add a prompt first');
    expect(runner.element.textContent).toContain('Add a prompt first');
    await runner.trigger();
    expect(run).not.toHaveBeenCalled();

    runner.setFrameworkReason('No model is available in free-only mode.');
    runner.setDisabled(null);
    expect(runner.element.textContent).toContain('free-only');
    await runner.trigger();
    expect(run).not.toHaveBeenCalled();

    runner.setFrameworkReason(null);
    expect(runner.element.textContent).toContain('Ready');
    await runner.trigger();
    expect(run).toHaveBeenCalledOnce();
  });

  it('reports failures with a toast, but not a declined budget confirmation', async () => {
    const failing = createRunner({ run: () => Promise.reject(new Error('boom')) }, true);
    document.body.append(failing.element);
    await failing.trigger();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="error-toast"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull();

    document.body.replaceChildren();
    const declined = createRunner({ run: () => Promise.reject(new RunCancelledError()) }, true);
    await declined.trigger();
    expect(document.querySelector('[data-testid="error-toast"]')).toBeNull();
  });

  it('passes the argument to run, and Retry replays the same one', async () => {
    const seen: (string | undefined)[] = [];
    let fail = true;
    const runner = createRunner<string>(
      {
        run: (_signal, arg) => {
          seen.push(arg);
          return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
        },
      },
      true,
    );
    document.body.append(runner.element);
    const started = runner.trigger('page-3');
    expect(started.started).toBe(true);
    await started;
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    fail = false;
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(seen).toEqual(['page-3', 'page-3']));
    await runner.trigger();
    expect(seen).toEqual(['page-3', 'page-3', undefined]);
  });

  it('answers false at once when it cannot start, and tells subscribers why', async () => {
    let finish!: () => void;
    const runner = createRunner(
      {
        run: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
      true,
    );
    const states: { busy: boolean; disabledReason: string | null }[] = [];
    const off = runner.subscribe((state) => states.push({ ...state }));
    expect(states).toEqual([{ busy: false, disabledReason: null }]);

    runner.setDisabled('Add a file first');
    expect(runner.disabledReason).toBe('Add a file first');
    expect(runner.trigger().started).toBe(false);
    runner.setDisabled(null);

    const first = runner.trigger();
    expect(first.started).toBe(true);
    expect(runner.busy).toBe(true);
    expect(runner.trigger().started).toBe(false); // busy
    finish();
    await first;
    expect(states).toEqual([
      { busy: false, disabledReason: null },
      { busy: false, disabledReason: 'Add a file first' },
      { busy: false, disabledReason: null },
      { busy: true, disabledReason: null },
      { busy: false, disabledReason: null },
    ]);
    off();
    runner.setDisabled('x');
    expect(states).toHaveLength(5);
  });
});
