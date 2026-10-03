/**
 * The Run/Stop bar behind `ctx.ui.runner()`. Run stays focusable while busy (`aria-disabled`, not `disabled`, so
 * keyboard users do not lose their place); Stop aborts the signal handed to `run`. Errors other than aborts and
 * declined budget confirmations go through `presentError` with a Retry.
 */
import { errorCode } from '../../core/errors';
import { h } from '../dom';
import { announce } from '../feedback/announce';
import { presentError } from '../feedback/errors';
import { formatShortcut } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import type { Runner, RunnerOptions } from './types';

export interface RunnerInternals extends Runner {
  /** Set by the framework (e.g. no model resolves); wins over the tool's own reason. */
  setFrameworkReason(reason: string | null): void;
}

export function createRunner(options: RunnerOptions, primary: boolean): RunnerInternals {
  const hintId = uid('runner-hint');
  let busy = false;
  let controller: AbortController | null = null;
  let ownReason: string | null = null;
  let frameworkReason: string | null = null;

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
  };

  async function trigger(): Promise<void> {
    if (busy || reason() !== null) return;
    busy = true;
    controller = new AbortController();
    render();
    try {
      await options.run(controller.signal);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'aborted' || code === 'cancelled') announce('Stopped.');
      else void presentError(error, { retry: () => void trigger() });
    } finally {
      busy = false;
      controller = null;
      render();
    }
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
  };
}
