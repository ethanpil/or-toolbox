/**
 * `ui.confirmDiscard({ what, isDirty })`: the one "replace unsaved work?" question, asked before a run, a load or a
 * new file would throw away what the user made or edited and has not saved (an edited transcript, corrected grid
 * values, versions not downloaded). Resolves true when the tool may go ahead: at once when `isDirty()` says
 * nothing would be lost, else after the user chose Replace.
 *
 * Ask BEFORE `ctx.beginRun` (a declined question then changes nothing, like a refused run), and pass what would
 * be lost as words the user knows:
 *
 * ```ts
 * if (!(await ui.confirmDiscard({ what: 'your edited transcript and speaker names', isDirty: () => edited }))) return;
 * const run = await ctx.beginRun({ … }, signal);
 * ```
 */
import { confirmDialog } from '../feedback/dialogs';

export interface DiscardOptions {
  /** What would be lost, as the end of "This replaces …": "your edited transcript", "2 versions not downloaded". */
  what: string;
  /** Read when asked; false: nothing to lose, no question. Default: always ask. */
  isDirty?: () => boolean;
  /** Default "Replace your work?". */
  title?: string;
  /** Default "Replace". */
  confirmLabel?: string;
  /** Default `discard-dialog`. */
  testId?: string;
}

export async function confirmDiscard(options: DiscardOptions): Promise<boolean> {
  if (options.isDirty && !options.isDirty()) return true;
  return confirmDialog({
    title: options.title ?? 'Replace your work?',
    message: `This replaces ${options.what}. It is not saved anywhere else.`,
    confirmLabel: options.confirmLabel ?? 'Replace',
    tone: 'warning',
    testId: options.testId ?? 'discard-dialog',
  });
}
