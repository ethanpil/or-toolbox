import { h } from './dom';

/**
 * A decorative Bootstrap Icons glyph: `icon('gear')`, `icon('star-fill', 'text-warning')`. Always
 * `aria-hidden`; the control it sits in must carry the accessible name.
 */
export function icon(name: string, className?: string): HTMLElement {
  return h('i', { class: ['bi', `bi-${name}`, className], 'aria-hidden': 'true' });
}
