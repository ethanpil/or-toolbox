/**
 * `stopOnEscape(runner)`: Escape stops the run that is going, the way every tool with a long run should behave.
 * One handler on the document, built on `plainShortcutAllowed` (src/ui/shell/shortcuts.ts), so it stays out of the
 * way of the keys other things use:
 *
 * - modifiers (Ctrl+Esc, Cmd+Esc, Alt+Esc are the browser's and the system's), an open dialog, and fields and
 *   selects, which use Escape themselves (a search clears, a list closes) unless listed in `allowIn`;
 * - an input method composing text, a key press something else already handled (`defaultPrevented`), and a
 *   settings drawer or a dropdown menu that is open (Escape closes those first).
 *
 * ```ts
 * stopOnEscape(runner, { allowIn: [composer] }); // Chat: Escape in the message field stops the reply
 * ```
 */
import { composing, plainShortcutAllowed } from '../shell/shortcuts';
import type { Runner } from './types';

export interface StopOnEscapeOptions {
  /** Fields where Escape still stops the run (the tool's main input, which does not use it). */
  allowIn?: readonly EventTarget[];
}

/** Installs the handler; returns the function that removes it. */
export function stopOnEscape(
  runner: Pick<Runner, 'busy' | 'stop'>,
  options: StopOnEscapeOptions = {},
): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || composing(event) || !runner.busy || event.defaultPrevented)
      return;
    if (!plainShortcutAllowed(event, options.allowIn ? { allowIn: options.allowIn } : {})) return;
    if (document.querySelector('.offcanvas.show, .dropdown-menu.show')) return;
    event.preventDefault();
    runner.stop();
  };
  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}
