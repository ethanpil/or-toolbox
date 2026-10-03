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
 */
import { errorCode, userMessage } from '../../core/errors';
import { connectKey } from '../components/connect-key';
import { h } from '../dom';
import { settingsUrl } from '../shell/links';
import { openModal } from './modal';
import { type ToastAction, toast } from './toast';
import { unlockDialog } from './unlock';

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
        timeoutMs: 12_000,
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
        timeoutMs: 12_000,
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

/** The "Add a key" dialog for `no-key`. Resolves true once a key was saved. */
async function addKeyDialog(message: string): Promise<boolean> {
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
