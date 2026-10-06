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
 * | `rate-limited` | the message (whose limit it was), the limits in general, with Retry |
 * | `network` | the message, with Retry |
 * | `storage-full` | a link to Settings → Data |
 * | `storage-unavailable` | that the browser blocks saving and what to do (no Retry: nothing helps until the user allows site data) |
 * | anything else | `userMessage(error)`, with Retry when given |
 *
 * Before the codes: a paid request that may have gone through (`isOutcomeUnknown`, set by the API client) never gets
 * a plain Retry. The toast says it may be billed and offers `safeAction` (e.g. Check status), or else a link to
 * OpenRouter's activity log; Retry is added only when the caller says a resend is safe (`retryUnknownOutcome`).
 *
 * Each error is shown once: one already presented (or marked by `markPresented`, as `outputPanel.fail` does
 * when it shows an error inline) is ignored.
 */
import { ApiError, errorCode, isOutcomeUnknown, userMessage } from '../../core/errors';
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
    code === 'storage-full' ||
    code === 'storage-unavailable'
  );
}

/** Silent outcomes: the user stopped it, or declined a budget confirmation. */
export function isStop(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'aborted' || code === 'cancelled';
}

export interface PresentErrorOptions {
  /**
   * Re-runs the failed action; offered as a button and called after unlocking or adding a key. Not offered when a
   * paid request may have gone through (`isOutcomeUnknown`) unless `retryUnknownOutcome` is set.
   */
  retry?: () => void;
  /**
   * Offered instead of Retry when a paid request may have gone through: a way to look without paying again, e.g.
   * `{ label: 'Check status', onClick: refreshJobs }` or a link. Default: OpenRouter's activity page.
   */
  safeAction?: ToastAction;
  /** Also offer `retry` after an unknown outcome: the caller knows sending again cannot pay twice. */
  retryUnknownOutcome?: boolean;
}

/** OpenRouter's log of every request and its cost (linked from its FAQ, checked 2026-10-04). */
export const OPENROUTER_ACTIVITY_URL = 'https://openrouter.ai/activity';

/** What happened to a paid request that may have gone through. */
const unknownOutcomeCause = (error: unknown): string =>
  error instanceof ApiError
    ? `OpenRouter answered with an error (${error.status}) instead of the result.`
    : 'The connection dropped after the request was sent.';

/** Why not to send it again. */
const MAY_BE_DONE = 'The provider may still have done the work and billed it';

/**
 * Model arena's sentence while names are hidden, shown under every failed panel alike (`FailureText.note`): an
 * unknown outcome only happens to paid requests, so a caution that came and went with the outcome would give a paid
 * model away.
 */
export const BLIND_ACTIVITY_NOTE =
  'Before retrying, you can check your OpenRouter activity to see whether this request was billed.';

export interface FailureText {
  /** The message to show inline. After an unknown outcome it says what happened and to check before sending again. */
  text: string;
  /**
   * A paid request may have gone through (`isOutcomeUnknown`): offer no plain Retry, and link `activityUrl`.
   * Always false when `blind`: whether a Retry is offered must not depend on the model.
   */
  outcomeUnknown: boolean;
  /**
   * OpenRouter's activity page, where the user can see whether the request went through: set when
   * `outcomeUnknown`, and always when `blind`. Otherwise null.
   */
  activityUrl: string | null;
  /** `blind` only: `BLIND_ACTIVITY_NOTE`, to show after `text` for every failure. Otherwise null. */
  note: string | null;
}

/**
 * A message that is true for any model: no mention of credits, free models or prices, no model or provider names
 * (OpenRouter's own messages carry them), and nothing that differs between a free and a paid model.
 */
function blindMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const { status } = error;
    if (status === 401) return userMessage(error); // the key, the same for every model
    if (status === 429) return 'Rate limited. Wait a moment, then try again.';
    if (status === 402 || status === 403) return 'OpenRouter did not accept this request.';
    if (status === 408 || status >= 500) return 'The request did not finish.';
    return 'OpenRouter could not process this request.';
  }
  const code = errorCode(error);
  // Their messages name the model or the cost.
  if (code === 'free-only' || code === 'budget-blocked') return 'This request could not start.';
  return userMessage(error);
}

/**
 * The text of an error a tool shows inline (on a reply, in a panel, on a row) instead of through `presentError`.
 * `userMessage` alone drops the caution a paid request that may have gone through needs; this keeps it, in the same
 * words as the toast.
 *
 * ```ts
 * const failure = failureText(error);
 * reply.error = failure.text;
 * if (failure.outcomeUnknown) show(externalLink(failure.activityUrl!, 'OpenRouter activity'));   // and no Retry
 * markPresented(error);   // the inline text is the presentation; the runner adds nothing
 * ```
 *
 * `blind` is for Model arena while names are hidden. Anything that differs between a free and a paid model would
 * give it away (a 402's "not enough credits", the 429 text about free models, a caution that appears only after an
 * unknown outcome, a missing Retry), so every failure reads alike: a generic `text`, the same `note`, the activity
 * link, `outcomeUnknown` false. Keep the real wording for after the reveal: call `failureText(error)` too.
 *
 * It only words the error: it does not mark it presented, and errors that need a dialog (`needsAction`) still go
 * through `presentError`.
 */
export function failureText(error: unknown, options: { blind?: boolean } = {}): FailureText {
  if (options.blind) {
    return {
      text: blindMessage(error),
      outcomeUnknown: false,
      activityUrl: OPENROUTER_ACTIVITY_URL,
      note: BLIND_ACTIVITY_NOTE,
    };
  }
  if (!isOutcomeUnknown(error)) {
    return { text: userMessage(error), outcomeUnknown: false, activityUrl: null, note: null };
  }
  return {
    text: `${unknownOutcomeCause(error)} ${MAY_BE_DONE}, so check your OpenRouter activity before sending it again.`,
    outcomeUnknown: true,
    activityUrl: OPENROUTER_ACTIVITY_URL,
    note: null,
  };
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
  if (isOutcomeUnknown(error)) {
    toast({
      variant: 'warning',
      title: 'This may have gone through',
      message: `${unknownOutcomeCause(error)} ${MAY_BE_DONE}, so check before sending it again.`,
      action: options.safeAction
        ? { testId: 'toast-safe-action', ...options.safeAction }
        : {
            label: 'OpenRouter activity',
            href: OPENROUTER_ACTIVITY_URL,
            external: true,
            testId: 'toast-activity',
          },
      ...(options.retryUnknownOutcome && retryAction ? { actions: [retryAction] } : {}),
      testId: 'error-toast',
    });
    return;
  }
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
        message: `${userMessage(error)} Every model has rate limits; free models allow 20 requests a minute and a daily quota (50 a day, or 1,000 once you have bought credits).`,
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
    case 'storage-unavailable':
      // No Retry (it would fail again), and no auto-hide: the user has to read what to change in the browser.
      toast({
        variant: 'danger',
        title: 'This browser blocks saving',
        message: userMessage(error),
        timeoutMs: 0,
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
