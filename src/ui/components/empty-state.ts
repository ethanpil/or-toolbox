import { type Child, h } from '../dom';
import { icon } from '../icon';

export interface EmptyStateOptions {
  icon: string;
  title: string;
  text?: Child;
  /** A button or link (or several). */
  action?: Child;
  /** Less padding, for small panels. */
  compact?: boolean;
  /** One slim row (icon, text, action) instead of a centred block: for sections that should not take room. */
  inline?: boolean;
  testId?: string;
}

/**
 * The friendly "nothing here yet" block: a soft icon, a title, one sentence and an optional action. Used for
 * empty lists, empty outputs and "coming soon" pages, so every empty place in the app looks the same.
 */
export function emptyState(options: EmptyStateOptions): HTMLElement {
  const testId = options.testId ?? 'empty-state';
  if (options.inline) {
    return h(
      'div',
      {
        class: 'or-empty or-empty-inline d-flex align-items-center gap-3 p-3',
        'data-testid': testId,
      },
      h(
        'div',
        { class: 'or-empty-icon or-empty-icon-sm', 'aria-hidden': 'true' },
        icon(options.icon),
      ),
      h(
        'div',
        { class: 'flex-grow-1 min-w-0' },
        h('p', { class: 'fw-semibold mb-0' }, options.title),
        options.text && h('p', { class: 'small text-body-secondary mb-0' }, options.text),
      ),
      options.action && h('div', { class: 'd-flex flex-wrap gap-2' }, options.action),
    );
  }
  return h(
    'div',
    {
      class: ['or-empty text-center', options.compact ? 'py-4 px-3' : 'py-5 px-3'],
      'data-testid': testId,
    },
    h('div', { class: 'or-empty-icon mx-auto mb-3', 'aria-hidden': 'true' }, icon(options.icon)),
    h('p', { class: 'fw-semibold mb-1' }, options.title),
    options.text &&
      h('p', { class: 'text-body-secondary mb-0 mx-auto or-empty-text' }, options.text),
    options.action &&
      h('div', { class: 'mt-3 d-flex flex-wrap justify-content-center gap-2' }, options.action),
  );
}
