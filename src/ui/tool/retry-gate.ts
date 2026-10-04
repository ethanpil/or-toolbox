/**
 * `retryGate(runner)`: per-item Retry buttons (a failed page, document or part) that follow their tool's runner.
 *
 * - `bind(button)` keeps a button in step with the runner: while Run is busy or disabled it shows as unavailable
 *   (`aria-disabled`, the `disabled` class, the reason as its title) but stays focusable, so keyboard users keep
 *   their place. Buttons that leave the page are forgotten.
 * - `retry(arg)` triggers the runner with `arg` (the error toast's Retry then repeats the same items); when it
 *   cannot start, it announces why instead of doing nothing.
 * - When a focused bound button disappears (its item re-rendered as running, say) and nothing else took focus,
 *   focus goes to `fallback()` (default: the runner's Run button) instead of dropping to the page.
 *
 * ```ts
 * const gate = retryGate(runner);
 * item.append(gate.bind(h('button', { type: 'button', onclick: () => gate.retry([doc.key]) }, 'Retry')));
 * ```
 */
import { announce } from '../feedback/announce';
import type { Runner, RunnerState } from './types';

export interface RetryGate<A> {
  /** Why a Retry cannot start now ("Wait until the current run ends." while busy, or why Run is disabled), or null. */
  blocked(): string | null;
  /** Keeps `button` in step with the runner (see above); returns it. */
  bind<B extends HTMLElement>(button: B): B;
  /** Triggers the runner with `arg`; announces why when it cannot start (or `fallbackMessage`). Returns whether it started. */
  retry(arg: A, fallbackMessage?: string): boolean;
}

export interface RetryGateOptions {
  /** Where focus goes when a focused Retry button disappears and nothing else took focus. Default: Run. */
  fallback?: () => HTMLElement | null | undefined;
}

export const BUSY_REASON = 'Wait until the current run ends.';

export function retryGate<A>(runner: Runner<A>, options: RetryGateOptions = {}): RetryGate<A> {
  let state: RunnerState = { busy: runner.busy, disabledReason: runner.disabledReason };
  const bound = new Set<HTMLElement>();
  const seen = new WeakSet<HTMLElement>();

  const blocked = (): string | null => (state.busy ? BUSY_REASON : state.disabledReason);

  const paint = (button: HTMLElement): void => {
    const reason = blocked();
    button.setAttribute('aria-disabled', String(reason !== null));
    button.classList.toggle('disabled', reason !== null);
    button.title = reason ?? '';
  };

  runner.subscribe((next) => {
    state = next;
    for (const button of bound) {
      if (button.isConnected) {
        seen.add(button);
        paint(button);
      } else if (seen.has(button)) bound.delete(button);
    }
  });

  // Focus rescue: while a bound button has focus, watch for it leaving the page.
  let watched: { button: HTMLElement; observer: MutationObserver } | null = null;
  const unwatch = (): void => {
    watched?.observer.disconnect();
    watched = null;
  };
  const rescue = (): void => {
    if (!watched || watched.button.isConnected) return;
    unwatch();
    const active = document.activeElement;
    if (active && active !== document.body) return; // something else took focus (replace(), a dialog)
    const target = options.fallback?.() ?? runner.button;
    target?.focus();
  };
  const watch = (button: HTMLElement): void => {
    unwatch();
    if (typeof MutationObserver !== 'function') return;
    const observer = new MutationObserver(rescue);
    observer.observe(document.body, { childList: true, subtree: true });
    watched = { button, observer };
  };

  return {
    blocked,
    bind(button) {
      bound.add(button);
      if (button.isConnected) seen.add(button);
      paint(button);
      button.addEventListener('focus', () => watch(button));
      button.addEventListener('blur', () => {
        // A blur caused by removal is handled by the observer; a real blur ends the watch.
        queueMicrotask(() => {
          if (watched?.button === button && button.isConnected) unwatch();
        });
      });
      return button;
    },
    retry(arg, fallbackMessage) {
      const started = runner.trigger(arg).started;
      if (!started) announce(blocked() ?? fallbackMessage ?? 'This cannot start now.');
      return started;
    },
  };
}
