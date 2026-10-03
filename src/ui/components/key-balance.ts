/**
 * `keyBalanceView()`: what one key has left at OpenRouter (`GET /key`), with one state machine and one wording
 * for every place that shows it: Settings → Keys (the full view: figures, a meter, Refresh), the Stats keys table
 * and the navbar's key menu (`compact`: a line). It checks the lock first (locked → an Unlock button), shows
 * "Checking…" while the request is out, and turns a failure into text: a 401 means OpenRouter no longer knows
 * the key, anything else is `userMessage()`.
 *
 * ```ts
 * const balance = keyBalanceView(core, key, { compact: true });
 * cell.append(balance.element);
 * balance.load();
 * ```
 *
 * The view keeps what it last knew, so a page can repaint it (the lock changed) without asking again: a page
 * that re-renders on every keys or settings change calls `loadMissing()`, which asks only when nothing is known,
 * and every request goes through `keys.status()`, whose short cache answers repeats. A refresh that fails keeps
 * a balance already on show (with a line saying the refresh failed).
 */
import { ApiError, errorCode, userMessage } from '../../core/errors';
import type { CoreServices, KeyInfo, KeyStatus } from '../../core/types';
import { type Child, h, replace } from '../dom';
import { announce } from '../feedback/announce';
import { presentError } from '../feedback/errors';
import { unlockDialog } from '../feedback/unlock';
import { formatRelativeTime, formatUsd, keyBalance } from '../format';
import { icon } from '../icon';
import { meter } from './meter';

type State =
  | { kind: 'loading' }
  /** `refreshFailed`: the last refresh failed, so `status` is the balance from before it. */
  | { kind: 'ok'; status: KeyStatus; refreshFailed?: unknown }
  | { kind: 'error'; error: unknown };

export interface KeyBalanceOptions {
  /** One line instead of the figures, the meter and Refresh. */
  compact?: boolean;
  /** With `compact`: a second line with the usage and when it was checked. */
  detail?: boolean;
}

export interface KeyBalanceView {
  element: HTMLElement;
  /** Asks for the balance (the core's short cache answers, or the network with `force`) and repaints. */
  load(force?: boolean): void;
  /**
   * Loads only when no balance is known (never loaded, or the lock was in the way), else repaints what is known:
   * for pages that re-render on every keys or settings change.
   */
  loadMissing(): void;
  /** Repaints from what is known now, e.g. after the lock changed. */
  paint(): void;
}

/** Why a balance could not be read, in words. */
export function balanceProblem(error: unknown): string {
  if (error instanceof ApiError && error.status === 401)
    return 'OpenRouter rejected this key. It may have been deleted or disabled there.';
  return userMessage(error);
}

const spinner = (): HTMLElement =>
  h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' });

