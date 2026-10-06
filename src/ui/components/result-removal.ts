/**
 * `resultRemoval()`: how an image, audio or video result card leaves the page, the same way for all three.
 *
 * - Remove (`removeByUser`) asks `beforeRemove`, by default a confirmation while the result is not downloaded
 *   (`confirmUndownloaded`; a tool opts out with `beforeRemove: () => true`, or composes its own check with it),
 *   then drops the result (`handle.remove()`), disposes the player or viewer, detaches the card, announces it and
 *   calls `onRemove`. Only then, unless `onRemove` moved focus itself, focus goes to the Remove button of the next
 *   card of the same kind (else the previous one), else to `focusFallback()`, asked last so it can return what
 *   `onRemove` showed (an empty state).
 * - `remove()` drops the card from code: no question, no announcement, no `onRemove`; focus moves only when it
 *   was inside the card.
 */
import { disposeBootstrap } from '../bootstrap';
import { focusKey } from '../dom';
import { announce } from '../feedback/announce';
import { confirmDialog } from '../feedback/dialogs';
import type { ResultHandle } from '../tool/types';

export interface ResultRemovalOptions {
  /** The card. */
  element: HTMLElement;
  /** Marks cards of this kind on the page (`or-image-result`), so focus can go to a neighbour. */
  cardClass: string;
  /** The `data-focus-key` of this card's Remove button. */
  removeKey: string;
  handle: ResultHandle;
  /** The card's heading, used in the announcement and the confirmation. */
  title: string;
  /** "image", "audio", "video": the confirmation's title says "Remove the image?". */
  noun: string;
  /** The confirmation's test id is `<testId>-remove-confirm`. */
  testId: string;
  beforeRemove?: (() => boolean | Promise<boolean>) | undefined;
  onRemove: () => void;
  focusFallback?: (() => HTMLElement | null | undefined) | undefined;
  /** Frees the player or viewer. */
  dispose: () => void;
}

export interface ResultRemoval {
  /** The Remove button's action. */
  removeByUser(): Promise<void>;
  /** Removes the card from code; safe to call twice. */
  remove(): void;
}

/** Each live card's Remove button key. */
const removeKeys = new WeakMap<Element, string>();

/** Focus fell to the page (its element was removed, or nothing has it). */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/**
 * The default `beforeRemove`: true at once when the result was downloaded, else a confirmation naming it. Tools with
 * a check of their own call it after theirs: `beforeRemove: () => !busy() && confirmUndownloaded(card.handle, …)`.
 */
export function confirmUndownloaded(
  handle: ResultHandle,
  title: string,
  noun: string,
  testId: string,
): boolean | Promise<boolean> {
  return (
    handle.result.downloaded ||
    confirmDialog({
      title: `Remove the ${noun}?`,
      message: `${title} was not downloaded. Once removed, it is gone from this page.`,
      confirmLabel: 'Remove',
      tone: 'danger',
      testId: `${testId}-remove-confirm`,
    })
  );
}

export function resultRemoval(options: ResultRemovalOptions): ResultRemoval {
  const { element, handle } = options;
  removeKeys.set(element, options.removeKey);

  let removed = false;
  /** Drops the card; returns the Remove keys of the cards that may take focus next, nearest first. */
  const detach = (): string[] => {
    removed = true;
    const cards = [...document.querySelectorAll(`.${options.cardClass}`)];
    const at = cards.indexOf(element);
    const next = (at < 0 ? [] : [...cards.slice(at + 1), ...cards.slice(0, at).reverse()]).flatMap(
      (card) => removeKeys.get(card) ?? [],
    );
    handle.remove();
    options.dispose();
    disposeBootstrap(element);
    removeKeys.delete(element);
    element.remove();
    return next;
  };
  const moveFocus = (next: readonly string[]): void => {
    for (const key of next) if (focusKey(document, key)) return;
    options.focusFallback?.()?.focus();
  };
  const ask =
    options.beforeRemove ??
    (() => confirmUndownloaded(handle, options.title, options.noun, options.testId));

  let asking = false;
  return {
    async removeByUser() {
      if (asking || removed) return;
      asking = true;
      try {
        if (!(await ask())) return;
      } finally {
        asking = false;
      }
      if (removed) return;
      const next = detach();
      announce(`Removed ${options.title}.`);
      options.onRemove();
      // After onRemove, so the fallback can be what it showed; a place onRemove focused itself is kept.
      if (focusLost()) moveFocus(next);
    },
    remove() {
      if (removed) return;
      const hadFocus = element.contains(document.activeElement);
      const next = detach();
      if (hadFocus) moveFocus(next);
    },
  };
}
