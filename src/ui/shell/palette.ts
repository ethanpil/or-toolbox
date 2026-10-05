/**
 * Command palette (Ctrl/Cmd+K, or the navbar's Search button): one search over tools, pages, settings sections,
 * a few actions, recent runs (History) and models (catalog). An ARIA 1.2 combobox: the input owns a listbox of
 * grouped options and points at the active one with `aria-activedescendant`; focus never leaves the input.
 * Arrow keys move, Enter opens, Escape closes, and focus returns to whatever opened it.
 *
 * Synchronous groups render on every keystroke. History and the catalog are queried after a short pause; until
 * they answer, their previous results stay on screen (re-filtered for the new text), so nothing flickers.
 */
import type { CoreServices, ModelInfo } from '../../core/types';
import { url } from '../../core/paths';
import { debounce } from '../../core/util';
import { getTool, tools } from '../../tools/registry';
import { h, replace } from '../dom';
import { presentError } from '../feedback/errors';
import { modalOpen, openModal, type ModalHandle } from '../feedback/modal';
import { formatRelativeTime } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { setTheme } from '../settings-actions';
import { THEME_MODES } from './appearance';
import { guardedNavigate } from './leave-guard';
import { CATEGORY_INFO, modelsUrl, PAGES, SETTINGS_SECTIONS, settingsUrl, toolUrl } from './links';
import { rank, rankBy, scoreItem, type SearchItem } from './palette-search';
import { composing } from './shortcuts';

export interface PaletteItem extends SearchItem {
  id: string;
  group: PaletteGroup;
  icon: string;
  /** Navigate here (guarded by the leave guard)… */
  href?: string;
  /** …or run this. */
  action?: () => void;
}

export type PaletteGroup = 'Tools' | 'Pages' | 'Settings' | 'Actions' | 'Recent runs' | 'Models';
const GROUP_ORDER: readonly PaletteGroup[] = [
  'Tools',
  'Recent runs',
  'Pages',
  'Settings',
  'Actions',
  'Models',
];
const PER_GROUP = 6;
const ASYNC_DELAY_MS = 120;

/** What the palette's model search matches: the name, then the id. */
const searchableModel = (model: ModelInfo): SearchItem => ({ label: model.name, detail: model.id });

/** The items that need no I/O. */
export function staticItems(core: Pick<CoreServices, 'settings' | 'keys'>): PaletteItem[] {
  const items: PaletteItem[] = tools.map((tool) => ({
    id: `tool:${tool.id}`,
    group: 'Tools',
    label: tool.name,
    detail: tool.description,
    keywords: `${CATEGORY_INFO[tool.category].label} ${tool.capabilities.join(' ')}`,
    icon: tool.icon,
    href: toolUrl(tool.id),
  }));
  for (const page of PAGES) {
    items.push({
      id: `page:${page.key}`,
      group: 'Pages',
      label: page.label,
      keywords: page.keywords,
      icon: page.icon,
      href: url(page.path),
    });
  }
  for (const section of SETTINGS_SECTIONS) {
    items.push({
      id: `settings:${section.id}`,
      group: 'Settings',
      label: section.label,
      detail: 'Settings',
      keywords: section.keywords,
      icon: section.icon,
      href: settingsUrl(section.id),
    });
  }
  for (const { mode, label, icon: themeIcon } of THEME_MODES) {
    items.push({
      id: `theme:${mode}`,
      group: 'Actions',
      label: `Switch to ${label.toLowerCase()} theme`,
      keywords: 'appearance color colour mode',
      icon: themeIcon,
      action: () => setTheme(core, mode),
    });
  }
  if (core.keys.lock.enabled() && core.keys.lock.unlocked()) {
    items.push({
      id: 'action:lock',
      group: 'Actions',
      label: 'Lock keys now',
      keywords: 'passphrase security',
      icon: 'lock',
      action: () => core.keys.lock.lockNow(),
    });
  }
  return items;
}

/** Listed in full while the search box is empty, so every tool and page can be reached without typing. */
const COMPLETE_WHEN_EMPTY: ReadonlySet<PaletteGroup> = new Set(['Tools', 'Pages']);

/**
 * Ranks every group and keeps at most `PER_GROUP` of each (all tools and pages while there is no query). Without
 * a query the groups keep their fixed order; with one, the group holding the best match comes first (so "models"
 * puts the Models page above a tool whose description mentions models).
 */
