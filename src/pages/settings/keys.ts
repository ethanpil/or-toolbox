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
import { errorCode, InvalidInputError } from '../../core/errors';
import type { CoreServices, KeyInfo, StoredKey, ToolId } from '../../core/types';
import { connectKey } from '../../ui/components/connect-key';
import { emptyState } from '../../ui/components/empty-state';
import { externalLink } from '../../ui/components/external-link';
import { keyBalanceView, type KeyBalanceView } from '../../ui/components/key-balance';
import { keyDot } from '../../ui/components/key-picker';
import { switchField } from '../../ui/components/switch-field';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { icon } from '../../ui/icon';
import { OPENROUTER_KEYS_URL, settingsUrl } from '../../ui/shell/links';
import { attempt, card, rerender, type SectionView } from './ui';

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
  /** One balance view per key, kept across re-renders so a rename or a colour change never flashes it. */
  const balances = new Map<string, KeyBalanceView>();
  let shown = false;

  const balanceOf = (key: KeyInfo): KeyBalanceView => {
    let view = balances.get(key.id);
    if (!view) {
      view = keyBalanceView(core, key);
      balances.set(key.id, view);
    }
    return view;
  };

  /** Only keys without a balance yet: a rename or a colour change does not ask OpenRouter again. */
  const loadMissing = (): void => {
    for (const key of core.keys.list()) balanceOf(key).loadMissing();
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
    const colour = h('input', {
      type: 'color',
      class: 'form-control form-control-color form-control-sm',
      value: key.colour ?? NO_COLOUR,
      title: 'Color',
      'aria-label': `Color of ${key.name}`,
      'data-testid': 'key-colour',
      'data-focus-key': `key:${key.id}:colour`,
      onchange: () => {
        if (attempt(() => core.keys.update(key.id, { colour: colour.value })))
          announce(`Color of ${key.name} changed.`);
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
    retention.input.dataset.focusKey = `key:${key.id}:retention`;

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
                'data-focus-key': `key:${key.id}:default`,
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
              'data-focus-key': `key:${key.id}:rename`,
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
              'data-focus-key': `key:${key.id}:remove`,
              onclick: () => void remove(key),
            },
            icon('trash', 'me-1'),
            'Remove',
          ),
        ),
      ),
      balanceOf(key).element,
      h('div', { class: 'mt-3' }, retention.element),
    );
    return element;
  };

  const render = (): void => {
    const keys = core.keys.list();
    for (const id of [...balances.keys()])
      if (!keys.some((key) => key.id === id)) balances.delete(id);
    rerender(
      list,
      () =>
        keys.length > 0
          ? h(
              'ul',
              { class: 'list-group shadow-sm mb-4', 'aria-label': 'Your keys' },
              keys.map(row),
            )
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
            ? list.querySelector<HTMLElement>(`[data-focus-key="key:${CSS.escape(id)}:rename"]`)
            : null;
          return rename ?? document.getElementById('keys-title');
        },
      },
    );
    for (const key of keys) balanceOf(key).paint();
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
