/**
 * `loadInto()`: the skeleton, status line and error state that every list which loads asynchronously needs.
 *
 * ```ts
 * void loadInto(list, async () => render(await core.history.query({})), {
 *   status: (text) => (count.textContent = text),
 *   messages: { loading: 'Loading history…', failed: 'History could not be loaded.' },
 *   error: { title: 'History could not be loaded', text: 'Browser storage is unavailable.' },
 *   retry: () => void reload(),
 * });
 * ```
 *
 * It shows the skeleton while `load` runs (unless the container already shows content and `keepOnLiveFailure`
 * is set: a live update then changes nothing until it has data), draws what `load` returns (return nothing when
 * `load` renders itself), and when `load` throws, shows the error state with a "Try again" button instead, and
 * hands the error to `presentError` with a Retry action. A newer call on the same container supersedes an older
 * one, so a slow answer never overwrites a fresh one.
 */
import { type Child, h, replace } from '../dom';
import { presentError } from '../feedback/errors';
import { emptyState, type EmptyStateOptions } from './empty-state';

export interface LoadIntoOptions {
  /** What shows while loading; default `listSkeleton()`. */
  skeleton?: Child;
  /** Receives a short text for a live region: `messages.loading` first, then `messages.failed` on failure. */
  status?: (text: string) => void;
  messages?: { loading?: string; failed?: string };
  /** The inline error state. */
  error: Omit<EmptyStateOptions, 'icon' | 'action'> & { icon?: string };
  /** Runs again when the user presses "Try again" (or Retry on the error toast). */
  retry: () => void;
  /**
   * A reload while content is on screen leaves that content alone when it fails (and shows no skeleton), so a
   * live update that cannot read storage does not wipe a list the user is reading.
   */
  keepOnLiveFailure?: boolean;
  /** Also show the failure as a toast, even when the content on screen was kept (default: only inline). */
  toast?: boolean;
}

const generations = new WeakMap<HTMLElement, number>();
const shownContent = new WeakSet<HTMLElement>();

/** Resolves true when `load` succeeded and was not superseded. */
export async function loadInto(
  container: HTMLElement,
  load: () => Promise<Child | void>,
  options: LoadIntoOptions,
): Promise<boolean> {
  const mine = (generations.get(container) ?? 0) + 1;
  generations.set(container, mine);
  const live = options.keepOnLiveFailure === true && shownContent.has(container);
  if (!live) {
    replace(container, options.skeleton ?? listSkeleton());
    shownContent.delete(container);
    if (options.messages?.loading) options.status?.(options.messages.loading);
  }
  try {
    const content = await load();
    if (generations.get(container) !== mine) return false;
    if (content !== undefined) replace(container, content);
    shownContent.add(container);
    return true;
  } catch (error) {
    if (generations.get(container) !== mine) return false;
    if (live) {
      if (options.toast) void presentError(error, { retry: options.retry });
      return false;
    }
    replace(
      container,
      emptyState({
        icon: 'exclamation-triangle',
        ...options.error,
        action: h(
          'button',
          { type: 'button', class: 'btn btn-outline-primary btn-sm', onclick: options.retry },
          'Try again',
        ),
      }),
    );
    shownContent.delete(container);
    if (options.messages?.failed) options.status?.(options.messages.failed);
    if (options.toast) void presentError(error, { retry: options.retry });
    return false;
  }
}

/** Grey placeholder rows for a list that is loading (decorative: hidden from assistive technology). */
export function listSkeleton(rows = 4, className = 'list-group shadow-sm'): HTMLElement {
  return h(
    'div',
    { class: [className, 'placeholder-glow'], 'aria-hidden': 'true' },
    Array.from({ length: rows }, () =>
      h(
        'div',
        { class: 'list-group-item py-3' },
        h('span', { class: 'placeholder col-6 d-block mb-2' }),
        h('span', { class: 'placeholder placeholder-sm col-4 d-block' }),
      ),
    ),
  );
}