export function arrange(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const searching = query.trim() !== '';
  const groups = GROUP_ORDER.map((group, order) => {
    const inGroup = items.filter((item) => item.group === group);
    // Recent runs are already newest-first and filtered by History; ranking would reorder them by title.
    const ranked = group === 'Recent runs' && !searching ? inGroup : rank(inGroup, query);
    const best = searching && ranked[0] ? scoreItem(query, ranked[0]) : 0;
    const limit = !searching && COMPLETE_WHEN_EMPTY.has(group) ? ranked.length : PER_GROUP;
    return { order, best, items: ranked.slice(0, limit) };
  });
  if (searching) groups.sort((a, b) => b.best - a.best || a.order - b.order);
  return groups.flatMap((group) => group.items);
}

let open: ModalHandle | null = null;

/** Opens the palette, or closes it when it is already open. */
export function togglePalette(core: CoreServices): void {
  if (open) {
    open.hide();
    return;
  }
  // One modal at a time; the palette is not worth queueing behind another dialog.
  if (modalOpen()) return;
  open = showPalette(core);
  void open.closed.then(() => {
    open = null;
  });
}

/**
 * Registers Ctrl/Cmd+K on this page. It works while typing in a field (and closes the palette itself), but
 * never opens on top of another dialog, and then leaves the key to the browser.
 */
export function installPaletteShortcut(core: CoreServices): void {
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'k')
      return;
    if (!open && modalOpen()) return;
    event.preventDefault();
    togglePalette(core);
  });
}

