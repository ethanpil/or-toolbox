/**
 * The star that marks a favourite tool, a favourite model or a starred run: an icon-only toggle button.
 * `aria-pressed` carries the state (the label stays the same), the icon and tooltip follow it, and `setStarred`
 * updates a button in place, so a list does not have to re-render (and drop keyboard focus) to show a change.
 *
 * ```ts
 * const star = starButton({ pressed: isFavourite(id), label: `Favourite: ${name}`, onToggle: () => toggle(id) });
 * setStarred(star, true);
 * ```
 */
import { h } from '../dom';
import { icon } from '../icon';

export interface StarButtonOptions {
  pressed: boolean;
  /** The accessible name, e.g. `Favourite: Chat`. */
  label: string;
  onToggle: () => void;
  /** Tooltip while not pressed and while pressed; default `Add to favourites` / `Remove from favourites`. */
  titles?: readonly [off: string, on: string];
  /** Extra classes after `btn btn-sm btn-link or-star`. */
  class?: string;
  /** Keeps keyboard focus on this star when a list re-renders (`replace()` in dom.ts). */
  focusKey?: string;
  testId?: string;
  part?: string;
}

const DEFAULT_TITLES = ['Add to favourites', 'Remove from favourites'] as const;
const titlesOf = new WeakMap<HTMLElement, readonly [string, string]>();

export function starButton(options: StarButtonOptions): HTMLButtonElement {
  const button = h('button', {
    type: 'button',
    class: ['btn btn-sm btn-link or-star', options.class],
    'aria-label': options.label,
    'data-focus-key': options.focusKey,
    'data-part': options.part,
    'data-testid': options.testId,
    onclick: options.onToggle,
  });
  titlesOf.set(button, options.titles ?? DEFAULT_TITLES);
  setStarred(button, options.pressed);
  return button;
}

/** Shows `pressed` on a button made by `starButton`. */
export function setStarred(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
  button.title = (titlesOf.get(button) ?? DEFAULT_TITLES)[pressed ? 1 : 0];
  button.replaceChildren(icon(pressed ? 'star-fill' : 'star'));
}
