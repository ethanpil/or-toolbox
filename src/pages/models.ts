/**
 * Models: the OpenRouter catalog (cached by `models.list()`) with search, filters, sorting, a cards or table
 * view, favourites, recently used models, your own stats per model, and a comparison tray for 2 to 4 models.
 *
 * About 650 models are kept in memory and filtered with the pure functions of models-logic.ts; only the first
 * page of the result is drawn (more on "Show more" or when the end scrolls into view), so the page stays smooth.
 * `?q=` pre-fills the search (the palette links here) and is kept in the address bar as you type.
 */
import type { Capability, CoreServices, ModelInfo } from '../core/types';
import { copyText } from '../ui/clipboard';
import { emptyState } from '../ui/components/empty-state';
import { type Child, h, replace } from '../ui/dom';
import { announce } from '../ui/feedback/announce';
import { presentError } from '../ui/feedback/errors';
import { openModal } from '../ui/feedback/modal';
import { toast } from '../ui/feedback/toast';
import { formatContext, formatRelativeTime, formatDateTime, plural } from '../ui/format';
import { icon } from '../ui/icon';
import { uid } from '../ui/id';
import { mountPage } from '../ui/shell/index';
import { whenVisible } from './lazy';
import {
  activeFilterCount,
  CAPABILITY_FILTERS,
  capabilityBadge,
  compareSections,
  CONTEXT_STEPS,
  expiryOf,
  MODEL_SORTS,
  modelFacets,
  type ModelFilters,
  type ModelSort,
  type ModelUsage,
  NO_FILTERS,
  parseQuery,
  priceText,
  queryModels,
  usageText,
} from './models-logic';

const VIEW_KEY = 'models.view';
const PAGE_SIZE = 48;
const MAX_COMPARE = 4;

type View = 'cards' | 'table';

const modalityLabel = (modality: string): string =>
  modality.charAt(0).toUpperCase() + modality.slice(1);

mountPage(
  {
    title: 'Models',
    icon: 'cpu',
    lead: 'Every model on OpenRouter, with prices, context and your own stats.',
    nav: 'models',
  },
  ({ core, main }) => {
    new ModelsPage(core, main).start();
  },
);

class ModelsPage {
  private models: ModelInfo[] = [];
  private byId = new Map<string, ModelInfo>();
  private filters: ModelFilters = { ...NO_FILTERS };
  private sort: ModelSort = 'relevance';
  private view: View = 'cards';
  private visible: ModelInfo[] = [];
  private shown = PAGE_SIZE;
  private compare: string[] = [];
  private loaded = false;

  // Live bits of the drawn list, replaced on every full render.
  private checks = new Map<string, HTMLInputElement>();
  private stars = new Map<string, HTMLButtonElement>();
  private usageSlots: { id: string; element: HTMLElement }[] = [];
  private usageCache = new Map<string, Promise<ModelUsage>>();
  private rows: HTMLElement | null = null;

  private readonly ids = {
    search: uid('models-search'),
    capability: uid('models-capability'),
    input: uid('models-input'),
    output: uid('models-output'),
    provider: uid('models-provider'),
    maxPrice: uid('models-max-price'),
    minContext: uid('models-min-context'),
    sort: uid('models-sort'),
    free: uid('models-free'),
    favourites: uid('models-favourites'),
  };

  private readonly search = h('input', {
    id: this.ids.search,
    type: 'search',
    class: 'form-control form-control-lg or-search-input',
    placeholder: 'Search models',
    autocomplete: 'off',
    spellcheck: false,
    'data-testid': 'models-search',
  });
  private readonly capability = this.select(this.ids.capability, 'models-capability', [
    ['', 'Any capability'],
    ...CAPABILITY_FILTERS.map((entry): [string, string] => [entry.id, entry.label]),
  ]);
  private readonly input = this.select(this.ids.input, 'models-input', [['', 'Any input']]);
  private readonly output = this.select(this.ids.output, 'models-output', [['', 'Any output']]);
  private readonly provider = this.select(this.ids.provider, 'models-provider', [
    ['', 'Any provider'],
  ]);
  private readonly minContext = this.select(this.ids.minContext, 'models-min-context', [
    ['0', 'Any context'],
    ...CONTEXT_STEPS.map((step): [string, string] => [String(step.tokens), step.label]),
  ]);
  private readonly maxPrice = h('input', {
    id: this.ids.maxPrice,
    type: 'number',
    class: 'form-control',
    min: '0',
    step: 'any',
    placeholder: 'No limit',
    inputMode: 'decimal',
    'data-testid': 'models-max-price',
  });
  private readonly sortSelect = this.select(
    this.ids.sort,
    'models-sort',
    MODEL_SORTS.map((entry): [string, string] => [entry.id, entry.label]),
  );
  private readonly freeOnly = h('input', {
    id: this.ids.free,
    type: 'checkbox',
    class: 'form-check-input',
    'data-testid': 'models-free-only',
  });
  private readonly favouritesOnly = h('input', {
    id: this.ids.favourites,
    type: 'checkbox',
    class: 'form-check-input',
    'data-testid': 'models-fav-only',
  });

