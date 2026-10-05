import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, RunCancelledError } from '../../core/errors';
import { createRunner, pendingOnly } from './runner';

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

  it('lets the tool narrow what the error Retry replays, so finished items are not paid again', async () => {
    const seen: (string[] | undefined)[] = [];
    const done = new Set<string>();
    const runner = createRunner<string[]>(
      {
        run: (_signal, keys) => {
          seen.push(keys);
          done.add('a'); // 'a' got its result before the fatal error
          return Promise.reject(new Error('Payment required'));
        },
        replayArg: pendingOnly((key) => done.has(key)),
      },
      true,
    );
    document.body.append(runner.element);
    await runner.trigger(['a', 'b']);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(seen).toEqual([['a', 'b'], ['b']]));

    // Everything done by now: the Retry has nothing left to send.
    done.add('b');
    document.body.querySelectorAll('[data-testid="toast"]').forEach((node) => node.remove());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(2);
  });

  it('pendingOnly with the item keys turns a plain run’s replay into the items still without a result', () => {
    const done = new Set<string>();
    const all = (): string[] => ['a', 'b', 'c'];
    const replay = pendingOnly((key: string) => done.has(key), all);
    expect(replay(undefined)).toBeUndefined(); // nothing finished: a plain run again
    done.add('a');
    expect(replay(undefined)).toEqual(['b', 'c']);
    expect(replay(['a', 'b'])).toEqual(['b']);
    done.add('b').add('c');
    expect(replay(undefined)).toBeNull();
    // Without the keys a plain run stays a plain run.
    expect(pendingOnly((key: string) => done.has(key))(undefined)).toBeUndefined();
  });

  it('says so when the error Retry cannot start, instead of closing silently', async () => {
    let fail = true;
    const runner = createRunner<string>(
      { run: () => (fail ? Promise.reject(new Error('boom')) : Promise.resolve()) },
      true,
    );
    document.body.append(runner.element);
    await runner.trigger('x');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    fail = false;
    runner.setDisabled('Add a file first');
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="retry-blocked-toast"]')?.textContent).toContain(
        'Add a file first',
      ),
    );
  });

  it('Escape stops the primary runner by default; other runners and an opt-out do not install it', async () => {
    const hold = () => (signal: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      });
    const escape = () =>
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );

    const primary = createRunner({ run: hold() }, true);
    const pending = primary.trigger();
    escape();
    await pending;
    expect(primary.busy).toBe(false);
    primary.dispose();

    const secondary = createRunner({ run: hold() }, false);
    const optedOut = createRunner({ run: hold(), stopOnEscape: false }, true);
    const both = [secondary.trigger(), optedOut.trigger()];
    escape();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondary.busy).toBe(true);
    expect(optedOut.busy).toBe(true);
    secondary.stop();
    optedOut.stop();
    await Promise.all(both);

    // After dispose, Escape no longer reaches it.
    const disposed = createRunner({ run: hold() }, true);
    disposed.dispose();
    const running = disposed.trigger();
    escape();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed.busy).toBe(true);
    disposed.stop();
    await running;
  });

  /** What the API client throws when a paid request may have gone through. */
  const mayHaveGoneThrough = (): NetworkError => {
    const error = new NetworkError('Could not reach OpenRouter.');
    error.outcomeUnknown = true;
    return error;
  };

  it('never resends a paid request that may have gone through; the toast offers the tool’s safe action', async () => {
    const run = vi.fn(() => Promise.reject(mayHaveGoneThrough()));
    const check = vi.fn();
    const runner = createRunner<string>(
      { run, safeAction: { label: 'Check status', onClick: check } },
      true,
    );
    document.body.append(runner.element);
    await runner.trigger('clip-1');
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-safe-action"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="toast-retry"]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid="toast-safe-action"]')!.click();
    expect(check).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(run).toHaveBeenCalledOnce();

    // No safe action: the toast says to check first and links to OpenRouter's activity, still no Retry.
    document.body.replaceChildren();
    const plain = createRunner({ run }, true);
    await plain.trigger();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-activity"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="toast-retry"]')).toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('replays after an unknown outcome only when the tool opts in, still through replayArg', async () => {
    const seen: (string[] | undefined)[] = [];
    const done = new Set<string>();
    const runner = createRunner<string[]>(
      {
        run: (_signal, keys) => {
          seen.push(keys);
          done.add('a');
          return Promise.reject(mayHaveGoneThrough());
        },
        replayArg: pendingOnly((key) => done.has(key)),
        retryUnknownOutcome: true,
      },
      true,
    );
    document.body.append(runner.element);
    await runner.trigger(['a', 'b']);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="toast-retry"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-testid="error-toast"]')?.textContent).toContain(
      'may have gone through',
    );
    document.querySelector<HTMLButtonElement>('[data-testid="toast-retry"]')!.click();
    await vi.waitFor(() => expect(seen).toEqual([['a', 'b'], ['b']]));
  });

  describe('a bar with more than Run', () => {
    /** A run the test finishes by hand. */
    function manual() {
      let finish!: () => void;
      const run = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      return { run, finish: () => finish() };
    }

    it('changes the Run text while idle, and shows Running while busy', async () => {
      const { run, finish } = manual();
      const runner = createRunner({ run, label: 'Start' }, true);
      expect(runner.button.textContent).toContain('Start');
      runner.setLabel('Resume');
      expect(runner.button.textContent).toContain('Resume');
      const running = runner.trigger();
      expect(runner.button.textContent).toContain('Running…');
      finish();
      await running;
      expect(runner.button.textContent).toContain('Resume');
    });

    it('can hide Run while busy', async () => {
      const { run, finish } = manual();
      const runner = createRunner({ run, hideWhileBusy: true }, true);
      document.body.append(runner.element);
      expect(runner.button.hidden).toBe(false);
      const running = runner.trigger();
      expect(runner.button.hidden).toBe(true);
      finish();
      await running;
      expect(runner.button.hidden).toBe(false);
    });

    it('leaves alone a Run button the tool hid itself (a bar built by hand before addAction)', async () => {
      const { run, finish } = manual();
      const runner = createRunner({ run }, true);
      document.body.append(runner.element);
      runner.button.hidden = true;
      const running = runner.trigger();
      expect(runner.button.hidden).toBe(true);
      finish();
      await running;
      expect(runner.button.hidden).toBe(true);
    });

    it('adds buttons that start a run with their argument, off exactly when Run is, with the reason', async () => {
      const seen: (string | undefined)[] = [];
      const runner = createRunner<string>(
        {
          run: (_signal, arg) => {
            seen.push(arg);
            return Promise.resolve();
          },
        },
        true,
      );
      document.body.append(runner.element);
      const step = runner.addAction({
        label: 'Step',
        icon: 'skip-end-fill',
        run: 'step',
        title: 'One turn',
      });
      expect(step.button.textContent).toContain('Step');
      expect(step.button.title).toBe('One turn');
      expect(step.button.getAttribute('aria-disabled')).toBe('false');

      step.button.click();
      await vi.waitFor(() => expect(seen).toEqual(['step']));

      runner.setDisabled('Add a topic first');
      expect(step.button.getAttribute('aria-disabled')).toBe('true');
      expect(step.button.title).toBe('Add a topic first');
      step.button.click();
      expect(seen).toEqual(['step']);

      runner.setDisabled(null);
      expect(step.button.title).toBe('One turn');
    });

    it('shows idle buttons only while idle and busy buttons only while a run is going', async () => {
      const { run, finish } = manual();
      const runner = createRunner({ run }, true);
      document.body.append(runner.element);
      const step = runner.addAction({ label: 'Step', run: undefined });
      const pause = runner.addAction({ label: 'Pause', when: 'busy', onClick: () => undefined });
      expect(step.button.hidden).toBe(false);
      expect(pause.button.hidden).toBe(true);

      const running = runner.trigger();
      expect(step.button.hidden).toBe(true);
      expect(pause.button.hidden).toBe(false);
      finish();
      await running;
      expect(step.button.hidden).toBe(false);
      expect(pause.button.hidden).toBe(true);
      // The bar reads: Run, the actions in call order, Stop, then the hint.
      const order = [...runner.element.children].map((child) => child.getAttribute('data-testid'));
      expect(order).toEqual(['run-button', null, null, 'stop-button', 'run-hint']);
    });

    it('lets the tool turn an action off with a reason and relabel it; an off action does nothing', () => {
      const onClick = vi.fn();
      const runner = createRunner({ run: () => Promise.resolve() }, true);
      const pause = runner.addAction({
        label: 'Pause',
        when: 'busy',
        onClick,
        title: 'Pause after this turn',
      });
      pause.button.hidden = false;
      pause.button.click();
      expect(onClick).toHaveBeenCalledOnce();

      pause.setLabel('Pausing…');
      pause.setDisabled('Pausing after this turn');
      expect(pause.button.textContent).toContain('Pausing…');
      expect(pause.button.getAttribute('aria-disabled')).toBe('true');
      expect(pause.button.title).toBe('Pausing after this turn');
      pause.button.click();
      expect(onClick).toHaveBeenCalledOnce();

      pause.setDisabled(null);
      expect(pause.button.getAttribute('aria-disabled')).toBe('false');
      expect(pause.button.title).toBe('Pause after this turn');
    });

    it('hands focus to the first visible control when the focused one hides, and back', async () => {
      const { run, finish } = manual();
      const runner = createRunner({ run, hideWhileBusy: true }, true);
      document.body.append(runner.element);
      const pause = runner.addAction({ label: 'Pause', when: 'busy', onClick: () => undefined });

      runner.button.focus();
      const running = runner.trigger();
      expect(document.activeElement).toBe(pause.button); // Run hid; Pause took its place

      runner.stopButton.focus();
      finish();
      await running;
      expect(document.activeElement).toBe(runner.button); // Stop hid; Run is back
    });

    it('leaves focus alone when it is outside the bar', async () => {
      const { run, finish } = manual();
      const outside = document.createElement('button');
      const runner = createRunner({ run, hideWhileBusy: true }, true);
      document.body.append(outside, runner.element);
      runner.addAction({ label: 'Pause', when: 'busy', onClick: () => undefined });
      outside.focus();
      const running = runner.trigger();
      expect(document.activeElement).toBe(outside);
      finish();
      await running;
      expect(document.activeElement).toBe(outside);
    });
  });
});
