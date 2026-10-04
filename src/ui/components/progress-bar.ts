/**
 * `progressBar({ label })`: Bootstrap's progress bar as a labelled `role="progressbar"` with the values screen
 * readers read (`aria-valuenow`/`max`, and `aria-valuetext` such as "3 of 20 pages"). Its width transition stops
 * under reduced motion (the OS setting or Settings → Appearance; see src/styles/_motion.scss). Pair it with
 * `ui.progress(text)` for the visible counter; the bar itself never announces.
 *
 * ```ts
 * const bar = progressBar({ label: 'Pages read', testId: 'ocr-progress' });
 * bar.update(3, 20, '3 of 20 pages');
 * ```
 */
import { h } from '../dom';

export interface ProgressBarOptions {
  /** Accessible name, e.g. "Pages read". */
  label: string;
  /** Start hidden (show it with `element.hidden = false` or `update`). Default false. */
  hidden?: boolean;
  /** Extra classes on the `.progress` element, e.g. `mb-3`. */
  class?: string;
  testId?: string;
}

export interface ProgressBar {
  readonly element: HTMLElement;
  /** `done` of `total` (nothing to do: an empty bar); `text` becomes `aria-valuetext`. */
  update(done: number, total: number, text?: string): void;
}

export function progressBar(options: ProgressBarOptions): ProgressBar {
  const bar = h('div', { class: 'progress-bar' });
  const element = h(
    'div',
    {
      class: ['progress', options.class],
      role: 'progressbar',
      'aria-label': options.label,
      'aria-valuemin': '0',
      'aria-valuemax': '0',
      'aria-valuenow': '0',
      hidden: options.hidden ?? false,
      'data-testid': options.testId,
    },
    bar,
  );
  return {
    element,
    update(done, total, text) {
      const max = Math.max(0, total);
      const now = Math.min(Math.max(0, done), max);
      element.setAttribute('aria-valuemax', String(max));
      element.setAttribute('aria-valuenow', String(now));
      if (text) element.setAttribute('aria-valuetext', text);
      else element.removeAttribute('aria-valuetext');
      bar.style.width = max > 0 ? `${Math.round((now / max) * 100)}%` : '0%';
    },
  };
}
