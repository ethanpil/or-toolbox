import { h } from '../dom';

/** A link that opens in a new tab and says so to screen readers. */
export function externalLink(href: string, text: string, className?: string): HTMLElement {
  return h(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer', class: className },
    text,
    h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'),
  );
}
