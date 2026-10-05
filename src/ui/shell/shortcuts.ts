/**
 * Rules for page-wide keyboard shortcuts, so they all behave the same way. A shortcut made of a plain key (Home's
 * `/`) must stay out of the way of typing and of dialogs; one made with Ctrl or Cmd (the palette's Ctrl/Cmd+K)
 * also works inside a text field, but never opens on top of another dialog.
 */
import { modalOpen } from '../feedback/modal';

/** True when typed characters would go into the event's target: a field, a select or editable text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable === true)
  );
}

/** True while an input method is composing text: Enter and Escape belong to it, not to the page. */
export const composing = (event: KeyboardEvent): boolean =>
  event.isComposing || event.keyCode === 229;

/**
 * A plain-key shortcut may fire only without modifiers, with no dialog open and nothing being typed into.
 * `allowIn` lists fields where the key still counts, because the shortcut is meant for them (Escape stops a reply
 * from the message field, which has no use for it).
 */
export function plainShortcutAllowed(
  event: KeyboardEvent,
  options: { allowIn?: readonly EventTarget[] } = {},
): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !modalOpen() &&
    (!isTypingTarget(event.target) ||
      (event.target !== null && options.allowIn?.includes(event.target) === true))
  );
}
