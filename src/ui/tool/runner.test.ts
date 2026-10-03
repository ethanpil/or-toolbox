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
});
