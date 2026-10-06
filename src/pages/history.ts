/**
 * History: a searchable timeline of every run across the tools, grouped by day, loaded a page at a time with
 * the `before` cursor (a "Show more" button, and automatically when the end scrolls into view). A row opens the
 * run's detail drawer: prompt, settings, output, usage by model, error and meta, with Reopen in the tool,
 * Re-run with another model, Star, Copy output, Export JSON and Delete (with Undo). Export and delete also work
 * on everything the current filters match. `history.subscribe` keeps the list live, also across tabs.
 *
 * Deep links: `?tool=` filters to one tool; `?run=` opens that run's drawer. Both are kept in the address bar.
 */
import { downloadBlob } from '../core/files';
import { url } from '../core/paths';
import type { CoreServices, RunRecord, RunStatus } from '../core/types';
import { debounce, SEARCH_DEBOUNCE_MS } from '../core/util';
import { findTool, tools } from '../tools/registry';
import type { ToolId } from '../tools/types';
import { Offcanvas, showOffcanvas } from '../ui/bootstrap';
import { copyWithToast } from '../ui/clipboard';
import { dataTable } from '../ui/components/data-table';
import { emptyState } from '../ui/components/empty-state';
import { listSkeleton, loadInto } from '../ui/components/load-into';
import { modelPicker } from '../ui/components/model-picker';
import { starButton } from '../ui/components/star-button';
import { type Child, h, replace } from '../ui/dom';
import { announce } from '../ui/feedback/announce';
import { confirmDialog, typedConfirm } from '../ui/feedback/dialogs';
import { presentError } from '../ui/feedback/errors';
import { toast } from '../ui/feedback/toast';
import {
  formatCount,
  formatDateTime,
  formatInt,
  formatMs,
  formatRelativeTime,
  formatUsd,
  isoDateTime,
  plural,
} from '../ui/format';
import { icon } from '../ui/icon';
import { uid } from '../ui/id';
import { renderMarkdown } from '../ui/markdown';
import { mountPage } from '../ui/shell/index';
import { toolUrl } from '../ui/shell/links';
import {
  activeHistoryFilters,
  appendPage,
  costInfo,
  dayKey,
  dayLabel,
  type DayGroup,
  entriesOf,
  groupByDay,
  type HistoryFilters,
  latencyText,
  modelsOf,
  nextPage,
  NO_HISTORY_FILTERS,
  outputView,
  PAGE_SIZE,
  parseHistoryParams,
  splitDeletable,
  STATUS_INFO,
  toQuery,
  tokenText,
  usageRows,
} from './history-logic';
import { whenVisible } from './lazy';

const EVERYTHING = Number.MAX_SAFE_INTEGER;
/** The model filter is built by reading the runs in pages of this size, in the background. */
const MODEL_SCAN_PAGE = 200;
const MODEL_SCAN_MAX_PAGES = 500;
const STATUSES: RunStatus[] = ['ok', 'error', 'aborted', 'running'];

/**
 * A run's tool as History draws it. A run can name a tool this build lacks (an older backup, a removed tool); it is
 * still listed, so it can be exported or deleted, but there is nothing to reopen it in.
 */
function toolOf(run: RunRecord): { name: string; icon: string; known: boolean } {
  const tool = findTool(run.tool);
  return tool
    ? { name: tool.name, icon: tool.icon, known: true }
    : { name: run.tool, icon: 'question-circle', known: false };
}

const fileStem = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'run';

mountPage(
  {
    title: 'History',
    icon: 'clock-history',
    lead: 'Every run across all tools, newest first. Text only: images, audio and video are never stored.',
    nav: 'history',
  },
  ({ core, main, navigate }) => {
    new HistoryPage(core, main, navigate).start();
  },
);

class HistoryPage {
  private filters: HistoryFilters = { ...NO_HISTORY_FILTERS };
  private shown: RunRecord[] = [];
  private hasMore = false;
  private loadingMore = false;
  /** Bumped by every (re)load; an older answer is dropped. */
  private generation = 0;
  private totalRuns: number | null = null;
  /** The last day section drawn: "Show more" appends its rows here instead of redrawing everything. */
  private lastDay: { key: string; list: HTMLElement } | null = null;
  private modelScan = 0;
  /** The models of the history, from the last full scan plus the runs added since; null before the first scan. */
  private knownModels: Set<string> | null = null;
  /** Models added while a full scan runs (it may have read past them), merged into its result. */
  private modelsDuringScan = new Set<string>();
  /** Runs changed since the model filter was last updated; null when the change named none (rescan). */
  private changedRuns: Set<string> | null = new Set();

  private currentRun: RunRecord | null = null;
  private detailGeneration = 0;

  private readonly ids = {
    search: uid('history-search'),
    tool: uid('history-tool'),
    status: uid('history-status'),
    model: uid('history-model'),
    key: uid('history-key'),
    from: uid('history-from'),
    to: uid('history-to'),
    starred: uid('history-starred'),
  };

