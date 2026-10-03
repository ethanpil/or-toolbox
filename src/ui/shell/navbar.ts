/**
 * The site navbar: brand, Tools menu (grouped by category), Models, History, Stats, Settings, and on the right
 * the free-only badge, the key chip, the lock button (when the passphrase lock is on), the theme menu and the
 * command-palette button. Everything on the right updates live from settings and keys (also other tabs).
 */
import type { CoreServices, ThemeMode } from '../../core/types';
import { url } from '../../core/paths';
import { tools } from '../../tools/registry';
import { TOOL_CATEGORIES, type ToolId } from '../../tools/types';
import { keyDot } from '../components/key-picker';
import { type Child, h, replace } from '../dom';
import { presentError } from '../feedback/errors';
import { toast } from '../feedback/toast';
import { unlockDialog } from '../feedback/unlock';
import { formatRelativeTime, formatShortcut, formatUsd } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { CATEGORY_INFO, type NavKey, settingsUrl } from './links';

export interface NavbarOptions {
  nav?: NavKey;
  /** The tool whose page this is (marks it in the Tools menu). */
  tool?: ToolId;
  onPalette: () => void;
}

const THEMES: readonly { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: 'light', label: 'Light', icon: 'sun' },
  { mode: 'dark', label: 'Dark', icon: 'moon-stars' },
  { mode: 'system', label: 'System', icon: 'circle-half' },
];

export function navbar(core: CoreServices, options: NavbarOptions): HTMLElement {
  const collapseId = uid('navbar-links');

  const link = (key: NavKey, label: string, path: string): HTMLElement => {
    const current = options.nav === key;
    return h(
      'li',
      { class: 'nav-item' },
      h(
        'a',
        {
          class: ['nav-link', current && 'active'],
          href: url(path),
          'aria-current': current ? 'page' : null,
        },
        label,
      ),
    );
  };

  const right = h('div', { class: 'd-flex flex-wrap align-items-center gap-2 py-2 py-lg-0' });
  const renderRight = (): void => {
    replace(
      right,
      core.settings.get().freeOnly ? freeOnlyBadge() : null,
      keyChip(core),
      core.keys.lock.enabled() ? lockButton(core) : null,
      themeMenu(core),
    );
  };
  renderRight();
  core.settings.subscribe((next, prev) => {
    if (
      next.freeOnly !== prev.freeOnly ||
      next.appearance.theme !== prev.appearance.theme ||
      next.defaultKeyId !== prev.defaultKeyId
    ) {
      renderRight();
    }
  });
  core.keys.subscribe(renderRight);

  const palette = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary d-flex align-items-center gap-2 ms-auto ms-lg-3 order-lg-last or-palette-button',
      'aria-label': `Search tools, pages and runs (${formatShortcut('K')})`,
      'aria-keyshortcuts': 'Control+K Meta+K',
      'data-testid': 'palette-button',
      onclick: options.onPalette,
    },
    icon('search'),
    h('span', { class: 'd-none d-md-inline' }, 'Search'),
    h('kbd', { class: 'd-none d-md-inline or-kbd' }, formatShortcut('K')),
  );

  return h(
    'header',
    { class: 'navbar navbar-expand-lg bg-body border-bottom sticky-top or-navbar' },
    h(
      'nav',
      { class: 'container-xxl', 'aria-label': 'Main' },
      h(
        'a',
        { class: 'navbar-brand d-flex align-items-center gap-2 fw-semibold', href: url() },
        h('img', { src: url('icons/logo.svg'), alt: '', width: 28, height: 28 }),
        'ORtoolbox',
      ),
      palette,
      h(
        'button',
        {
          type: 'button',
          class: 'navbar-toggler ms-2 border-0',
          'data-bs-toggle': 'collapse',
          'data-bs-target': `#${collapseId}`,
          'aria-controls': collapseId,
          'aria-expanded': 'false',
          'aria-label': 'Show navigation',
        },
        h('span', { class: 'navbar-toggler-icon' }),
      ),
      h(
        'div',
        { class: 'collapse navbar-collapse', id: collapseId },
        h(
          'ul',
          { class: 'navbar-nav me-auto' },
          toolsMenu(options),
          link('models', 'Models', 'models/'),
          link('history', 'History', 'history/'),
          link('stats', 'Stats', 'stats/'),
          link('settings', 'Settings', 'settings/'),
        ),
        right,
      ),
    ),
  );
}

function toolsMenu(options: NavbarOptions): HTMLElement {
  const groups = TOOL_CATEGORIES.map((category) => {
    const headerId = uid('tools-group');
    return h(
      'div',
      { class: 'or-tools-group', role: 'group', 'aria-labelledby': headerId },
      h('h2', { class: 'dropdown-header', id: headerId }, CATEGORY_INFO[category].label),
      tools
        .filter((tool) => tool.category === category)
        .map((tool) => {
          const current = tool.id === options.tool;
          return h(
            'a',
            {
              class: ['dropdown-item d-flex align-items-center gap-2', current && 'active'],
              href: url(`tools/${tool.id}/`),
              'aria-current': current ? 'page' : null,
            },
            icon(tool.icon, 'or-menu-icon'),
            tool.name,
          );
        }),
    );
  });
  const current = options.nav === 'tools';
  return h(
    'li',
    { class: 'nav-item dropdown' },
    h(
      'button',
      {
        type: 'button',
        class: ['nav-link dropdown-toggle', current && 'active'],
        'data-bs-toggle': 'dropdown',
        'aria-expanded': 'false',
        'data-testid': 'nav-tools',
      },
      'Tools',
    ),
    h('div', { class: 'dropdown-menu or-tools-menu shadow' }, groups),
  );
}

