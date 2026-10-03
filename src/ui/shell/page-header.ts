import { type Child, h } from '../dom';
import { icon } from '../icon';

export interface PageHeaderOptions {
  title: string;
  /** Bootstrap Icons name shown in a tinted tile before the title. */
  icon?: string;
  /** One muted line under the title. */
  lead?: Child;
  /** Buttons or links on the right (wrap below the title on phones). */
  actions?: Child;
  /** Extra content under the lead (chips, badges). */
  meta?: Child;
}

/**
 * The page title block every page starts with: icon tile, `<h1 data-testid="page-title">`, muted lead and
 * optional actions. There is exactly one per page.
 */
export function pageHeader(options: PageHeaderOptions): HTMLElement {
  return h(
    'div',
    { class: 'or-page-header d-flex flex-wrap align-items-start gap-3 mb-4' },
    options.icon && h('div', { class: 'or-icon-tile', 'aria-hidden': 'true' }, icon(options.icon)),
    h(
      'div',
      { class: 'or-header-text' },
      h('h1', { class: 'or-page-title mb-1', 'data-testid': 'page-title' }, options.title),
      options.lead && h('p', { class: 'or-page-lead text-body-secondary mb-0' }, options.lead),
      options.meta,
    ),
    options.actions &&
      h('div', { class: 'd-flex flex-wrap align-items-center gap-2' }, options.actions),
  );
}