  private readonly search = h('input', {
    id: this.ids.search,
    type: 'search',
    class: 'form-control form-control-lg or-search-input',
    placeholder: 'Search prompts, outputs and titles',
    autocomplete: 'off',
    spellcheck: false,
    'data-testid': 'history-search',
  });
  private readonly toolSelect = h(
    'select',
    { id: this.ids.tool, class: 'form-select', 'data-testid': 'history-tool' },
    h('option', { value: '' }, 'All tools'),
    tools.map((tool) => h('option', { value: tool.id }, tool.name)),
  );
  private readonly statusSelect = h(
    'select',
    { id: this.ids.status, class: 'form-select', 'data-testid': 'history-status' },
    h('option', { value: '' }, 'Any status'),
    STATUSES.map((status) => h('option', { value: status }, STATUS_INFO[status].label)),
  );
  private readonly modelSelect = h(
    'select',
    { id: this.ids.model, class: 'form-select', 'data-testid': 'history-model' },
    h('option', { value: '' }, 'Any model'),
  );
  private readonly keySelect = h(
    'select',
    { id: this.ids.key, class: 'form-select', 'data-testid': 'history-key' },
    h('option', { value: '' }, 'Any key'),
  );
  private readonly fromInput = h('input', {
    id: this.ids.from,
    type: 'date',
    class: 'form-control',
    'data-testid': 'history-from',
  });
  private readonly toInput = h('input', {
    id: this.ids.to,
    type: 'date',
    class: 'form-control',
    'data-testid': 'history-to',
  });
  private readonly starredInput = h('input', {
    id: this.ids.starred,
    type: 'checkbox',
    class: 'form-check-input',
    'data-testid': 'history-starred',
  });
  private readonly resetButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-link btn-sm p-0',
      hidden: true,
      'data-testid': 'history-reset',
      onclick: () => this.resetFilters(),
    },
    'Reset filters',
  );
  private readonly count = h('p', {
    class: 'small text-body-secondary mb-2',
    role: 'status',
    'data-testid': 'history-count',
  });
  private readonly list = h('div', { tabIndex: -1, 'data-testid': 'history-list' });
  private readonly moreSlot = h('div', { class: 'text-center py-3' });
  private readonly more = whenVisible(this.moreSlot, () => void this.loadMore());

  /** Typing in the search box filters the list once it pauses. */
  private readonly readSoon = debounce(() => this.readControls(), SEARCH_DEBOUNCE_MS);
  /** A change in the history (also from another tab) redraws the list once the changes stop. */
  private readonly reloadSoon = debounce(() => void this.reload({ keep: true }), 120);
  /** The model filter is updated a moment after the history changed. */
  private readonly scanSoon = debounce(() => void this.updateModels(), 1500);

  // The detail drawer.
  private readonly drawerTitleId = uid('run-title');
  private readonly drawerTitle = h('h2', {
    class: 'offcanvas-title h5 mb-1 text-break',
    id: this.drawerTitleId,
    'data-testid': 'run-drawer-title',
  });
  private readonly drawerSub = h('div', { class: 'small text-body-secondary' });
  private readonly drawerBody = h('div', { class: 'offcanvas-body pt-3' });
  private readonly drawerElement: HTMLElement;
  private readonly drawer: Offcanvas;

  private readonly core: CoreServices;
  private readonly main: HTMLElement;
  private readonly navigate: (href: string) => Promise<boolean>;

  constructor(core: CoreServices, main: HTMLElement, navigate: (href: string) => Promise<boolean>) {
    this.core = core;
    this.main = main;
    this.navigate = navigate;
    this.drawerElement = h(
      'div',
      {
        class: 'offcanvas offcanvas-end or-run-drawer',
        tabIndex: -1,
        'aria-labelledby': this.drawerTitleId,
        'data-testid': 'run-drawer',
      },
      h(
        'div',
        { class: 'offcanvas-header border-bottom align-items-start' },
        h('div', { class: 'min-w-0' }, this.drawerTitle, this.drawerSub),
        h('button', {
          type: 'button',
          class: 'btn-close',
          'data-bs-dismiss': 'offcanvas',
          'aria-label': 'Close',
        }),
      ),
      this.drawerBody,
    );
    document.body.append(this.drawerElement);
    this.drawer = new Offcanvas(this.drawerElement);
    this.drawerElement.addEventListener('hidden.bs.offcanvas', () => {
      this.currentRun = null;
      this.setParam('run', null);
    });
  }

  start(): void {
    const params = parseHistoryParams(window.location.search);
    if (params.tool) {
      this.filters.tool = params.tool;
      this.toolSelect.value = params.tool;
    }

    this.main.append(this.toolbar(), this.filterPanel(), this.count, this.list, this.moreSlot);
    this.wire();
    this.fillKeys();
    void this.scanModels();
    void this.reload().then(() => {
      if (params.run) void this.openDeepLink(params.run);
    });

    this.core.history.subscribe((ids) => {
      this.reloadSoon();
      if (!ids || this.changedRuns === null) this.changedRuns = null;
      else for (const id of ids) this.changedRuns.add(id);
      this.scanSoon();
    });
    this.core.keys.subscribe(() => this.fillKeys());
  }

  // --- header actions and filters -----------------------------------------------------------------------

  private toolbar(): HTMLElement {
    const item = (
      label: string,
      iconName: string,
      testId: string,
      onClick: () => void,
    ): HTMLElement =>
      h(
        'li',
        null,
        h(
          'button',
          {
            type: 'button',
            class: 'dropdown-item d-flex align-items-center gap-2',
            'data-testid': testId,
            onclick: onClick,
          },
          icon(iconName),
          label,
        ),
      );
    return h(
      'div',
      { class: 'row g-2 align-items-center mb-3' },
      h(
        'div',
        { class: 'col-12 col-md position-relative', role: 'search' },
        h('label', { class: 'visually-hidden', htmlFor: this.ids.search }, 'Search history'),
        icon('search', 'or-search-icon'),
        this.search,
      ),
      h(
        'div',
        { class: 'col-12 col-md-auto dropdown' },
        h(
          'button',
          {
            type: 'button',
            class:
              'btn btn-outline-secondary d-inline-flex align-items-center gap-2 dropdown-toggle',
            'data-bs-toggle': 'dropdown',
            'aria-expanded': 'false',
            'data-testid': 'history-menu',
          },
          icon('three-dots'),
          'Export and delete',
        ),
        h(
          'ul',
          { class: 'dropdown-menu dropdown-menu-end shadow' },
          item(
            'Export all as JSON',
            'download',
            'history-export-all',
            () => void this.exportRuns(false),
          ),
          item(
            'Export filtered as JSON',
            'funnel',
            'history-export-filtered',
            () => void this.exportRuns(true),
          ),
          h('li', null, h('hr', { class: 'dropdown-divider' })),
          item(
            'Delete filtered runs…',
            'trash',
            'history-delete-filtered',
            () => void this.deleteFiltered(),
          ),
        ),
      ),
    );
  }

  private filterPanel(): HTMLElement {
    const field = (label: string, id: string, control: HTMLElement): HTMLElement =>
      h(
        'div',
        { class: 'col-6 col-md-4 col-xl-2' },
        h('label', { class: 'form-label small mb-1', htmlFor: id }, label),
        control,
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
          field('Tool', this.ids.tool, this.toolSelect),
          field('Status', this.ids.status, this.statusSelect),
          field('Model', this.ids.model, this.modelSelect),
          field('Key', this.ids.key, this.keySelect),
          field('From', this.ids.from, this.fromInput),
          field('To', this.ids.to, this.toInput),
          h(
            'div',
            { class: 'col-12 col-xl-auto d-flex flex-wrap align-items-center gap-3 pb-1' },
            h(
              'div',
              { class: 'form-check' },
              this.starredInput,
              h('label', { class: 'form-check-label', htmlFor: this.ids.starred }, 'Starred only'),
            ),
            this.resetButton,
          ),
        ),
      ),
    );
  }

  private wire(): void {
    this.search.addEventListener('input', () => this.readSoon());
    this.search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.search.value) {
        this.search.value = '';
        this.readSoon.cancel();
        this.readControls();
      }
    });
    for (const control of [
      this.toolSelect,
      this.statusSelect,
      this.modelSelect,
      this.keySelect,
      this.fromInput,
      this.toInput,
      this.starredInput,
    ]) {
      control.addEventListener('change', () => this.readControls());
    }
  }

  private readControls(): void {
    this.filters = {
      text: this.search.value.trim(),
      tool: this.toolSelect.value as ToolId | '',
      status: this.statusSelect.value as RunStatus | '',
      model: this.modelSelect.value,
      keyId: this.keySelect.value,
      starred: this.starredInput.checked,
      from: this.fromInput.value,
      to: this.toInput.value,
    };
    this.setParam('tool', this.filters.tool || null);
    void this.reload();
  }

  private resetFilters(): void {
    this.search.value = '';
    this.toolSelect.value = '';
    this.statusSelect.value = '';
    this.modelSelect.value = '';
    this.keySelect.value = '';
    this.fromInput.value = '';
    this.toInput.value = '';
    this.starredInput.checked = false;
    this.readControls();
    this.search.focus();
  }

  private fillKeys(): void {
    const current = this.keySelect.value;
    const keys = this.core.keys.list();
    replace(
      this.keySelect,
      h('option', { value: '' }, 'Any key'),
      keys.map((key) => h('option', { value: key.id }, key.name)),
    );
    this.keySelect.value = keys.some((key) => key.id === current) ? current : '';
    // The filtered key was removed: the select now says "Any key", so the list must stop filtering by it.
    if (this.filters.keyId !== this.keySelect.value) this.readControls();
  }

  /**
   * The model filter lists every model the runs in the history called (`model` and `models`, so routed ids such
   * as the ones behind `openrouter/free` are there), read from the runs themselves in pages in the background; a
   * deleted run's models disappear with it.
   */
  private async scanModels(): Promise<void> {
    const mine = ++this.modelScan;
    const found = new Set<string>();
    this.modelsDuringScan = new Set();
    let before: number | undefined;
    try {
      for (let pages = 0; pages < MODEL_SCAN_MAX_PAGES; pages++) {
        const page = await this.core.history.query({
          limit: MODEL_SCAN_PAGE,
          ...(before === undefined ? {} : { before }),
        });
        if (mine !== this.modelScan) return;
        for (const model of modelsOf(page)) found.add(model);
        const last = page.at(-1);
        if (page.length < MODEL_SCAN_PAGE || !last) break;
        // The cursor is exclusive and runs can share a millisecond: ask again from just after the last one.
        const next = last.startedAt + 1;
        if (before !== undefined && next >= before) break;
        before = next;
      }
    } catch {
      return; // The filter keeps what it had.
    }
    for (const model of this.modelsDuringScan) found.add(model);
    this.knownModels = found;
    this.paintModels([...found].sort());
  }

  /**
   * After a change: the changed runs' models are added to the filter (only those runs are read), and the history is
   * scanned again only when a run went away (its models may have gone with it) or the change named no runs (a bulk
   * delete, a sweep, a reset). Starting or finishing a run, the common change, never rescans the history.
   */
  private async updateModels(): Promise<void> {
    const ids = this.changedRuns;
    this.changedRuns = new Set();
    if (ids === null || this.knownModels === null) return this.scanModels();
    if (ids.size === 0) return;
    const mine = this.modelScan;
    let runs: (RunRecord | undefined)[];
    try {
      runs = await Promise.all([...ids].map((id) => this.core.history.get(id)));
    } catch {
      return; // The filter keeps what it had.
    }
    if (mine !== this.modelScan) return; // a newer full scan covers these runs
    const present = runs.filter((run): run is RunRecord => run !== undefined);
    if (present.length < runs.length) return this.scanModels();
    for (const model of modelsOf(present)) {
      this.knownModels?.add(model);
      this.modelsDuringScan.add(model);
    }
    this.paintModels([...(this.knownModels ?? [])].sort());
  }

  private paintModels(models: string[]): void {
    const current = this.modelSelect.value;
    // The model being filtered by stays a choice even when no run has it any more, so the control matches the list.
    const options = [
      ...new Set([...models, ...(this.filters.model ? [this.filters.model] : [])]),
    ].sort();
    replace(
      this.modelSelect,
      h('option', { value: '' }, 'Any model'),
      options.map((model) => h('option', { value: model }, model)),
    );
    this.modelSelect.value = options.includes(current) ? current : '';
  }

  /** Keeps one query parameter in the address bar (`null` removes it). */
  private setParam(name: string, value: string | null): void {
    const next = new URL(window.location.href);
    if (value) next.searchParams.set(name, value);
    else next.searchParams.delete(name);
    window.history.replaceState(window.history.state as unknown, '', next);
  }

  // --- loading ------------------------------------------------------------------------------------------

  /**
   * Loads the first page of the current filters, or with `keep` as many rows as are shown now (a live update:
   * the list keeps its length and the keyboard focus). A live update leaves the rows on screen while it runs,
   * and when it fails (the toast says so). A load the user asked for (search, filters, reset, Try again) shows
   * the skeleton, and the error state when it fails: the rows on screen no longer match what was asked.
   */
  private reload(options: { keep?: boolean } = {}): Promise<boolean> {
    const mine = ++this.generation;
    const limit = options.keep ? Math.max(this.shown.length, PAGE_SIZE) : PAGE_SIZE;
    return loadInto(
      this.list,
      async () => {
        const [page, total] = await Promise.all([
          this.core.history.query(toQuery(this.filters, { limit })),
          this.core.history.count(),
        ]);
        if (mine !== this.generation) return;
        this.shown = page;
        this.hasMore = page.length >= limit;
        this.totalRuns = total;
        this.keepFocus(() => this.render());
        void this.refreshOpenRun();
      },
      {
        skeleton: listSkeleton(4),
        status: (text) => (this.count.textContent = text),
        messages: { loading: 'Loading history…', failed: 'History could not be loaded.' },
        error: {
          icon: 'exclamation-triangle',
          title: 'History could not be loaded',
          text: 'Browser storage is unavailable, so there is nothing to show.',
          testId: 'history-error',
        },
        retry: () => void this.reload(),
        keepOnLiveFailure: options.keep === true,
        toast: true,
      },
    );
  }

  private async loadMore(): Promise<void> {
    if (this.loadingMore || !this.hasMore) return;
    const next = nextPage(this.shown);
    if (!next) return;
    this.loadingMore = true;
    const mine = this.generation;
    try {
      const page = await this.core.history.query(toQuery(this.filters, next));
      if (mine !== this.generation) return;
      const before = this.shown.length;
      this.shown = appendPage(this.shown, page);
      this.hasMore = page.length >= next.limit;
      // Only the new rows are built; the ones on screen (and the focus in them) stay as they are.
      this.appendRows(this.shown.slice(before));
      this.renderFooter();
    } catch (error) {
      void presentError(error, { retry: () => void this.loadMore() });
    } finally {
      this.loadingMore = false;
    }
  }

  /** Runs `draw`, then puts the keyboard focus back on the same row control, if it is still there. */
  private keepFocus(draw: () => void): void {
    const active = document.activeElement;
    const key =
      active instanceof HTMLElement && this.list.contains(active)
        ? {
            run: active.closest<HTMLElement>('[data-run-id]')?.dataset.runId,
            part: active.dataset.part,
          }
        : null;
    draw();
    if (!key?.run) return;
    const target = this.list.querySelector<HTMLElement>(
      `[data-run-id="${CSS.escape(key.run)}"] [data-part="${key.part ?? 'open'}"]`,
    );
    (target ?? this.list).focus();
  }

  // --- the timeline -------------------------------------------------------------------------------------

  private render(): void {
    const active = activeHistoryFilters(this.filters);
    this.resetButton.hidden = active === 0;

    if (this.shown.length === 0) {
      this.moreSlot.replaceChildren();
      this.count.textContent = active > 0 ? 'No runs match.' : 'No runs yet.';
      this.list.replaceChildren(
        active > 0
          ? emptyState({
              icon: 'search',
              title: 'No runs match',
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
              testId: 'history-empty',
            })
          : emptyState({
              icon: 'clock-history',
              title: 'No runs yet',
              text: 'Every run of every tool shows up here, ready to reopen with its prompt and settings.',
              action: h(
                'a',
                { class: 'btn btn-primary btn-sm', href: url() },
                icon('house', 'me-2'),
                'Pick a tool',
              ),
              testId: 'history-empty',
            }),
      );
      return;
    }

    const days = groupByDay(this.shown).map((group) => ({
      key: group.key,
      ...this.daySection(group),
    }));
    this.lastDay = days.at(-1) ? { key: days.at(-1)!.key, list: days.at(-1)!.list } : null;
    replace(
      this.list,
      days.map((day) => day.section),
    );
    this.renderFooter();
  }

  private daySection(group: Pick<DayGroup, 'label' | 'runs'>): {
    section: HTMLElement;
    list: HTMLElement;
  } {
    const headingId = uid('history-day');
    const list = h(
      'div',
      { class: 'list-group shadow-sm' },
      group.runs.map((run) => this.row(run)),
    );
    const section = h(
      'section',
      { class: 'mb-4', 'aria-labelledby': headingId, 'data-testid': 'history-day' },
      h('h2', { id: headingId, class: 'or-section-label mb-2' }, group.label),
      list,
    );
    return { section, list };
  }

  /** Adds runs (older than everything shown) to the last day, or opens the days they belong to. */
  private appendRows(runs: readonly RunRecord[]): void {
    for (const run of runs) {
      const key = dayKey(run.startedAt);
      if (this.lastDay?.key === key) {
        this.lastDay.list.append(this.row(run));
      } else {
        const day = this.daySection({ label: dayLabel(run.startedAt), runs: [run] });
        this.list.append(day.section);
        this.lastDay = { key, list: day.list };
      }
    }
  }

  /** The count line and the "Show more" button. */
  private renderFooter(): void {
    const active = activeHistoryFilters(this.filters);
    const ofTotal =
      active === 0 && this.totalRuns !== null && this.totalRuns > this.shown.length
        ? ` of ${formatInt(this.totalRuns)}`
        : '';
    this.count.textContent = `${plural(this.shown.length, 'run')}${ofTotal}`;
    this.moreSlot.replaceChildren(
      this.hasMore
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline-secondary',
              'data-testid': 'history-more',
              onclick: () => void this.loadMore(),
            },
            'Show more',
          )
        : '',
    );
    if (this.hasMore) this.more.recheck();
  }

  private statusBadge(status: RunStatus): HTMLElement {
    const info = STATUS_INFO[status];
    return h(
      'span',
      {
        class: `badge rounded-pill ${info.badge}`,
        'data-testid': 'run-status',
        'data-status': status,
      },
      info.label,
    );
  }

  private costNode(run: RunRecord): HTMLElement {
    const cost = costInfo(run, (model) => this.core.models.isFree(model));
    return h(
      'span',
      {
        class: 'text-nowrap',
        title: cost.title,
        'data-testid': 'run-cost',
        'data-note': cost.note ?? '',
      },
      cost.note === 'unknown' ? icon('question-circle', 'me-1') : null,
      cost.text,
      cost.note === 'estimated' ? h('span', { class: 'visually-hidden' }, ' (estimated)') : null,
      cost.note === 'unknown' ? h('span', { class: 'visually-hidden' }, ' cost') : null,
    );
  }

  private row(run: RunRecord): HTMLElement {
    const tool = toolOf(run);
    const facts = [tokenText(run), latencyText(run)].filter(
      (text): text is string => text !== null,
    );
    return h(
      'div',
      {
        class: 'list-group-item p-0 d-flex align-items-stretch or-run-row',
        'data-testid': 'history-row',
        'data-run-id': run.id,
      },
      h(
        'button',
        {
          type: 'button',
          class:
            'or-run-open btn text-start d-flex flex-wrap align-items-center gap-3 flex-grow-1 min-w-0 px-3 py-3',
          'aria-haspopup': 'dialog',
          'data-part': 'open',
          'data-testid': 'run-open',
          onclick: () => void this.openRun(run.id),
        },
        h(
          'span',
          { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' },
          icon(tool.icon),
        ),
        h(
          'span',
          { class: 'min-w-0 flex-grow-1' },
          h(
            'span',
            { class: 'd-block fw-semibold text-truncate', 'data-testid': 'run-title' },
            run.title,
          ),
          h(
            'span',
            { class: 'd-block small text-body-secondary text-truncate' },
            tool.name,
            ' · ',
            run.model,
            run.models.length > 1 ? ` +${run.models.length - 1}` : '',
            ' · ',
            h(
              'time',
              {
                dateTime: isoDateTime(run.startedAt),
                title: formatDateTime(run.startedAt),
              },
              formatRelativeTime(run.startedAt),
            ),
          ),
        ),
        h(
          'span',
          { class: 'd-flex flex-wrap align-items-center gap-2 small text-body-secondary' },
          this.statusBadge(run.status),
          this.costNode(run),
          facts.map((fact) => h('span', { class: 'text-nowrap' }, fact)),
        ),
      ),
      h(
        'div',
        { class: 'd-flex align-items-center pe-2' },
        starButton({
          pressed: run.starred,
          label: `Star: ${run.title}`,
          titles: ['Star', 'Unstar'],
          part: 'star',
          testId: 'run-star',
          onToggle: () => void this.toggleStar(run),
        }),
      ),
    );
  }

  private async toggleStar(run: RunRecord): Promise<void> {
    const next = !run.starred;
    try {
      await this.core.history.setStarred(run.id, next);
    } catch (error) {
      void presentError(error);
      return;
    }
    announce(next ? 'Run starred.' : 'Run unstarred.');
  }

  // --- the detail drawer --------------------------------------------------------------------------------

  private async openDeepLink(id: string): Promise<void> {
    const found = await this.core.history.get(id).catch(() => undefined);
    if (!found) {
      toast({ message: 'That run is no longer in your history.', variant: 'warning' });
      this.setParam('run', null);
      return;
    }
    await this.openRun(id);
  }

  private async openRun(id: string): Promise<void> {
    let run: RunRecord | undefined;
    try {
      run = await this.core.history.get(id);
    } catch (error) {
      void presentError(error);
      return;
    }
    if (!run) {
      toast({ message: 'That run is no longer in your history.', variant: 'warning' });
      return;
    }
    this.currentRun = run;
    this.renderDetail(run);
    this.setParam('run', id);
    showOffcanvas(this.drawer, this.drawerElement);
  }

  /** A live update of the open run (it finished, was starred in another tab, or was deleted). */
  private async refreshOpenRun(): Promise<void> {
    const open = this.currentRun;
    // `currentRun` is set while the drawer is opening or open and cleared once it is hidden, so a change that
    // arrives during the slide-in is not lost.
    if (!open) return;
    const latest = await this.core.history.get(open.id).catch(() => undefined);
    if (this.currentRun?.id !== open.id) return;
    if (!latest) {
      this.drawer.hide();
      return;
    }
    const fingerprint = (r: RunRecord): string =>
      [r.status, r.starred, r.output?.length ?? -1, r.finishedAt, r.error ?? '', r.title].join('|');
    if (fingerprint(latest) === fingerprint(open)) return;
    this.currentRun = latest;
    this.keepDrawerFocus(() => this.renderDetail(latest));
  }

  /**
   * Runs `draw` (which rebuilds the drawer's content with `replace()`, so the focused control's successor, found
   * by `data-focus-key`, gets the focus). A focus lost to the page would leave Escape without effect (Bootstrap
   * listens for it on the drawer), so when the control is gone the drawer itself takes the focus.
   */
  private keepDrawerFocus(draw: () => void): void {
    const active = document.activeElement;
    const inDrawer = active instanceof HTMLElement && this.drawerElement.contains(active);
    draw();
    if (!inDrawer) return;
    // `replace()` gave focus to the successor of the control that had it; when there is none (or it is disabled
    // now) the drawer takes it.
    const now = document.activeElement;
    if (!(now instanceof HTMLElement) || !this.drawerElement.contains(now)) {
      this.drawerElement.focus();
    }
  }

  private detailSection(title: string, ...body: Child[]): HTMLElement {
    const id = uid('run-section');
    return h(
      'section',
      { class: 'mb-4', 'aria-labelledby': id },
      h('h3', { id, class: 'or-section-label mb-2' }, title),
      body,
    );
  }

  private definitionList(entries: { label: string; value: Child; block?: boolean }[]): HTMLElement {
    return h(
      'dl',
      { class: 'row small mb-0' },
      entries.map((entry) =>
        entry.block
          ? [
              h('dt', { class: 'col-12 fw-normal text-body-secondary' }, entry.label),
              h(
                'dd',
                { class: 'col-12 mb-2' },
                h(
                  'div',
                  {
                    class: 'or-detail-block or-plain-text',
                    tabIndex: 0,
                    role: 'region',
                    'aria-label': entry.label,
                  },
                  entry.value,
                ),
              ),
            ]
          : [
              h('dt', { class: 'col-4 fw-normal text-body-secondary' }, entry.label),
              h('dd', { class: 'col-8 mb-1 text-break' }, entry.value),
            ],
      ),
    );
  }

  private outputNode(run: RunRecord, generation: number): HTMLElement {
    if (!run.output) {
      return h(
        'p',
        { class: 'text-body-secondary mb-0', 'data-testid': 'run-no-output' },
        run.status === 'running'
          ? 'Still running. The output appears when it finishes.'
          : 'No text output was saved for this run. History keeps text only.',
      );
    }
    const view = outputView(run.output);
    if (view.kind === 'json') {
      return h(
        'pre',
        {
          class: 'or-detail-block or-detail-code mb-0',
          tabIndex: 0,
          role: 'region',
          'aria-label': 'Output',
          'data-focus-key': 'run-output',
          'data-testid': 'run-output',
        },
        h('code', null, view.text),
      );
    }
    // Plain text first, then the sanitised Markdown replaces it.
    const node = h(
      'div',
      {
        class: 'or-detail-block or-markdown',
        tabIndex: 0,
        role: 'region',
        'aria-label': 'Output',
        'data-focus-key': 'run-output',
        'data-testid': 'run-output',
      },
      view.text,
    );
    renderMarkdown(view.text).then(
      (fragment) => {
        if (generation === this.detailGeneration) node.replaceChildren(fragment);
      },
      () => undefined,
    );
    return node;
  }

  private actionButton(
    label: string,
    iconName: string,
    testId: string,
    onClick: () => void,
    extra: { danger?: boolean; disabled?: boolean; pressed?: boolean } = {},
  ): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: [
          'btn btn-sm d-inline-flex align-items-center gap-2',
          extra.danger ? 'btn-outline-danger' : 'btn-outline-secondary',
        ],
        disabled: extra.disabled === true,
        'aria-pressed': extra.pressed === undefined ? undefined : String(extra.pressed),
        'data-focus-key': testId,
        'data-testid': testId,
        onclick: onClick,
      },
      icon(iconName),
      label,
    );
  }

  private renderDetail(run: RunRecord): void {
    const generation = ++this.detailGeneration;
    const tool = toolOf(run);
    this.drawerTitle.textContent = run.title;
    this.drawerSub.replaceChildren(
      icon(tool.icon, 'me-1'),
      tool.name,
      ' · ',
      this.statusBadge(run.status),
      ' · ',
      h(
        'time',
        { dateTime: isoDateTime(run.startedAt), title: formatDateTime(run.startedAt) },
        formatRelativeTime(run.startedAt),
      ),
    );

    const cost = costInfo(run, (model) => this.core.models.isFree(model));
    const costNote =
      cost.note === 'estimated'
        ? 'Estimated from catalog prices; OpenRouter did not report it.'
        : cost.note === 'unknown'
          ? 'OpenRouter did not report a cost for this run.'
          : null;
    const tokens = tokenText(run);
    const duration = latencyText(run);
    const settingsEntries = entriesOf(run.settings);
    const metaEntries = entriesOf(run.meta);
    const usage = usageRows(run);

    const actions = h(
      'div',
      { class: 'd-flex flex-wrap gap-2 mb-4', role: 'group', 'aria-label': 'Run actions' },
      tool.known
        ? h(
            'a',
            {
              class: 'btn btn-primary btn-sm d-inline-flex align-items-center gap-2',
              href: toolUrl(run.tool, { run: run.id }),
              'data-focus-key': 'run-reopen',
              'data-testid': 'run-reopen',
            },
            icon('box-arrow-up-right'),
            `Reopen in ${tool.name}`,
          )
        : null,
      tool.known
        ? this.actionButton(
            'Re-run with another model',
            'arrow-repeat',
            'run-rerun',
            () => void this.rerun(run),
          )
        : null,
      this.actionButton(
        run.starred ? 'Starred' : 'Star',
        run.starred ? 'star-fill' : 'star',
        'run-detail-star',
        () => void this.toggleStar(run),
        { pressed: run.starred },
      ),
      this.actionButton(
        'Copy output',
        'clipboard',
        'run-copy',
        () => void copyWithToast(run.output ?? '', 'Output copied.'),
        { disabled: !run.output },
      ),
      this.actionButton('Export JSON', 'download', 'run-export', () => void this.exportOne(run)),
      this.actionButton('Delete', 'trash', 'run-delete', () => void this.deleteOne(run), {
        danger: true,
        disabled: run.status === 'running',
      }),
    );

    replace(
      this.drawerBody,
      actions,
      run.status === 'running'
        ? h(
            'p',
            { class: 'small text-body-secondary mb-4', 'data-testid': 'run-delete-note' },
            'This run is still in progress, so it cannot be deleted yet.',
          )
        : null,
      this.detailSection(
        'Summary',
        this.definitionList([
          { label: 'Model', value: run.models.length > 1 ? run.models.join(', ') : run.model },
          { label: 'Key', value: run.keyName || '—' },
          { label: 'Started', value: formatDateTime(run.startedAt) },
          ...(duration ? [{ label: 'Duration', value: duration }] : []),
          {
            label: 'Cost',
            value: [
              h('span', { title: cost.title, 'data-testid': 'run-detail-cost' }, cost.text),
              costNote ? h('div', { class: 'text-body-secondary' }, costNote) : null,
            ],
          },
          ...(tokens ? [{ label: 'Tokens', value: tokens }] : []),
          ...(run.usage.requests > 0
            ? [{ label: 'Requests', value: formatCount(run.usage.requests) }]
            : []),
        ]),
      ),
      run.error
        ? h(
            'div',
            { class: 'alert alert-danger d-flex gap-2 mb-4', 'data-testid': 'run-error' },
            icon('exclamation-octagon'),
            h('div', { class: 'text-break' }, run.error),
          )
        : null,
      run.prompt
        ? this.detailSection(
            'Prompt',
            h(
              'div',
              {
                class: 'or-detail-block or-plain-text',
                tabIndex: 0,
                role: 'region',
                'aria-label': 'Prompt',
                'data-focus-key': 'run-prompt',
                'data-testid': 'run-prompt',
              },
              run.prompt,
            ),
          )
        : null,
      settingsEntries.length > 0
        ? this.detailSection(
            'Settings',
            h(
              'div',
              { 'data-testid': 'run-settings' },
              this.definitionList(
                settingsEntries.map((entry) => ({
                  label: entry.label,
                  value: entry.value,
                  block: entry.block,
                })),
              ),
            ),
          )
        : null,
      this.detailSection('Output', this.outputNode(run, generation)),
      usage.length > 0 ? this.detailSection('Usage by model', this.usageTable(usage)) : null,
      metaEntries.length > 0 || run.jobId || run.groupId
        ? this.detailSection(
            'Details',
            this.definitionList([
              { label: 'Run id', value: h('code', null, run.id) },
              ...(run.jobId ? [{ label: 'Job id', value: h('code', null, run.jobId) }] : []),
              ...(run.groupId ? [{ label: 'Group id', value: h('code', null, run.groupId) }] : []),
              ...metaEntries.map((entry) => ({
                label: entry.label,
                value: entry.value,
                block: entry.block,
              })),
            ]),
          )
        : null,
    );
  }

  private usageTable(rows: ReturnType<typeof usageRows>): HTMLElement {
    return dataTable({
      scrollerLabel: 'Usage by model',
      class: 'table table-sm small align-middle mb-0',
      testId: 'run-usage',
      head: ['Model', 'Requests', 'Tokens in', 'Tokens out', 'Cost', 'Avg latency'],
      numericFrom: 1,
      rowHeaderClass: 'fw-normal text-break',
      rows: rows.map((row) => [
        row.model,
        String(row.requests),
        formatInt(row.promptTokens),
        formatInt(row.completionTokens),
        formatUsd(row.costUsd),
        row.avgLatencyMs === null ? '—' : formatMs(row.avgLatencyMs),
      ]),
    });
  }

  // --- run actions --------------------------------------------------------------------------------------

  private async rerun(run: RunRecord): Promise<void> {
    const capability = findTool(run.tool)?.capabilities[0];
    if (!capability) return;
    const model = await modelPicker(this.core, {
      capability,
      selected: run.model,
      title: 'Re-run with another model',
    });
    if (model) void this.navigate(toolUrl(run.tool, { run: run.id, model }));
  }

  private async exportOne(run: RunRecord): Promise<void> {
    try {
      downloadBlob(await this.core.history.exportJson([run.id]), `${fileStem(run.title)}.json`);
    } catch (error) {
      void presentError(error, { retry: () => void this.exportOne(run) });
    }
  }

  private async deleteOne(run: RunRecord): Promise<void> {
    const ok = await confirmDialog({
      title: 'Delete this run?',
      message: `“${run.title}” will be removed from your history. You can undo this right after. Spending stats are not affected.`,
      confirmLabel: 'Delete',
      tone: 'danger',
      testId: 'delete-run-dialog',
    });
    if (!ok) return;
    const latest = await this.core.history.get(run.id).catch(() => undefined);
    if (!latest) return;
    if (latest.status === 'running') {
      toast({
        message: 'This run is still in progress, so it cannot be deleted yet.',
        variant: 'warning',
      });
      return;
    }
    this.drawer.hide();
    await this.deleteRuns([latest]);
  }

  /** Removes runs and offers Undo (`history.restore`) in a toast that stays until it is used or closed. */
  private async deleteRuns(runs: RunRecord[]): Promise<void> {
    try {
      await this.core.history.remove(runs.map((run) => run.id));
    } catch (error) {
      void presentError(error);
      return;
    }
    toast({
      message: `Deleted ${plural(runs.length, 'run')}.`,
      variant: 'success',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          this.core.history
            .restore(runs)
            .then(() =>
              toast({ message: `Restored ${plural(runs.length, 'run')}.`, variant: 'success' }),
            )
            .catch((error: unknown) => void presentError(error));
        },
      },
    });
  }

  /** Every run the current filters match (not just the pages loaded so far). */
  private matching(): Promise<RunRecord[]> {
    return this.core.history.query(toQuery(this.filters, { limit: EVERYTHING }));
  }

  private async exportRuns(filtered: boolean): Promise<void> {
    try {
      let blob: Blob;
      if (filtered && activeHistoryFilters(this.filters) > 0) {
        const runs = await this.matching();
        if (runs.length === 0) {
          toast({
            message: 'No runs match the filters, so there is nothing to export.',
            variant: 'warning',
          });
          return;
        }
        blob = await this.core.history.exportJson(runs.map((run) => run.id));
      } else {
        if ((await this.core.history.count()) === 0) {
          toast({ message: 'There are no runs to export yet.', variant: 'warning' });
          return;
        }
        blob = await this.core.history.exportJson();
      }
      downloadBlob(blob, filtered ? 'ortoolbox-history-filtered.json' : 'ortoolbox-history.json');
    } catch (error) {
      void presentError(error, { retry: () => void this.exportRuns(filtered) });
    }
  }

  private async deleteFiltered(): Promise<void> {
    let matches: RunRecord[];
    try {
      matches = await this.matching();
    } catch (error) {
      void presentError(error);
      return;
    }
    // A run in progress belongs to a live page: it is never deleted (and so never brought back by Undo).
    const { deletable: runs, running } = splitDeletable(matches);
    if (runs.length === 0) {
      toast({
        message:
          running.length > 0
            ? 'The filters match only runs in progress, and those cannot be deleted yet.'
            : 'No runs match the filters, so there is nothing to delete.',
        variant: 'warning',
      });
      return;
    }
    const all = activeHistoryFilters(this.filters) === 0 && running.length === 0;
    const kept =
      running.length > 0
        ? ` ${plural(running.length, 'run')} in progress ${running.length === 1 ? 'is' : 'are'} kept.`
        : '';
    const ok = await typedConfirm({
      title: all ? 'Delete all history?' : `Delete ${plural(runs.length, 'run')}?`,
      message: h(
        'p',
        null,
        all
          ? `All ${plural(runs.length, 'run')} will be removed from your history`
          : `The ${plural(runs.length, 'run')} matching the current filters will be removed from your history`,
        `. Starred runs are included and spending stats are not affected.${kept} Export first if you want a copy; you can also undo right after.`,
      ),
      phrase: 'delete',
      confirmLabel: all ? 'Delete everything' : `Delete ${plural(runs.length, 'run')}`,
      testId: 'delete-filtered-dialog',
    });
    if (!ok) return;
    this.drawer.hide();
    await this.deleteRuns(runs);
  }
}
