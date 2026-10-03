/**
 * `keyPicker()`: a compact dropdown to choose which key a tool uses: "Default key" (follow Settings) or one of
 * the stored keys, each with its colour dot and masked secret. Calls `onChange(undefined)` for the default.
 */
import type { KeyInfo } from '../../core/types';
import { h } from '../dom';
import { icon } from '../icon';

/** A small round swatch in the key's colour (set through the CSSOM, which the CSP allows). */
export function keyDot(key: Pick<KeyInfo, 'colour'>): HTMLElement {
  return h('span', {
    class: ['or-key-dot', !key.colour && 'bg-secondary'],
    style: key.colour ? { backgroundColor: key.colour } : undefined,
    'aria-hidden': 'true',
  });
}

export interface KeyPickerOptions {
  keys: readonly KeyInfo[];
  /** The pinned key id; undefined = the default key. */
  value: string | undefined;
  onChange: (keyId: string | undefined) => void;
  /** `data-focus-key` of the toggle and its items (give several pickers on one page distinct keys). */
  focusKey?: string;
  testId?: string;
}

export function keyPicker(options: KeyPickerOptions): HTMLElement {
  const defaultKey = options.keys.find((key) => key.isDefault) ?? options.keys[0];
  const pinned = options.keys.find((key) => key.id === options.value);
  const shown = pinned ?? defaultKey;
  const focusKey = options.focusKey ?? 'key-picker';

  const item = (
    label: HTMLElement[],
    selected: boolean,
    onClick: () => void,
    testId: string,
  ): HTMLElement =>
    h(
      'li',
      null,
      h(
        'button',
        {
          type: 'button',
          class: ['dropdown-item d-flex align-items-center gap-2', selected && 'active'],
          'aria-current': selected ? 'true' : null,
          // Same key as the toggle: after a choice re-renders the picker, focus lands on the new toggle.
          'data-focus-key': focusKey,
          'data-testid': testId,
          onclick: onClick,
        },
        label,
        selected ? icon('check2', 'ms-auto') : null,
      ),
    );

  return h(
    'div',
    { class: 'dropdown' },
    h(
      'button',
      {
        type: 'button',
        class:
          'btn btn-sm btn-outline-secondary dropdown-toggle d-inline-flex align-items-center gap-2 or-chip',
        'data-bs-toggle': 'dropdown',
        'aria-expanded': 'false',
        'aria-label': `Key: ${shown?.name ?? 'none'}${pinned ? '' : ' (default)'}`,
        'data-focus-key': focusKey,
        'data-testid': options.testId ?? 'key-picker',
      },
      shown ? keyDot(shown) : icon('key'),
      h('span', { class: 'text-truncate' }, shown?.name ?? 'No key'),
    ),
    h(
      'ul',
      { class: 'dropdown-menu shadow' },
      item(
        [
          h(
            'span',
            null,
            'Default key',
            defaultKey && h('span', { class: 'text-body-secondary' }, ` (${defaultKey.name})`),
          ),
        ],
        !pinned,
        () => options.onChange(undefined),
        'key-option-default',
      ),
      h('li', null, h('hr', { class: 'dropdown-divider' })),
      options.keys.map((key) =>
        item(
          [
            keyDot(key),
            h('span', { class: 'text-truncate' }, key.name),
            h('span', { class: 'small text-body-secondary font-monospace' }, key.masked),
          ],
          pinned?.id === key.id,
          () => options.onChange(key.id),
          `key-option-${key.id}`,
        ),
      ),
    ),
  );
}
