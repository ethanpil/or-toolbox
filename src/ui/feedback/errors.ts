/**
 * `presentError(error, { retry })`: the single place that turns a thrown value into something the user can act
 * on. It switches on `errorCode()` (src/core/errors.ts), never on classes:
 *
 * | code | shows |
 * | --- | --- |
 * | `cancelled`, `aborted` | nothing (the user stopped it) |
 * | `locked` | the unlock dialog, then `retry()` |
 * | `no-key` | a dialog to connect with OpenRouter or paste a key, then `retry()` |
 * | `free-only` | why, with a link to Settings → Default models |
 * | `budget-blocked` | the budget reasons, with a link to Settings → Budgets |
 * | `rate-limited` | the free-model limits, with Retry |
 * | `network` | the message, with Retry |
 * | `storage-full` | a link to Settings → Data |
 * | anything else | `userMessage(error)`, with Retry when given |
 *
 * Each error is shown once: one already presented (or marked by `markPresented`, as `outputPanel.fail` does
 * when it shows an error inline) is ignored.
 */
import { errorCode, userMessage } from '../../core/errors';
import { connectKey } from '../components/connect-key';
import { h } from '../dom';
import { settingsUrl } from '../shell/links';
import { openModal } from './modal';
import { type ToastAction, toast } from './toast';
import { unlockDialog } from './unlock';

/** Errors already shown to the user (inline in an output panel, say), so nothing shows them a second time. */
const presented = new WeakSet<object>();

/** Marks an error as shown; `presentError` then stays quiet about it. */
export function markPresented(error: unknown): void {
  if (typeof error === 'object' && error !== null) presented.add(error);
}

export function wasPresented(error: unknown): boolean {
  return typeof error === 'object' && error !== null && presented.has(error);
}

/**
 * Errors only `presentError` can handle well, because they need a dialog or a link to a setting (unlock, add a
 * key, budgets, free-only, storage). An output panel leaves these to it instead of showing them inline.
 */
export function needsAction(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code === 'no-key' ||
    code === 'locked' ||
    code === 'free-only' ||
    code === 'budget-blocked' ||
    code === 'storage-full'
  );
}

/** Silent outcomes: the user stopped it, or declined a budget confirmation. */
export function isStop(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'aborted' || code === 'cancelled';
}

export interface PresentErrorOptions {
  /** Re-runs the failed action; offered as a button and called after unlocking or adding a key. */
  retry?: () => void;
}

export async function presentError(
  error: unknown,
  options: PresentErrorOptions = {},
): Promise<void> {
  const retryAction: ToastAction | undefined = options.retry
    ? { label: 'Retry', onClick: options.retry, testId: 'toast-retry' }
    : undefined;

  if (wasPresented(error)) return;
  markPresented(error);
  switch (errorCode(error)) {
    case 'aborted':
    case 'cancelled':
      return;
    case 'locked':
      if ((await unlockDialog()) && options.retry) options.retry();
      return;
    case 'no-key':
      if ((await addKeyDialog(userMessage(error))) && options.retry) options.retry();
      return;
    case 'free-only':
      toast({
        variant: 'warning',
        title: 'Free-only mode is on',
        message: `${userMessage(error)} Pick a free model, or turn free-only mode off.`,
        action: { label: 'Model settings', href: settingsUrl('models') },
        testId: 'error-toast',
      });
      return;
    case 'budget-blocked':
      toast({
        variant: 'danger',
        title: 'Blocked by your budget',
        message: userMessage(error),
        action: { label: 'Budgets', href: settingsUrl('budgets') },
        testId: 'error-toast',
      });
      return;
    case 'rate-limited':
      toast({
        variant: 'warning',
        title: 'Rate limited',
        message:
          'Free models allow 20 requests a minute and a daily quota (50 a day, or 1,000 once you have bought credits). Wait a moment and try again, or use a paid model.',
        ...(retryAction ? { action: retryAction } : {}),
        testId: 'error-toast',
      });
      return;
    case 'network':
      toast({
        variant: 'danger',
        title: 'Network error',
        message: userMessage(error),
        ...(retryAction ? { action: retryAction } : {}),
        testId: 'error-toast',
      });
      return;
    case 'storage-full':
      toast({
        variant: 'danger',
        title: 'Browser storage is full',
        message: userMessage(error),
        action: { label: 'Free up space', href: settingsUrl('data') },
        testId: 'error-toast',
      });
      return;
    default:
      toast({
        variant: 'danger',
        message: userMessage(error),
        ...(retryAction ? { action: retryAction } : {}),
        testId: 'error-toast',
      });
  }
}

/** One "Add a key" dialog at a time: parallel runs that all lack a key share it. */
let addKeyPending: Promise<boolean> | null = null;

/** The "Add a key" dialog for `no-key`. Resolves true once a key was saved. */
function addKeyDialog(message: string): Promise<boolean> {
  addKeyPending ??= showAddKeyDialog(message).finally(() => {
    addKeyPending = null;
  });
  return addKeyPending;
}

async function showAddKeyDialog(message: string): Promise<boolean> {
  let added = false;
  const modal = openModal({
    title: 'Add an OpenRouter key',
    icon: 'key',
    body: [
      h('p', { class: 'text-body-secondary' }, message),
      connectKey({
        onAdded: () => {
          added = true;
          // Leave the success message visible for a moment before closing.
          setTimeout(() => modal.hide(), 900);
        },
      }),
    ],
    footer: [
      h('a', { class: 'btn btn-link me-auto', href: settingsUrl('keys') }, 'Manage keys'),
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Close',
      ),
    ],
    testId: 'add-key-dialog',
  });
  await modal.closed;
  return added;
}