export function keyBalanceView(
  core: CoreServices,
  key: KeyInfo,
  options: KeyBalanceOptions = {},
): KeyBalanceView {
  const compact = options.compact === true;
  const element = compact
    ? h('span', { class: 'd-inline-block' })
    : h('div', { class: 'or-key-balance rounded-3 p-3 mt-3', 'data-testid': 'key-balance' });
  let state: State | null = null;
  /** The current name: a rename must reach the labels without a new view. */
  const name = (): string => core.keys.get(key.id)?.name ?? key.name;

  const locked = (): boolean =>
    !core.keys.lock.unlocked() || (state?.kind === 'error' && errorCode(state.error) === 'locked');

  const fullBalance = (status: KeyStatus, refreshFailed: unknown): Child => {
    const balance = keyBalance(status);
    const stat = (label: string, value: Child, testId: string): HTMLElement =>
      h(
        'div',
        { class: 'col' },
        h('div', { class: 'small text-body-secondary' }, label),
        h('div', { class: 'fw-semibold', 'data-testid': testId }, value),
      );
    return [
      h(
        'div',
        { class: 'd-flex align-items-start gap-2' },
        h(
          'div',
          { class: 'row row-cols-2 row-cols-md-4 g-3 flex-grow-1' },
          stat(balance.usageLabel, balance.usage, 'key-usage'),
          stat(
            'Credit limit',
            [
              balance.limit,
              balance.reset &&
                h('span', { class: 'fw-normal small text-body-secondary' }, ` (${balance.reset})`),
            ],
            'key-limit',
          ),
          stat('Remaining', balance.remaining ?? '—', 'key-remaining'),
          stat('Free requests today', balance.freeDaily ?? '—', 'key-free-daily'),
        ),
        refreshButton(false),
      ),
      balance.remainingPercent !== null &&
        h(
          'div',
          { class: 'mt-3' },
          meter({
            percent: balance.remainingPercent,
            tone:
              balance.remainingPercent <= 10
                ? 'danger'
                : balance.remainingPercent <= 25
                  ? 'warning'
                  : 'success',
            label: `Credit left on ${name()}`,
            text: `${balance.remainingPercent}% of the limit left`,
          }),
        ),
      h(
        'div',
        { class: 'small text-body-secondary mt-2' },
        status.isFreeTier ? 'No credits bought yet (free tier). ' : '',
        `Checked ${formatRelativeTime(status.fetchedAt)}.`,
      ),
      refreshFailed !== undefined &&
        h(
          'div',
          { class: 'small text-warning-emphasis mt-1', 'data-testid': 'key-balance-stale' },
          icon('exclamation-circle', 'me-1'),
          'Could not refresh: ',
          balanceProblem(refreshFailed),
        ),
    ];
  };

  /** Stays in place (aria-disabled, still focusable) while loading, so keyboard focus survives the refresh. */
  const refreshButton = (loading: boolean): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        class: ['btn btn-sm btn-outline-secondary', loading && 'disabled'],
        'aria-label': `Refresh the balance of ${name()}`,
        'aria-disabled': loading ? 'true' : null,
        title: 'Refresh balance',
        'data-testid': 'key-refresh',
        'data-focus-key': `key:${key.id}:refresh`,
        onclick: () => {
          if (state?.kind !== 'loading') load(true);
        },
      },
      icon('arrow-clockwise'),
    );

  const unlockButton = (): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        class: compact ? 'btn btn-sm btn-outline-secondary' : 'btn btn-sm btn-outline-primary',
        'data-testid': compact ? 'balance-unlock' : 'key-unlock',
        'data-focus-key': `key:${key.id}:unlock`,
        onclick: () => {
          void unlockDialog()
            .then((ok) => {
              if (ok) load();
            })
            .catch((error: unknown) => void presentError(error));
        },
      },
      compact ? [icon('unlock', 'me-1'), 'Unlock to see'] : 'Unlock',
    );

  const paint = (): void => {
    let body: Child;
    if (locked()) {
      body = compact
        ? unlockButton()
        : h(
            'div',
            { class: 'd-flex flex-wrap align-items-center gap-2 small' },
            icon('lock', 'text-body-secondary'),
            h('span', { class: 'text-body-secondary' }, 'Unlock your keys to see the balance.'),
            unlockButton(),
          );
    } else if (!state || state.kind === 'loading') {
      body = compact
        ? h(
            'span',
            { class: 'd-inline-flex align-items-center gap-2 text-body-secondary' },
            spinner(),
            'Checking the balance…',
          )
        : h(
            'div',
            { class: 'd-flex align-items-center gap-2 small text-body-secondary' },
            spinner(),
            h('span', { class: 'flex-grow-1' }, 'Checking the balance with OpenRouter…'),
            refreshButton(true),
          );
    } else if (state.kind === 'error') {
      const problem = balanceProblem(state.error);
      body = compact
        ? h(
            'span',
            { class: 'text-body-secondary', title: problem, 'data-testid': 'balance-error' },
            'Unavailable',
          )
        : h(
            'div',
            { class: 'd-flex flex-wrap align-items-center gap-2 small' },
            icon('exclamation-circle', 'text-warning-emphasis'),
            h('span', { 'data-testid': 'key-balance-error' }, 'Balance unavailable: ', problem),
            refreshButton(false),
          );
    } else {
      body = compact
        ? compactBalance(state.status, options.detail === true)
        : fullBalance(state.status, state.refreshFailed);
    }
    replace(element, body);
  };

  let pending = false;
  const load = (force = false): void => {
    if (pending) return;
    if (!core.keys.lock.unlocked()) {
      state = null;
      paint();
      return;
    }
    const shown = state?.kind === 'ok' ? state.status : null;
    // A refresh of a balance already on show keeps it there until the new one arrives.
    if (force || !state || state.kind === 'error') {
      state = { kind: 'loading' };
      paint();
    }
    pending = true;
    core.keys
      .status(key.id, { force })
      .then((status) => {
        state = { kind: 'ok', status };
        if (force) announce(`Balance of ${name()} updated.`);
      })
      .catch((error: unknown) => {
        // A failed refresh keeps the balance that was on show; a lock hides it (paint() checks the lock).
        state =
          shown && errorCode(error) !== 'locked'
            ? { kind: 'ok', status: shown, refreshFailed: error }
            : { kind: 'error', error };
        if (force) announce(`The balance of ${name()} could not be checked.`);
      })
      .finally(() => {
        pending = false;
        paint();
      });
  };

  const loadMissing = (): void => {
    const missing =
      state === null || (state.kind === 'error' && errorCode(state.error) === 'locked');
    if (missing) load();
    else paint();
  };

  paint();
  return { element, load, loadMissing, paint };
}

function compactBalance(status: KeyStatus, detail: boolean): Child {
  const line =
    status.limitUsd !== null
      ? h(
          'span',
          { 'data-testid': 'balance' },
          `${formatUsd(status.limitRemainingUsd ?? Math.max(0, status.limitUsd - status.usageUsd))} left`,
          h('span', { class: 'text-body-secondary' }, ` of ${formatUsd(status.limitUsd)}`),
        )
      : h(
          'span',
          { 'data-testid': 'balance' },
          `${formatUsd(status.usageUsd)} used`,
          h(
            'span',
            { class: 'text-body-secondary' },
            status.isFreeTier ? ' · free tier' : ' · no limit',
          ),
        );
  if (!detail) return line;
  const balance = keyBalance(status);
  return [
    line,
    h(
      'div',
      { class: 'text-body-secondary' },
      `${balance.usage} ${balance.usageLabel === 'Used this month' ? 'used this month' : 'used in total'} · checked ${formatRelativeTime(status.fetchedAt)}`,
    ),
  ];
}

/**
 * OpenRouter's free-model counter for the account, from the default key only (keys of one account share the
 * counter, so asking every key would only cost requests), or null when locked, unreadable or not reported.
 */
export async function accountFreeDaily(core: CoreServices): Promise<KeyStatus['freeDaily']> {
  const key = core.keys.resolve();
  if (!key || !core.keys.lock.unlocked()) return null;
  try {
    return (await core.keys.status(key.id)).freeDaily;
  } catch {
    return null;
  }
}