  private readonly cardsButton: HTMLButtonElement;
  private readonly tableButton: HTMLButtonElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly updated = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'models-updated',
  });
  private readonly count = h('p', {
    class: 'small text-body-secondary mb-2',
    role: 'status',
    'data-testid': 'models-count',
  });
  private readonly recent = h('section', {
    class: 'mb-4',
    'aria-labelledby': 'models-recent-title',
    hidden: true,
    'data-testid': 'models-recent',
  });
  private readonly list = h('div', { tabIndex: -1, 'data-testid': 'models-list' });
  private readonly moreSlot = h('div', { class: 'text-center py-3' });
  private readonly resetButton: HTMLButtonElement;
  private readonly tray = h('section', {
    class: 'or-compare-tray',
    'aria-label': 'Compare models',
    hidden: true,
    'data-testid': 'compare-tray',
  });
  private readonly more = whenVisible(this.moreSlot, () => this.showMore());

  private readonly core: CoreServices;
  private readonly main: HTMLElement;

  constructor(core: CoreServices, main: HTMLElement) {
    this.core = core;
    this.main = main;
    this.cardsButton = this.viewButton('cards', 'grid', 'Cards');
    this.tableButton = this.viewButton('table', 'table', 'Table');
    this.refreshButton = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline-secondary btn-sm d-inline-flex align-items-center gap-2',
        'data-testid': 'models-refresh',
        onclick: () => void this.refresh(),
      },
      icon('arrow-clockwise'),
      'Refresh',
    );
    this.resetButton = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-link btn-sm p-0',
        hidden: true,
        'data-testid': 'models-reset',
        onclick: () => this.resetFilters(),
      },
      'Reset filters',
    );
  }

  start(): void {
    const settings = this.core.settings.get();
    this.view = settings.ui[VIEW_KEY] === 'table' ? 'table' : 'cards';
    this.filters.text = parseQuery(window.location.search);
    this.search.value = this.filters.text;

    this.main.append(
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2 mb-3' },
        this.updated,
        this.refreshButton,
      ),
      h(
        'div',
        { class: 'row g-2 align-items-center mb-3' },
        h(
          'div',
          { class: 'col-12 col-md position-relative', role: 'search' },
          h('label', { class: 'visually-hidden', htmlFor: this.ids.search }, 'Search models'),
          icon('search', 'or-search-icon'),
          this.search,
        ),
        h(
          'div',
          { class: 'col-12 col-md-auto' },
          h(
            'div',
            { class: 'btn-group', role: 'group', 'aria-label': 'View' },
            this.cardsButton,
            this.tableButton,
          ),
        ),
      ),
      this.filterPanel(),
      this.recent,
      h('h2', { class: 'visually-hidden' }, 'Models'),
      this.count,
      this.list,
      this.moreSlot,
      this.tray,
    );
    this.syncViewButtons();
    this.wire();
    this.renderRecent();
    this.renderTray();
    this.showSkeleton();
    void this.load();

    this.core.bus.on('models-refreshed', () => void this.reload());
    this.core.stats.subscribe(() => {
      this.usageCache.clear();
      for (const slot of this.usageSlots) if (slot.element.isConnected) this.fillUsage(slot);
    });
    this.core.settings.subscribe((next, prev) => {
      const favouritesChanged = next.models.favourites.join() !== prev.models.favourites.join();
      if (favouritesChanged) {
        this.syncStars();
        if (this.filters.favouritesOnly) this.apply({ keepShown: true });
      }
      if (next.models.recent.join() !== prev.models.recent.join()) this.renderRecent();
    });
  }

  // --- controls -----------------------------------------------------------------------------------------

  private select(id: string, testId: string, options: [string, string][]): HTMLSelectElement {
    return h(
      'select',
      { id, class: 'form-select', 'data-testid': testId },
      options.map(([value, label]) => h('option', { value }, label)),
    );
  }

  private viewButton(view: View, iconName: string, label: string): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
        'data-testid': `models-view-${view}`,
        onclick: () => this.setView(view),
      },
      icon(iconName),
      label,
    );
  }

  private filterPanel(): HTMLElement {
    const field = (
      label: string,
      id: string,
      control: HTMLElement,
      columns = 'col-6 col-lg-4 col-xl-3',
    ): HTMLElement =>
      h(
        'div',
        { class: columns },
        h('label', { class: 'form-label small mb-1', htmlFor: id }, label),
        control,
      );
    const check = (id: string, input: HTMLElement, label: string): HTMLElement =>
      h(
        'div',
        { class: 'form-check' },
        input,
        h('label', { class: 'form-check-label', htmlFor: id }, label),
      );
    return h(
      'section',
      { class: 'card shadow-sm mb-3', 'aria-label': 'Filters' },
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'row g-3 align-items-end' },
          field('Capability', this.ids.capability, this.capability),
          field('Input', this.ids.input, this.input),
          field('Output', this.ids.output, this.output),
          field('Provider', this.ids.provider, this.provider),
          field('Min context', this.ids.minContext, this.minContext),
          field(
            'Max price, $ per 1M tokens (in + out)',
            this.ids.maxPrice,
            this.maxPrice,
            'col-6 col-lg-4 col-xl-3',
          ),
          field('Sort by', this.ids.sort, this.sortSelect),
          h(
            'div',
            { class: 'col-12 col-lg-4 col-xl-3 d-flex flex-wrap align-items-center gap-3 pb-1' },
            check(this.ids.free, this.freeOnly, 'Free only'),
            check(this.ids.favourites, this.favouritesOnly, 'Favourites only'),
            this.resetButton,
          ),
        ),
      ),
    );
  }

  private wire(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.readControls(), 120);
    });
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.search.value) {
        this.search.value = '';
        this.readControls();
      }
    });
    for (const control of [
      this.capability,
      this.input,
      this.output,
      this.provider,
      this.minContext,
      this.sortSelect,
      this.freeOnly,
      this.favouritesOnly,
    ]) {
      control.addEventListener('change', () => this.readControls());
    }
    this.maxPrice.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.readControls(), 200);
    });
  }

  /** Copies the controls into `filters`/`sort` and redraws. */
  private readControls(): void {
    const price = this.maxPrice.value.trim() === '' ? NaN : Number(this.maxPrice.value);
    this.filters = {
      text: this.search.value.trim(),
      capability: this.capability.value as Capability | '',
      input: this.input.value,
      output: this.output.value,
      provider: this.provider.value,
      freeOnly: this.freeOnly.checked,
      favouritesOnly: this.favouritesOnly.checked,
      maxPrice: Number.isFinite(price) && price >= 0 ? price : null,
      minContext: Number(this.minContext.value) || 0,
    };
    this.sort = MODEL_SORTS.find((entry) => entry.id === this.sortSelect.value)?.id ?? 'relevance';
    this.syncUrl();
    this.apply({ keepShown: false });
  }

  private resetFilters(): void {
    this.search.value = '';
    this.capability.value = '';
    this.input.value = '';
    this.output.value = '';
    this.provider.value = '';
    this.minContext.value = '0';
    this.maxPrice.value = '';
    this.freeOnly.checked = false;
    this.favouritesOnly.checked = false;
    this.readControls();
    this.search.focus();
  }

  private setSearch(text: string): void {
    this.search.value = text;
    this.readControls();
    this.search.focus();
  }

  private setView(view: View): void {
    if (view === this.view) return;
    this.view = view;
    try {
      this.core.settings.update((draft) => {
        draft.ui[VIEW_KEY] = view;
      });
    } catch (error) {
      void presentError(error);
    }
    this.syncViewButtons();
    this.apply({ keepShown: true });
    announce(view === 'table' ? 'Table view.' : 'Card view.');
  }

  private syncViewButtons(): void {
    for (const [view, button] of [
      ['cards', this.cardsButton],
      ['table', this.tableButton],
    ] as const) {
      const on = this.view === view;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /** Keeps `?q=` in the address bar, so a search can be bookmarked or shared. */
  private syncUrl(): void {
    const next = new URL(window.location.href);
    if (this.filters.text) next.searchParams.set('q', this.filters.text);
    else next.searchParams.delete('q');
    window.history.replaceState(window.history.state as unknown, '', next);
  }

  // --- data ---------------------------------------------------------------------------------------------

  private async load(refresh = false): Promise<void> {
    try {
      this.setModels(await this.core.models.list(refresh ? { refresh: true } : undefined));
    } catch {
      this.list.replaceChildren(
        emptyState({
          icon: 'wifi-off',
          title: 'The model list could not be loaded',
          text: 'OpenRouter did not answer and nothing is cached yet. Check your connection and try again.',
          action: h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline-primary btn-sm',
              onclick: () => void this.retry(),
            },
            'Try again',
          ),
          testId: 'models-error',
        }),
      );
      this.count.textContent = 'The model list could not be loaded.';
    }
  }

  private async retry(): Promise<void> {
    this.showSkeleton();
    // An explicit retry asks the network: the cache remembers a failure for five minutes.
    await this.load(true);
  }

  /** Another tab or a background refresh stored a newer catalog. */
  private async reload(): Promise<void> {
    if (!this.loaded) return;
    try {
      const next = await this.core.models.list();
      if (next !== this.models) this.setModels(next, { keepShown: true });
      else this.renderUpdated();
    } catch {
      // The list on screen stays.
    }
  }

  private async refresh(): Promise<void> {
    this.refreshButton.disabled = true;
    this.refreshButton.replaceChildren(
      h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }),
      'Refreshing…',
    );
    try {
      this.setModels(await this.core.models.list({ refresh: true }), { keepShown: true });
      toast({ message: 'Model list updated.', variant: 'success' });
    } catch (error) {
      void presentError(error, { retry: () => void this.refresh() });
    } finally {
      this.refreshButton.disabled = false;
      this.refreshButton.replaceChildren(icon('arrow-clockwise'), 'Refresh');
    }
  }

  private setModels(models: ModelInfo[], options: { keepShown?: boolean } = {}): void {
    this.models = models;
    this.byId = new Map(models.map((model) => [model.id, model]));
    this.loaded = true;
    const facets = modelFacets(models);
    this.fillSelect(
      this.input,
      'Any input',
      facets.inputs.map((m) => [m, modalityLabel(m)]),
    );
    this.fillSelect(
      this.output,
      'Any output',
      facets.outputs.map((m) => [m, modalityLabel(m)]),
    );
    this.fillSelect(
      this.provider,
      'Any provider',
      facets.providers.map((p) => [p.id, `${p.id} (${p.count})`]),
    );
    this.renderUpdated();
    this.renderRecent();
    this.apply({ keepShown: options.keepShown === true });
  }

  /** Replaces a select's options (keeping its value when the option still exists). */
  private fillSelect(select: HTMLSelectElement, any: string, options: string[][]): void {
    const current = select.value;
    replace(
      select,
      h('option', { value: '' }, any),
      options.map(([value, label]) => h('option', { value }, label)),
    );
    select.value = options.some(([value]) => value === current) ? current : '';
  }

  private renderUpdated(): void {
    const at = this.core.models.lastRefreshed();
    this.updated.replaceChildren(
      at === null
        ? ''
        : h(
            'span',
            null,
            'Updated ',
            h(
              'time',
              { dateTime: new Date(at).toISOString(), title: formatDateTime(at) },
              formatRelativeTime(at),
            ),
          ),
    );
  }

  private favouriteSet(): ReadonlySet<string> {
    return new Set(this.core.settings.get().models.favourites);
  }

  private isFavourite(id: string): boolean {
    return this.core.settings.get().models.favourites.includes(id);
  }

  // --- the list -----------------------------------------------------------------------------------------

  private showSkeleton(): void {
    this.list.replaceChildren(
      h(
        'div',
        {
          class: 'row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3 placeholder-glow',
          'aria-hidden': 'true',
        },
        [0, 1, 2, 3, 4, 5].map(() =>
          h(
            'div',
            { class: 'col' },
            h(
              'div',
              { class: 'card h-100 shadow-sm' },
              h(
                'div',
                { class: 'card-body' },
                h('span', { class: 'placeholder col-7 d-block mb-3' }),
                h('span', { class: 'placeholder col-10 d-block mb-2' }),
                h('span', { class: 'placeholder col-5 d-block' }),
              ),
            ),
          ),
        ),
      ),
    );
    this.count.textContent = 'Loading models…';
  }

  /** Filters and sorts again, then draws the first page (or as many as were open when `keepShown`). */
  private apply(options: { keepShown: boolean }): void {
    if (!this.loaded) return;
    this.visible = queryModels(this.models, this.filters, this.sort, this.favouriteSet());
    if (!options.keepShown) this.shown = PAGE_SIZE;
    this.renderList();
  }

  private renderList(): void {
    const active = activeFilterCount(this.filters);
    this.resetButton.hidden = active === 0 && this.filters.text === '';
    this.checks.clear();
    this.stars.clear();
    this.usageSlots = [];
    this.rows = null;

    const total = this.models.length;
    const found = this.visible.length;
    this.count.textContent =
      found === total ? plural(total, 'model') : `${found} of ${plural(total, 'model')} match`;

    if (found === 0) {
      this.list.replaceChildren(
        emptyState({
          icon: 'search',
          title: 'No models match',
          text: 'Try a different search, or relax a filter.',
          action: h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline-primary btn-sm',
              onclick: () => this.resetFilters(),
            },
            'Reset filters',
          ),
          testId: 'models-empty',
        }),
      );
      this.moreSlot.replaceChildren();
      return;
    }

    const first = this.visible.slice(0, this.shown);
    if (this.view === 'cards') {
      const grid = h('div', {
        class: 'row row-cols-1 row-cols-md-2 row-cols-xl-3 g-3',
        'data-testid': 'models-grid',
      });
      this.rows = grid;
      grid.append(...first.map((model) => this.card(model)));
      this.list.replaceChildren(grid);
    } else {
      const body = h(
        'tbody',
        null,
        first.map((model) => this.tableRow(model)),
      );
      this.rows = body;
      this.list.replaceChildren(
        h(
          'div',
          { class: 'card shadow-sm' },
          h(
            'div',
            { class: 'table-responsive' },
            h(
              'table',
              {
                class: 'table table-hover align-middle mb-0 or-model-table',
                'data-testid': 'models-table',
              },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Compare')),
                  h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Favourite')),
                  h('th', { scope: 'col' }, 'Model'),
                  h('th', { scope: 'col' }, 'Provider'),
                  h('th', { scope: 'col' }, 'Capabilities'),
                  h('th', { scope: 'col' }, 'Price'),
                  h('th', { scope: 'col' }, 'Context'),
                  h('th', { scope: 'col' }, 'Your use'),
                ),
              ),
              body,
            ),
          ),
        ),
      );
    }
    this.renderMore();
    this.syncChecks();
  }

  private renderMore(): void {
    const remaining = this.visible.length - this.shown;
    this.moreSlot.replaceChildren(
      remaining > 0
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline-secondary',
              'data-testid': 'models-more',
              onclick: () => this.showMore(),
            },
            `Show ${Math.min(PAGE_SIZE, remaining)} more`,
            h('span', { class: 'text-body-secondary ms-2' }, `(${remaining} left)`),
          )
        : '',
    );
    if (remaining > 0) this.more.recheck();
  }

  private showMore(): void {
    if (!this.rows || this.shown >= this.visible.length) return;
    const next = this.visible.slice(this.shown, this.shown + PAGE_SIZE);
    this.shown += next.length;
    this.rows.append(
      ...next.map((model) => (this.view === 'cards' ? this.card(model) : this.tableRow(model))),
    );
    this.renderMore();
    this.syncChecks();
  }

  // --- model parts --------------------------------------------------------------------------------------

  private badges(model: ModelInfo): HTMLElement {
    const expiry = expiryOf(model);
    return h(
      'div',
      { class: 'd-flex flex-wrap gap-1' },
      model.isFree
        ? h(
            'span',
            { class: 'badge rounded-pill text-bg-success', 'data-testid': 'free-badge' },
            'Free',
          )
        : null,
      model.capabilities.map((capability) =>
        h(
          'span',
          { class: 'badge rounded-pill bg-secondary-subtle text-secondary-emphasis fw-medium' },
          capabilityBadge(capability),
        ),
      ),
      expiry
        ? h(
            'span',
            {
              class:
                'badge rounded-pill bg-warning-subtle text-warning-emphasis d-inline-flex align-items-center gap-1',
              title: expiry.expired
                ? `This model expired on ${expiry.date}.`
                : `OpenRouter lists this model until ${expiry.date}.`,
              'data-testid': 'expiry-badge',
            },
            icon('exclamation-triangle-fill'),
            expiry.expired ? 'Expired' : `Expires ${expiry.date}`,
          )
        : null,
    );
  }

  private idRow(model: ModelInfo): HTMLElement {
    return h(
      'div',
      { class: 'd-flex align-items-center gap-1 min-w-0' },
      h('code', { class: 'small text-break', 'data-testid': 'model-id' }, model.id),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-link py-0 px-1 flex-shrink-0',
          'aria-label': `Copy model id ${model.id}`,
          title: 'Copy model id',
          'data-testid': 'model-copy',
          onclick: () => {
            void copyText(model.id).then((ok) =>
              toast(
                ok
                  ? { message: `Copied ${model.id}.`, variant: 'success' }
                  : { message: 'Copying was blocked by the browser.', variant: 'warning' },
              ),
            );
          },
        },
        icon('clipboard'),
      ),
    );
  }

  private star(model: ModelInfo): HTMLButtonElement {
    const on = this.isFavourite(model.id);
    const button = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-link or-star',
        'aria-pressed': String(on),
        'aria-label': `Favourite: ${model.name}`,
        title: on ? 'Remove from favourites' : 'Add to favourites',
        'data-testid': 'model-star',
        onclick: () => this.toggleFavourite(model),
      },
      icon(on ? 'star-fill' : 'star'),
    );
    this.stars.set(model.id, button);
    return button;
  }

  private compareBox(model: ModelInfo, label: boolean): HTMLElement {
    const id = uid('compare');
    const box = h('input', {
      id,
      type: 'checkbox',
      class: 'form-check-input',
      'aria-label': label ? undefined : `Compare: ${model.name}`,
      'data-testid': 'model-compare',
      onchange: () => this.toggleCompare(model, box.checked),
    });
    this.checks.set(model.id, box);
    return label
      ? h(
          'div',
          { class: 'form-check mb-0' },
          box,
          h(
            'label',
            { class: 'form-check-label small', htmlFor: id },
            'Compare',
            h('span', { class: 'visually-hidden' }, `: ${model.name}`),
          ),
        )
      : box;
  }

  private usage(model: ModelInfo, className = 'small text-body-secondary'): HTMLElement {
    const element = h('span', { class: className, 'data-testid': 'model-usage' }, '…');
    const slot = { id: model.id, element };
    this.usageSlots.push(slot);
    this.fillUsage(slot);
    return element;
  }

  private fillUsage(slot: { id: string; element: HTMLElement }): void {
    let promise = this.usageCache.get(slot.id);
    if (!promise) {
      promise = this.core.stats.modelSummary(slot.id);
      this.usageCache.set(slot.id, promise);
    }
    promise.then(
      (usage) => {
        slot.element.textContent = usageText(usage);
        slot.element.dataset.runs = String(usage.runs);
      },
      () => {
        slot.element.textContent = '—';
      },
    );
  }

  private card(model: ModelInfo): HTMLElement {
    const titleId = uid('model-title');
    const context = formatContext(model.contextLength);
    const fact = (term: string, value: Child): Child[] => [
      h('dt', { class: 'col-4 fw-normal text-body-secondary' }, term),
      h('dd', { class: 'col-8 mb-1' }, value),
    ];
    return h(
      'div',
      { class: 'col' },
      h(
        'article',
        {
          class: 'card h-100 shadow-sm or-model-card',
          'aria-labelledby': titleId,
          'data-testid': 'model-card',
          'data-model-id': model.id,
        },
        h(
          'div',
          { class: 'card-body pb-2' },
          h(
            'div',
            { class: 'd-flex align-items-start gap-2 mb-1' },
            h(
              'div',
              { class: 'min-w-0 flex-grow-1' },
              h('h3', { class: 'h6 mb-1 text-break', id: titleId }, model.name),
              this.idRow(model),
            ),
            this.star(model),
          ),
          h('div', { class: 'my-2' }, this.badges(model)),
          h(
            'dl',
            { class: 'row small mb-0' },
            fact('Provider', model.author || '—'),
            fact('Price', h('span', { 'data-testid': 'model-price' }, priceText(model))),
            fact('Context', context ? context.replace(' context', ' tokens') : '—'),
          ),
        ),
        h(
          'div',
          { class: 'card-footer d-flex align-items-center justify-content-between gap-2 py-2' },
          this.usage(model),
          this.compareBox(model, true),
        ),
      ),
    );
  }

  private tableRow(model: ModelInfo): HTMLElement {
    const context = formatContext(model.contextLength);
    return h(
      'tr',
      { 'data-testid': 'model-row', 'data-model-id': model.id },
      h('td', null, this.compareBox(model, false)),
      h('td', null, this.star(model)),
      h(
        'th',
        { scope: 'row', class: 'fw-normal or-model-cell' },
        h('div', { class: 'fw-semibold text-break' }, model.name),
        this.idRow(model),
      ),
      h('td', null, model.author || '—'),
      h('td', null, this.badges(model)),
      h('td', { class: 'small', 'data-testid': 'model-price' }, priceText(model)),
      h('td', { class: 'small text-nowrap' }, context ? context.replace(' context', '') : '—'),
      h('td', null, this.usage(model)),
    );
  }

  // --- favourites, recent -------------------------------------------------------------------------------

  private toggleFavourite(model: ModelInfo): void {
    const next = !this.isFavourite(model.id);
    try {
      this.core.settings.update((draft) => {
        draft.models.favourites = next
          ? [...draft.models.favourites, model.id]
          : draft.models.favourites.filter((id) => id !== model.id);
      });
    } catch (error) {
      void presentError(error);
      return;
    }
    announce(
      next ? `${model.name} added to favourites.` : `${model.name} removed from favourites.`,
    );
  }

  /** Updates every star in place (a re-render would drop keyboard focus). */
  private syncStars(): void {
    for (const [id, button] of this.stars) {
      const on = this.isFavourite(id);
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'Remove from favourites' : 'Add to favourites';
      button.replaceChildren(icon(on ? 'star-fill' : 'star'));
    }
  }

  private renderRecent(): void {
    const models = this.core.settings
      .get()
      .models.recent.map((id) => this.byId.get(id))
      .filter((model): model is ModelInfo => model !== undefined);
    this.recent.hidden = models.length === 0;
    this.recent.replaceChildren(
      h('h2', { id: 'models-recent-title', class: 'or-section-label mb-2' }, 'Recently used'),
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        models.map((model) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2',
              title: model.id,
              'data-testid': 'recent-model',
              onclick: () => this.setSearch(model.id),
            },
            model.name,
            model.isFree
              ? h('span', { class: 'badge rounded-pill text-bg-success' }, 'Free')
              : null,
          ),
        ),
      ),
    );
  }

  // --- comparison ---------------------------------------------------------------------------------------

  private toggleCompare(model: ModelInfo, on: boolean): void {
    if (on && this.compare.length >= MAX_COMPARE) {
      this.checks.get(model.id)!.checked = false;
      return;
    }
    this.compare = on ? [...this.compare, model.id] : this.compare.filter((id) => id !== model.id);
    this.syncChecks();
    this.renderTray();
    announce(
      on
        ? `${model.name} added to the comparison, ${plural(this.compare.length, 'model')} selected.`
        : `${model.name} removed from the comparison.`,
    );
  }

  /** Checked state of every drawn box; at the limit the others are disabled. */
  private syncChecks(): void {
    const full = this.compare.length >= MAX_COMPARE;
    for (const [id, box] of this.checks) {
      const on = this.compare.includes(id);
      box.checked = on;
      box.disabled = full && !on;
      box.title = box.disabled ? `Compare up to ${MAX_COMPARE} models` : '';
    }
  }

  private renderTray(): void {
    const selected = this.compare
      .map((id) => this.byId.get(id))
      .filter((model): model is ModelInfo => model !== undefined);
    this.tray.hidden = selected.length === 0;
    this.main.classList.toggle('has-compare-tray', selected.length > 0);
    this.tray.replaceChildren(
      h(
        'div',
        { class: 'container-xxl d-flex flex-wrap align-items-center gap-2 py-2' },
        h('span', { class: 'fw-semibold me-1' }, `Compare (${selected.length}/${MAX_COMPARE})`),
        h(
          'ul',
          { class: 'list-unstyled d-flex flex-wrap gap-2 mb-0 me-auto' },
          selected.map((model) =>
            h(
              'li',
              {
                class: 'badge or-compare-chip d-inline-flex align-items-center gap-1',
                'data-testid': 'compare-chip',
              },
              h('span', { class: 'text-truncate' }, model.name),
              h('button', {
                type: 'button',
                class: 'btn-close btn-sm',
                'aria-label': `Remove ${model.name} from the comparison`,
                onclick: () => {
                  this.toggleCompare(model, false);
                },
              }),
            ),
          ),
        ),
        selected.length < 2
          ? h('span', { class: 'small text-body-secondary' }, 'Pick at least two models.')
          : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-sm',
            disabled: selected.length < 2,
            'data-testid': 'compare-open',
            onclick: () => void this.openComparison(selected),
          },
          icon('columns-gap', 'me-1'),
          'Compare',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-secondary btn-sm',
            'data-testid': 'compare-clear',
            onclick: () => {
              this.compare = [];
              this.syncChecks();
              this.renderTray();
            },
          },
          'Clear',
        ),
      ),
    );
  }

  private async openComparison(models: ModelInfo[]): Promise<void> {
    const usage = new Map<string, ModelUsage>();
    await Promise.all(
      models.map(async (model) => {
        try {
          usage.set(model.id, await this.core.stats.modelSummary(model.id));
        } catch {
          // Shown as "Not used yet".
        }
      }),
    );
    const sections = compareSections(models, usage);
    const columns = models.length;
    const table = h(
      'table',
      { class: 'table align-middle or-compare-table mb-0', 'data-testid': 'compare-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Property')),
          models.map((model) =>
            h(
              'th',
              { scope: 'col', class: 'fw-semibold' },
              h('div', { class: 'text-break' }, model.name),
              model.isFree
                ? h('span', { class: 'badge rounded-pill text-bg-success' }, 'Free')
                : null,
            ),
          ),
        ),
      ),
      sections.map((section) =>
        h(
          'tbody',
          null,
          h(
            'tr',
            { class: 'or-compare-section' },
            h('th', { scope: 'colgroup', colSpan: columns + 1 }, section.title),
          ),
          section.rows.map((row) =>
            h(
              'tr',
              null,
              h('th', { scope: 'row', class: 'fw-normal text-body-secondary' }, row.label),
              row.values.map((value) =>
                row.kind === 'flag'
                  ? h(
                      'td',
                      null,
                      value === 'yes'
                        ? [
                            icon('check-lg', 'text-success-emphasis'),
                            h('span', { class: 'visually-hidden' }, 'Supported'),
                          ]
                        : [
                            h('span', { 'aria-hidden': 'true' }, '–'),
                            h('span', { class: 'visually-hidden' }, 'Not supported'),
                          ],
                    )
                  : h('td', { class: 'text-break' }, value),
              ),
            ),
          ),
        ),
      ),
    );
    const close = h(
      'button',
      { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
      'Close',
    );
    openModal({
      title: `Compare ${models.length} models`,
      icon: 'columns-gap',
      size: 'xl',
      scrollable: true,
      body: h(
        'div',
        {
          class: 'table-responsive',
          role: 'region',
          tabIndex: 0,
          'aria-label': 'Comparison table',
        },
        table,
      ),
      footer: close,
      initialFocus: close,
      testId: 'compare-dialog',
    });
  }
}