function showPalette(core: CoreServices): ModalHandle {
  const inputId = uid('palette-input');
  const listId = uid('palette-list');
  const statusId = uid('palette-status');
  const base = staticItems(core);
  let asyncItems: PaletteItem[] = [];
  let shown: PaletteItem[] = [];
  let activeId: string | null = null;
  let generation = 0;
  let chosen: PaletteItem | null = null;

  const input = h('input', {
    id: inputId,
    type: 'text',
    class: 'form-control form-control-lg border-0 shadow-none',
    placeholder: 'Search tools, pages, settings, runs and models…',
    autocomplete: 'off',
    spellcheck: false,
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-describedby': statusId,
    'data-testid': 'palette-input',
  });
  const list = h('div', {
    id: listId,
    role: 'listbox',
    'aria-label': 'Results',
    class: 'or-palette-list',
    'data-testid': 'palette-list',
  });
  const status = h('div', {
    id: statusId,
    class: 'or-palette-empty text-body-secondary',
    role: 'status',
  });

  const optionId = (item: PaletteItem): string => `${listId}-${item.id.replace(/[^\w-]/g, '_')}`;

  const setActive = (id: string | null): void => {
    activeId = id;
    for (const option of list.querySelectorAll<HTMLElement>('[role="option"]')) {
      const selected = option.dataset.itemId === id;
      option.setAttribute('aria-selected', String(selected));
      option.classList.toggle('active', selected);
      if (selected) option.scrollIntoView({ block: 'nearest' });
    }
    const item = shown.find((candidate) => candidate.id === id);
    if (item) input.setAttribute('aria-activedescendant', optionId(item));
    else input.removeAttribute('aria-activedescendant');
  };

  const render = (): void => {
    const query = input.value;
    shown = arrange([...base, ...asyncItems], query);
    const order = [...new Set(shown.map((item) => item.group))];
    const groups = order.map((group) => {
      const items = shown.filter((item) => item.group === group);
      if (items.length === 0) return null;
      const headingId = uid('palette-group');
      return h(
        'div',
        { role: 'group', 'aria-labelledby': headingId, class: 'or-palette-group' },
        h('div', { id: headingId, class: 'or-palette-heading', role: 'presentation' }, group),
        items.map((item) =>
          h(
            'div',
            {
              id: optionId(item),
              role: 'option',
              'aria-selected': 'false',
              class: 'or-palette-option',
              dataset: { itemId: item.id },
              'data-testid': `palette-option-${item.id}`,
              onclick: () => choose(item),
              onmousemove: () => {
                if (activeId !== item.id) setActive(item.id);
              },
            },
            h('span', { class: 'or-palette-icon' }, icon(item.icon)),
            h(
              'span',
              { class: 'min-w-0 flex-grow-1' },
              h('span', { class: 'd-block text-truncate' }, item.label),
              item.detail &&
                h(
                  'span',
                  { class: 'd-block small text-body-secondary text-truncate' },
                  item.detail,
                ),
            ),
            item.href ? icon('arrow-return-left', 'or-palette-enter') : null,
          ),
        ),
      );
    });
    replace(list, groups);
    const empty = shown.length === 0;
    list.hidden = empty;
    input.setAttribute('aria-expanded', String(!empty));
    status.textContent = empty
      ? `No results for “${query.trim()}”.`
      : `${shown.length} result${shown.length === 1 ? '' : 's'}.`;
    status.classList.toggle('visually-hidden', !empty);
    setActive(shown.some((item) => item.id === activeId) ? activeId : (shown[0]?.id ?? null));
  };

  const loadAsync = (): void => {
    const query = input.value.trim();
    const mine = ++generation;
    const runs = core.history
      .query({ ...(query ? { text: query } : {}), limit: 5 })
      .then((records) =>
        records.map((run): PaletteItem => ({
          id: `run:${run.id}`,
          group: 'Recent runs',
          // Already matched by History (prompt, output and model too), so the label always "matches".
          label: run.title,
          detail: `${getTool(run.tool).name} · ${formatRelativeTime(run.startedAt)}`,
          keywords: query,
          icon: getTool(run.tool).icon,
          href: toolUrl(run.tool, { run: run.id }),
        })),
      )
      .catch(() => [] as PaletteItem[]);
    const models =
      query.length < 2
        ? Promise.resolve([] as PaletteItem[])
        : core.models
            .list()
            .then((catalog) => {
              const found = rankBy(catalog, query, searchableModel).slice(0, PER_GROUP - 1);
              return [
                {
                  id: 'models:search',
                  group: 'Models',
                  label: `Search models for “${query}”`,
                  keywords: query,
                  icon: 'search',
                  href: modelsUrl(query),
                } satisfies PaletteItem,
                ...found.map((model): PaletteItem => ({
                  id: `model:${model.id}`,
                  group: 'Models',
                  label: model.name,
                  detail: model.id,
                  keywords: query,
                  icon: 'cpu',
                  href: modelsUrl(model.id),
                })),
              ];
            })
            .catch(() => [] as PaletteItem[]);
    void Promise.all([runs, models]).then(([runItems, modelItems]) => {
      if (mine !== generation) return;
      asyncItems = [...runItems, ...modelItems];
      render();
    });
  };

  const scheduleAsync = debounce(loadAsync, ASYNC_DELAY_MS);

  const move = (delta: number): void => {
    if (shown.length === 0) return;
    const index = shown.findIndex((item) => item.id === activeId);
    const next = (index + delta + shown.length) % shown.length;
    setActive(shown[next]!.id);
  };

  function choose(item: PaletteItem): void {
    chosen = item;
    modal.hide();
  }

  input.addEventListener('input', () => {
    render();
    scheduleAsync();
  });
  input.addEventListener('keydown', (event) => {
    // Keys that confirm or move an input method's composition (Japanese, Chinese, Korean) belong to it.
    if (composing(event)) return;
    if (event.key === 'ArrowDown') move(1);
    else if (event.key === 'ArrowUp') move(-1);
    else if (event.key === 'PageDown') move(5);
    else if (event.key === 'PageUp') move(-5);
    else if (event.key === 'Enter') {
      const item = shown.find((candidate) => candidate.id === activeId);
      if (item) choose(item);
    } else return;
    event.preventDefault();
  });

  const modal = openModal({
    title: 'Command palette',
    hideHeader: true,
    centered: false,
    dialogClass: 'or-palette-dialog modal-lg',
    // Instant, so typing straight after Ctrl+K lands in the search box; the content still fades in (CSS).
    animate: false,
    contentClass: 'or-palette or-fade-in',
    body: [
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 px-2 border-bottom' },
        h(
          'label',
          { htmlFor: inputId, class: 'ps-2 text-body-secondary' },
          icon('search'),
          h('span', { class: 'visually-hidden' }, 'Search'),
        ),
        input,
        h('kbd', { class: 'or-kbd me-2 d-none d-sm-inline' }, 'Esc'),
      ),
      list,
      status,
      h(
        'div',
        {
          class:
            'or-palette-hints small text-body-secondary border-top px-3 py-2 d-none d-sm-flex gap-3',
        },
        h(
          'span',
          null,
          h('kbd', { class: 'or-kbd' }, '↑'),
          ' ',
          h('kbd', { class: 'or-kbd' }, '↓'),
          ' to move',
        ),
        h('span', null, h('kbd', { class: 'or-kbd' }, 'Enter'), ' to open'),
        h('span', null, h('kbd', { class: 'or-kbd' }, 'Esc'), ' to close'),
      ),
    ],
    initialFocus: input,
    testId: 'palette',
  });
  modal.body.classList.add('p-0');

  render();
  loadAsync();

  void modal.closed.then(() => {
    scheduleAsync.cancel();
    generation++;
    if (!chosen) return;
    try {
      if (chosen.action) chosen.action();
      else if (chosen.href) void guardedNavigate(core, chosen.href);
    } catch (error) {
      void presentError(error);
    }
  });
  return modal;
}