function freeOnlyBadge(): HTMLElement {
  return h(
    'a',
    {
      class:
        'badge rounded-pill text-bg-success text-decoration-none d-inline-flex align-items-center gap-1',
      href: settingsUrl('models'),
      title: 'Free-only mode is on: only free models can run',
      'data-testid': 'free-only-badge',
    },
    icon('gift'),
    'Free only',
  );
}

function keyChip(core: CoreServices): HTMLElement {
  const key = core.keys.resolve();
  if (!key) {
    return h(
      'a',
      {
        class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
        href: settingsUrl('keys'),
        'data-testid': 'key-chip',
      },
      icon('key'),
      'Add key',
    );
  }

  const balance = h('div', { class: 'small', 'data-testid': 'key-chip-balance' });
  const loadBalance = (): void => {
    if (!core.keys.lock.unlocked()) {
      balance.replaceChildren(
        h('span', { class: 'text-body-secondary' }, 'Unlock your keys to see the balance.'),
      );
      return;
    }
    balance.replaceChildren(
      h('span', { class: 'spinner-border spinner-border-sm me-2', 'aria-hidden': 'true' }),
      h('span', { class: 'text-body-secondary' }, 'Checking balance…'),
    );
    core.keys
      .status(key.id)
      .then((status) => {
        const rows: Child[] = [];
        if (status.limitRemainingUsd !== null && status.limitUsd !== null) {
          rows.push(
            h(
              'div',
              null,
              h('span', { class: 'fw-semibold' }, formatUsd(status.limitRemainingUsd)),
              ` left of ${formatUsd(status.limitUsd)}`,
            ),
          );
        } else {
          rows.push(h('div', null, 'No credit limit on this key'));
        }
        rows.push(
          h(
            'div',
            { class: 'text-body-secondary' },
            `${formatUsd(status.usageMonthlyUsd ?? status.usageUsd)} used ${status.usageMonthlyUsd !== null ? 'this month' : 'in total'} · checked ${formatRelativeTime(status.fetchedAt)}`,
          ),
        );
        replace(balance, rows);
      })
      .catch(() => {
        balance.replaceChildren(
          h('span', { class: 'text-body-secondary' }, 'Balance unavailable right now.'),
        );
      });
  };

  const toggle = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary dropdown-toggle d-inline-flex align-items-center gap-2 or-key-chip',
      'data-bs-toggle': 'dropdown',
      'aria-expanded': 'false',
      'aria-label': `Key: ${key.name}`,
      'data-testid': 'key-chip',
    },
    keyDot(key),
    h('span', { class: 'text-truncate' }, key.name),
  );
  const wrapper = h(
    'div',
    { class: 'dropdown' },
    toggle,
    h(
      'div',
      {
        class: 'dropdown-menu dropdown-menu-end shadow p-3 or-key-menu',
        'data-testid': 'key-chip-menu',
      },
      h('div', { class: 'small text-body-secondary mb-1' }, key.isDefault ? 'Default key' : 'Key'),
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 mb-1' },
        keyDot(key),
        h('span', { class: 'fw-semibold text-truncate' }, key.name),
      ),
      h(
        'div',
        { class: 'font-monospace small mb-2', 'data-testid': 'key-chip-masked' },
        key.masked,
      ),
      balance,
      h('hr', { class: 'my-2' }),
      h(
        'a',
        {
          class: 'btn btn-sm btn-outline-primary w-100',
          href: settingsUrl('keys'),
          'data-testid': 'manage-keys',
        },
        'Manage keys',
      ),
    ),
  );
  toggle.addEventListener('show.bs.dropdown', loadBalance);
  return wrapper;
}

function lockButton(core: CoreServices): HTMLElement {
  const unlocked = core.keys.lock.unlocked();
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'aria-label': unlocked ? 'Lock keys now' : 'Unlock keys',
      title: unlocked ? 'Lock keys now' : 'Unlock keys',
      'data-testid': 'lock-button',
      onclick: () => {
        if (core.keys.lock.unlocked()) {
          core.keys.lock.lockNow();
          toast({ message: 'Keys locked in this tab.', variant: 'success' });
        } else {
          unlockDialog().catch((error: unknown) => void presentError(error));
        }
      },
    },
    icon(unlocked ? 'unlock' : 'lock-fill'),
  );
}

function themeMenu(core: CoreServices): HTMLElement {
  const mode = core.settings.get().appearance.theme;
  const currentTheme = THEMES.find((theme) => theme.mode === mode) ?? THEMES[2]!;
  const items = THEMES.map((theme) =>
    h(
      'li',
      null,
      h(
        'button',
        {
          type: 'button',
          class: ['dropdown-item d-flex align-items-center gap-2', theme.mode === mode && 'active'],
          'aria-current': theme.mode === mode ? 'true' : null,
          'data-testid': `theme-${theme.mode}`,
          onclick: () => {
            try {
              core.settings.update((draft) => {
                draft.appearance.theme = theme.mode;
              });
            } catch (error) {
              void presentError(error);
            }
          },
        },
        icon(theme.icon),
        theme.label,
        theme.mode === mode ? icon('check2', 'ms-auto') : null,
      ),
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
          'btn btn-sm btn-outline-secondary dropdown-toggle d-inline-flex align-items-center gap-1',
        'data-bs-toggle': 'dropdown',
        'aria-expanded': 'false',
        'aria-label': `Theme: ${currentTheme.label}`,
        'data-testid': 'theme-menu',
      },
      icon(currentTheme.icon),
    ),
    h('ul', { class: 'dropdown-menu dropdown-menu-end shadow' }, items),
  );
}
