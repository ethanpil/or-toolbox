/**
 * Settings → Keys: every stored key (colour, name, masked secret, source, default), its live balance from
 * `GET /key` (loaded when the section is first shown, refreshable), the "no retention" preference, rename,
 * recolour, make default, remove with Undo, and adding a key (Connect with OpenRouter or paste).
 *
 * Undo of a removal puts just that key back into the keys file as it is at Undo time (its stored record, same
 * id, at its old position, through `keys.replaceFile` with `expected` = that file), then restores the settings
 * the removal cleared (default key, tool pins, per-key budget) where nothing else has taken their place. Only if
 * the passphrase lock changed in between is the key added again from its secret, which is held in memory for
 * the Undo window only and dropped when the toast closes.
 */
import { ApiError, errorCode, InvalidInputError, userMessage } from '../../core/errors';
import type { CoreServices, KeyInfo, KeyStatus, StoredKey, ToolId } from '../../core/types';
import { connectKey } from '../../ui/components/connect-key';
import { emptyState } from '../../ui/components/empty-state';
import { keyDot } from '../../ui/components/key-picker';
import { type Child, h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { unlockDialog } from '../../ui/feedback/unlock';
import { formatRelativeTime } from '../../ui/format';
import { icon } from '../../ui/icon';
import { OPENROUTER_KEYS_URL, settingsUrl } from '../../ui/shell/links';
import { keyBalance } from './logic';
import { attempt, card, externalLink, meter, rerender, type SectionView, switchField } from './ui';

type BalanceState =
  { state: 'loading' } | { state: 'ok'; status: KeyStatus } | { state: 'error'; error: unknown };

/** What Undo needs to put a removed key back. */
interface RemovedKey {
  record: StoredKey;
  /** Its position in the list. */
  index: number;
  /** The lock it was stored under (JSON), to know whether the record still fits the file. */
  lock: string;
  /** Plain secret, only for re-adding it if the lock changed; null when it could not be read. */
  secret: string | null;
  wasDefault: boolean;
  /** The default key right after the removal: Undo restores the default only if it is still this one. */
  defaultAfter: string | null;
  pinned: ToolId[];
  budget: number | null | undefined;
}

/** Shown for keys without a colour (the dot itself is grey then). */
const NO_COLOUR = '#6c757d';

export function keysSection(core: CoreServices): SectionView {
  const list = h('div', { 'data-testid': 'keys-list' });
  const balances = new Map<string, BalanceState>();
  /** Balance containers of the rendered rows, so a balance re-renders without touching the rest. */
  const balanceSlots = new Map<string, HTMLElement>();
  let shown = false;

  // --- balance ------------------------------------------------------------------------------------------
  const loadBalance = (key: KeyInfo, force = false): void => {
    if (!core.keys.lock.unlocked()) {
      balances.delete(key.id);
      renderBalance(key);
      return;
    }
    balances.set(key.id, { state: 'loading' });
    renderBalance(key);
    core.keys
      .status(key.id, { force })
      .then((status) => {
        balances.set(key.id, { state: 'ok', status });
        if (force) announce(`Balance of ${key.name} updated.`);
      })
      .catch((error: unknown) => {
        balances.set(key.id, { state: 'error', error });
        if (force) announce(`The balance of ${key.name} could not be checked.`);
      })
      .finally(() => {
        const current = core.keys.get(key.id);
        if (current) renderBalance(current);
      });
  };

  const loadMissing = (): void => {
    for (const key of core.keys.list()) if (!balances.has(key.id)) loadBalance(key);
  };

  const balanceError = (error: unknown): string => {
    if (error instanceof ApiError && error.status === 401)
      return 'OpenRouter rejected this key. It may have been deleted or disabled there.';
    return userMessage(error);
  };

  const stat = (label: string, value: Child, testId?: string): HTMLElement =>
    h(
      'div',
      { class: 'col' },
      h('div', { class: 'small text-body-secondary' }, label),
      h('div', { class: 'fw-semibold', 'data-testid': testId }, value),
    );

  const renderBalance = (key: KeyInfo): void => {
    const slot = balanceSlots.get(key.id);
    if (!slot) return;
    const entry = balances.get(key.id);
    const loading = entry?.state === 'loading';
    // Stays in place (aria-disabled, still focusable) while loading, so keyboard focus survives the refresh.
    const refresh = h(
      'button',
      {
        type: 'button',
        class: ['btn btn-sm btn-outline-secondary', loading && 'disabled'],
        'aria-label': `Refresh the balance of ${key.name}`,
        'aria-disabled': loading ? 'true' : null,
        title: 'Refresh balance',
        'data-testid': 'key-refresh',
        'data-focus': `key:${key.id}:refresh`,
        onclick: () => {
          if (balances.get(key.id)?.state !== 'loading') loadBalance(key, true);
        },
      },
      icon('arrow-clockwise'),
    );
    let body: Child;
    if (
      !core.keys.lock.unlocked() ||
      (entry?.state === 'error' && errorCode(entry.error) === 'locked')
    ) {
      body = h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2 small' },
        icon('lock', 'text-body-secondary'),
        h('span', { class: 'text-body-secondary' }, 'Unlock your keys to see the balance.'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-primary',
            'data-testid': 'key-unlock',
            'data-focus': `key:${key.id}:unlock`,
            onclick: () => {
              void unlockDialog()
                .then((ok) => {
                  if (ok) for (const each of core.keys.list()) loadBalance(each);
                })
                .catch((error: unknown) => void presentError(error));
            },
          },
          'Unlock',
        ),
      );
    } else if (!entry || entry.state === 'loading') {
      body = h(
        'div',
        { class: 'd-flex align-items-center gap-2 small text-body-secondary' },
        h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }),
        h('span', { class: 'flex-grow-1' }, 'Checking the balance with OpenRouter…'),
        refresh,
      );
    } else if (entry.state === 'error') {
      body = h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2 small' },
        icon('exclamation-circle', 'text-warning-emphasis'),
        h(
          'span',
          { 'data-testid': 'key-balance-error' },
          'Balance unavailable: ',
          balanceError(entry.error),
        ),
        refresh,
      );
    } else {
      const balance = keyBalance(entry.status);
      body = [
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
                  h(
                    'span',
                    { class: 'fw-normal small text-body-secondary' },
                    ` (${balance.reset})`,
                  ),
              ],
              'key-limit',
            ),
            stat('Remaining', balance.remaining ?? '—', 'key-remaining'),
            stat('Free requests today', balance.freeDaily ?? '—', 'key-free-daily'),
          ),
          refresh,
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
              label: `Credit left on ${key.name}`,
              text: `${balance.remainingPercent}% of the limit left`,
            }),
          ),
        h(
          'div',
          { class: 'small text-body-secondary mt-2' },
          entry.status.isFreeTier ? 'No credits bought yet (free tier). ' : '',
          `Checked ${formatRelativeTime(entry.status.fetchedAt)}.`,
        ),
      ];
    }
    rerender(slot, body);
  };

  // --- actions ------------------------------------------------------------------------------------------
  const rename = async (key: KeyInfo): Promise<void> => {
    const name = await promptDialog({
      title: 'Rename key',
      label: 'Name',
      value: key.name,
      help: 'Only for you: it appears in key menus and history.',
      maxLength: 60,
      icon: 'pencil',
      testId: 'rename-key-dialog',
    });
    if (name === null || name === key.name) return;
    if (attempt(() => core.keys.update(key.id, { name }))) announce(`Key renamed to ${name}.`);
  };

  const makeDefault = (key: KeyInfo): void => {
    if (attempt(() => core.keys.setDefault(key.id))) {
      toast({ message: `“${key.name}” is now the default key.`, variant: 'success' });
    }
  };

  const remove = async (key: KeyInfo): Promise<void> => {
    const confirmed = await confirmDialog({
      title: 'Remove this key?',
      message: h(
        'div',
        null,
        h(
          'p',
          null,
          `ORtoolbox forgets “${key.name}” (${key.masked}). Tools pinned to it switch to the default key.`,
        ),
        h(
          'p',
          { class: 'mb-0 text-body-secondary' },
          'The key keeps working on OpenRouter; delete it there if you no longer need it.',
        ),
      ),
      confirmLabel: 'Remove key',
      tone: 'danger',
      testId: 'remove-key-dialog',
    });
    if (!confirmed) return;

    const file = core.keys.exportFile();
    const index = file.keys.findIndex((stored) => stored.id === key.id);
    const record = file.keys[index];
    if (!record) return; // removed meanwhile (another tab)
    // Only needed if the lock changes before Undo; unreadable while locked, which is fine.
    const secret = await core.keys.secret(key.id).catch(() => null);
    const settings = core.settings.get();
    if (!attempt(() => core.keys.remove(key.id))) return;
    balances.delete(key.id);
    let pending: RemovedKey | null = {
      record,
      index,
      lock: JSON.stringify(file.lock),
      secret,
      wasDefault: settings.defaultKeyId === key.id,
      defaultAfter: core.settings.get().defaultKeyId,
      pinned: Object.entries(settings.tools)
        .filter(([, binding]) => binding?.keyId === key.id)
        .map(([tool]) => tool as ToolId),
      budget: settings.budgets.perKeyMonthlyUsd[key.id],
    };

    const undo = (removed: RemovedKey): void => {
      restore(removed)
        .then(() => toast({ message: `Key “${removed.record.name}” is back.`, variant: 'success' }))
        .catch((error: unknown) => void presentError(error, { retry: () => undo(removed) }));
    };
    const handle = toast({
      message: `Key “${key.name}” removed.`,
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          const removed = pending;
          pending = null;
          if (removed) undo(removed);
        },
      },
    });
    // The Undo window is over: let go of the record and the secret.
    handle.element.addEventListener('hidden.bs.toast', () => {
      pending = null;
    });
  };

  /** Puts a removed key back into the keys file as it is now, then the settings that pointed at it. */
  const restore = async (removed: RemovedKey): Promise<void> => {
    let id = removed.record.id;
    for (let tries = 1; ; tries++) {
      const current = core.keys.exportFile();
      if (current.keys.some((stored) => stored.id === id)) break; // already back (Undo in another tab)
      if (JSON.stringify(current.lock) === removed.lock) {
        const keys = [...current.keys];
        keys.splice(Math.min(removed.index, keys.length), 0, removed.record);
        try {
          // `expected` is the file read a moment ago: only a write from another tab in between is refused.
          core.keys.replaceFile({ ...current, keys }, { expected: current });
          break;
        } catch (error) {
          if (errorCode(error) === 'keys-changed' && tries === 1) continue;
          throw error;
        }
      }
      if (!removed.secret) {
        throw new InvalidInputError(
          'This key cannot be put back because the passphrase lock changed since it was removed. Add it again.',
        );
      }
      const added = await core.keys.add({
        name: removed.record.name,
        secret: removed.secret,
        colour: removed.record.colour,
        source: removed.record.source,
      });
      if (removed.record.noRetention) core.keys.update(added.id, { noRetention: true });
      id = added.id;
      break;
    }
    core.settings.update((draft) => {
      if (removed.wasDefault && draft.defaultKeyId === removed.defaultAfter)
        draft.defaultKeyId = id;
      for (const tool of removed.pinned) {
        if (draft.tools[tool]?.keyId === undefined)
          draft.tools[tool] = { ...draft.tools[tool], keyId: id };
      }
      if (removed.budget !== undefined && draft.budgets.perKeyMonthlyUsd[id] === undefined) {
        draft.budgets.perKeyMonthlyUsd[id] = removed.budget;
      }
    });
  };

  // --- rows ---------------------------------------------------------------------------------------------
  const row = (key: KeyInfo): HTMLElement => {
    const balanceSlot = h('div', {
      class: 'or-key-balance rounded-3 p-3 mt-3',
      'data-testid': 'key-balance',
    });
    balanceSlots.set(key.id, balanceSlot);
    const colour = h('input', {
      type: 'color',
      class: 'form-control form-control-color form-control-sm',
      value: key.colour ?? NO_COLOUR,
      title: 'Colour',
      'aria-label': `Colour of ${key.name}`,
      'data-testid': 'key-colour',
      'data-focus': `key:${key.id}:colour`,
      onchange: () => {
        if (attempt(() => core.keys.update(key.id, { colour: colour.value })))
          announce(`Colour of ${key.name} changed.`);
      },
    });
    const freeOnly = core.settings.get().freeOnly;
    const retention = switchField({
      label: 'Prefer providers that do not retain data',
      help: [
        'Requests with this key ask OpenRouter to use only providers that do not store or train on your data. Not applied to free models (OpenRouter serves them under a training-allowed policy, so they would fail) or to image and video generation.',
        freeOnly && key.noRetention
          ? h(
              'span',
              {
                class: 'd-block text-warning-emphasis mt-1',
                'data-testid': 'key-retention-conflict',
              },
              icon('exclamation-triangle', 'me-1'),
              'Free-only mode is on, so this has no effect right now.',
            )
          : null,
      ],
      checked: key.noRetention,
      testId: 'key-no-retention',
      onChange: (checked, input) => {
        if (!attempt(() => core.keys.update(key.id, { noRetention: checked })))
          input.checked = !checked;
      },
    });
    retention.input.dataset.focus = `key:${key.id}:retention`;

    const element = h(
      'li',
      { class: 'list-group-item p-3 p-md-4', 'data-testid': 'key-row', 'data-key-id': key.id },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-start gap-3' },
        h(
          'div',
          { class: 'flex-grow-1 min-w-0' },
          h(
            'div',
            { class: 'd-flex flex-wrap align-items-center gap-2' },
            keyDot(key),
            h('span', { class: 'fw-semibold text-break', 'data-testid': 'key-name' }, key.name),
            key.isDefault &&
              h(
                'span',
                { class: 'badge rounded-pill text-bg-primary', 'data-testid': 'key-default-badge' },
                'Default',
              ),
            h(
              'span',
              { class: 'badge rounded-pill text-bg-secondary', 'data-testid': 'key-source' },
              key.source === 'oauth' ? 'Connected' : 'Pasted',
            ),
          ),
          h(
            'div',
            { class: 'font-monospace small text-body-secondary mt-1', 'data-testid': 'key-masked' },
            key.masked,
          ),
        ),
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2' },
          !key.isDefault &&
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-primary',
                'data-testid': 'key-make-default',
                'data-focus': `key:${key.id}:default`,
                onclick: () => makeDefault(key),
              },
              'Make default',
            ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary',
              'aria-label': `Rename ${key.name}`,
              'data-testid': 'key-rename',
              'data-focus': `key:${key.id}:rename`,
              onclick: () => void rename(key),
            },
            icon('pencil', 'me-1'),
            'Rename',
          ),
          colour,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-danger',
              'aria-label': `Remove ${key.name}`,
              'data-testid': 'key-remove',
              'data-focus': `key:${key.id}:remove`,
              onclick: () => void remove(key),
            },
            icon('trash', 'me-1'),
            'Remove',
          ),
        ),
      ),
      balanceSlot,
      h('div', { class: 'mt-3' }, retention.element),
    );
    return element;
  };

  const render = (): void => {
    const keys = core.keys.list();
    balanceSlots.clear();
    for (const id of [...balances.keys()])
      if (!keys.some((key) => key.id === id)) balances.delete(id);
    rerender(
      list,
      keys.length > 0
        ? h('ul', { class: 'list-group shadow-sm mb-4', 'aria-label': 'Your keys' }, keys.map(row))
        : h(
            'div',
            { class: 'card shadow-sm mb-4' },
            emptyState({
              icon: 'key',
              title: 'No keys yet',
              text: 'Connect with OpenRouter or paste a key below. Every tool then uses it.',
              compact: true,
              testId: 'keys-empty',
            }),
          ),
      {
        // A button that went away (Make default) → the same key's Rename; a removed key → the section heading.
        fallback: (lost) => {
          const id = lost?.startsWith('key:') ? lost.split(':')[1] : undefined;
          const rename = id
            ? list.querySelector<HTMLElement>(`[data-focus="key:${CSS.escape(id)}:rename"]`)
            : null;
          return rename ?? document.getElementById('keys-title');
        },
      },
    );
    for (const key of keys) renderBalance(key);
    if (shown) loadMissing();
  };

  // --- layout -------------------------------------------------------------------------------------------
  const addCard = card(
    {
      title: 'Add a key',
      icon: 'plus-circle',
      text: 'Connect with OpenRouter to create a key for this browser, or paste one you already have.',
      testId: 'add-key',
    },
    h(
      'div',
      { class: 'or-connect' },
      connectKey({ returnTo: settingsUrl('keys'), onAdded: () => announce('Key added.') }),
    ),
  );

  const tip = h(
    'div',
    { class: 'alert alert-info d-flex gap-3 mb-4', 'data-testid': 'keys-tip' },
    icon('lightbulb', 'fs-5 lh-1 mt-1'),
    h(
      'div',
      null,
      h('div', { class: 'fw-semibold mb-1' }, 'Tip: use a key with a spending limit'),
      'Create a key with a credit limit in ',
      externalLink(OPENROUTER_KEYS_URL, 'your OpenRouter key list', 'alert-link'),
      ' and paste it here. If it ever leaks, it can only spend that much.',
    ),
  );

  const element = h('div', null, tip, list, addCard);
  core.keys.subscribe(render);
  core.settings.subscribe((next, prev) => {
    if (next.freeOnly !== prev.freeOnly) render();
  });
  render();

  return {
    element,
    onShow: () => {
      shown = true;
      loadMissing();
    },
  };
}

/** Exposed for the Models section: the account's free-model counter from the default key, if readable. */
export async function accountFreeDaily(core: CoreServices): Promise<KeyStatus['freeDaily']> {
  const key = core.keys.resolve();
  if (!key || !core.keys.lock.unlocked()) return null;
  try {
    return (await core.keys.status(key.id)).freeDaily;
  } catch {
    return null;
  }
}
