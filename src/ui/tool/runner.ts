/**
 * The Run/Stop bar behind `ctx.ui.runner()`. Run stays focusable while busy (`aria-disabled`, not `disabled`, so
 * keyboard users do not lose their place); Stop aborts the signal handed to `run`. Errors other than aborts and
 * declined budget confirmations go through `presentError` with a Retry.
 */
import { h } from '../dom';
import { announce } from '../feedback/announce';
import { isStop, presentError, wasPresented } from '../feedback/errors';
import { formatShortcut } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import type { Runner, RunnerOptions, RunnerState, Triggered } from './types';

export interface RunnerInternals<A = unknown> extends Runner<A> {
  /** Set by the framework (e.g. no model resolves); wins over the tool's own reason. */
  setFrameworkReason(reason: string | null): void;
}

export function createRunner<A = unknown>(
  options: RunnerOptions<A>,
  primary: boolean,
): RunnerInternals<A> {
  const hintId = uid('runner-hint');
  let busy = false;
  let controller: AbortController | null = null;
  let ownReason: string | null = null;
  let frameworkReason: string | null = null;
  const listeners = new Set<(state: RunnerState) => void>();
  let lastState = '';

  const label = h('span', null, options.label ?? 'Run');
  const spinner = h('span', {
    class: 'spinner-border spinner-border-sm',
    hidden: true,
    'aria-hidden': 'true',
  });
  const runIcon = icon(options.icon ?? 'play-fill');
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary d-inline-flex align-items-center gap-2 px-4 or-run-button',
      'aria-describedby': hintId,
      'aria-disabled': 'false',
      'data-testid': 'run-button',
      onclick: () => void trigger(),
    },
    spinner,
    runIcon,
    label,
    primary
      ? h('kbd', { class: 'or-kbd or-kbd-on-primary d-none d-md-inline' }, formatShortcut('↵'))
      : null,
  );
  const stopButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger d-inline-flex align-items-center gap-2',
      hidden: true,
      'data-testid': 'stop-button',
      onclick: () => stop(),
    },
    icon('stop-fill'),
    'Stop',
  );
  const hint = h(
    'span',
    { id: hintId, class: 'small text-body-secondary', 'data-testid': 'run-hint' },
    options.hint ?? '',
  );
  const element = h(
    'div',
    { class: 'or-runner d-flex flex-wrap align-items-center gap-2', 'data-testid': 'runner' },
    button,
    stopButton,
    hint,
  );

  const reason = (): string | null => frameworkReason ?? ownReason;

  const render = (): void => {
    const blocked = reason();
    button.setAttribute('aria-disabled', String(busy || blocked !== null));
    button.classList.toggle('disabled', blocked !== null);
    spinner.hidden = !busy;
    runIcon.hidden = busy;
    label.textContent = busy ? 'Running…' : (options.label ?? 'Run');
    stopButton.hidden = !busy;
    hint.textContent = blocked ?? options.hint ?? '';
    hint.classList.toggle('text-warning-emphasis', blocked !== null);
    const state: RunnerState = { busy, disabledReason: blocked };
    const signature = JSON.stringify(state);
    if (signature === lastState) return;
    lastState = signature;
    for (const fn of [...listeners]) fn(state);
  };

  function trigger(arg?: A): Triggered {
    if (busy || reason() !== null) return Object.assign(Promise.resolve(), { started: false });
    return Object.assign(execute(arg), { started: true });
  }

  async function execute(arg?: A): Promise<void> {
    busy = true;
    controller = new AbortController();
    render();
    try {
      await options.run(controller.signal, arg);
    } catch (error) {
      // Stop and a declined budget confirmation are silent; an error the output panel already showed inline
      // (`output.fail(error)`) is not shown again; anything else goes through presentError once, and its Retry
      // runs the same thing again (same argument). A paid request that may have gone through gets no Retry
      // (presentError offers `safeAction` instead) unless the tool set `retryUnknownOutcome`.
      if (isStop(error)) {
        if (!wasPresented(error)) announce('Stopped.');
      } else {
        void presentError(error, {
          retry: () => replay(arg),
          ...(options.safeAction ? { safeAction: options.safeAction } : {}),
          ...(options.retryUnknownOutcome ? { retryUnknownOutcome: true } : {}),
        });
      }
    } finally {
      busy = false;
      controller = null;
      render();
    }
  }

  /** The error toast's Retry: the same argument, narrowed by `replayArg` (null: nothing left to send). */
  function replay(arg?: A): void {
    const next = options.replayArg ? options.replayArg(arg) : arg;
    if (next === null) {
      announce('Nothing left to retry: every item already has a result.');
      return;
    }
    void trigger(next);
  }

  function stop(): void {
    controller?.abort(new DOMException('Stopped by the user.', 'AbortError'));
  }

  render();
  return {
    element,
    button,
    stopButton,
    get busy() {
      return busy;
    },
    get disabledReason() {
      return reason();
    },
    trigger,
    stop,
    setDisabled(next) {
      ownReason = next;
      render();
    },
    setFrameworkReason(next) {
      frameworkReason = next;
      render();
    },
    subscribe(fn) {
      listeners.add(fn);
      fn({ busy, disabledReason: reason() });
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/**
 * A `replayArg` for runners whose argument is a list of item keys: keeps the keys `isDone` says still need doing,
 * null when none is left. A plain run (no argument) stays a plain run; tools whose Run already skips finished
 * items need nothing more.
 */
export function pendingOnly<K>(
  isDone: (key: K) => boolean,
): (keys: readonly K[] | undefined) => K[] | undefined | null {
  return (keys) => {
    if (keys === undefined) return undefined;
    const left = keys.filter((key) => !isDone(key));
    return left.length > 0 ? left : null;
  };
}
