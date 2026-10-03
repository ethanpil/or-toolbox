/**
 * Stats: a dashboard computed locally from the daily spend ledger (`stats.rows`) for a date range (7, 30, 90
 * days, this month, or custom), plus this month's budget and the key balances (which do not depend on the range).
 *
 * - KPI tiles: spend (the one hero figure), requests, runs, error rate, average latency, free vs paid share.
 * - Spend and requests per day, stacked by tool or by model (top seven, the rest folded into "Other"), and
 *   tokens in and out per model: Chart.js, loaded by `import()` only when there is something to draw
 *   (stats-charts.ts), themed from CSS variables. Each chart has a legend that toggles series, a text
 *   alternative and a table view with the same numbers.
 * - Breakdown tables by tool, model (with tokens, latency and error rate) and key.
 * - Budget burn-down for the month, free requests today, and each key's balance and spend.
 */
import { userMessage } from '../core/errors';
import { DAY_MS, debounce, MAX_TIMEOUT_MS, utcDay } from '../core/util';
import { url } from '../core/paths';
import type { CoreServices, KeyInfo, KeyStatus, StatsRow } from '../core/types';
import { findTool } from '../tools/registry';
import { dataTable } from '../ui/components/data-table';
import { emptyState } from '../ui/components/empty-state';
import { accountFreeDaily, keyBalanceView } from '../ui/components/key-balance';
import { keyDot } from '../ui/components/key-picker';
import { type Child, h, replace } from '../ui/dom';
import { announce } from '../ui/feedback/announce';
import { formatCount, formatDate, formatInt, formatMs, formatUsd, plural } from '../ui/format';
import { icon } from '../ui/icon';
import { uid } from '../ui/id';
import { saveSettings } from '../ui/settings-actions';
import { mountPage } from '../ui/shell/index';
import { settingsUrl } from '../ui/shell/links';
import type * as StatsCharts from './stats-charts';
import {
  ALL_TIME,
  averageLatency,
  budgetPace,
  change,
  daysOf,
  type DateRange,
  errorRate,
  formatChange,
  formatPercent,
  freeShare,
  type Group,
  groupBy,
  markEstimate,
  OTHER,
  parseCustomRange,
  preferredOrder,
  presetRange,
  previousRange,
  pruneHidden,
  RANGE_PRESETS,
  type RangePreset,
  rangeDays,
  rangeLabel,
  resolveRange,
  rowsIn,
  type Series,
  type SeriesDimension,
  seriesSummary,
  seriesTable,
  shortDay,
  timeSeries,
  tokensByModel,
  totalsOf,
  type Totals,
} from './stats-logic';

const RANGE_KEY = 'stats.range';
type ChartsModule = typeof StatsCharts;
type BarChart = StatsCharts.BarChart;
type BarChartInput = StatsCharts.BarChartInput;
let chartsModule: Promise<ChartsModule> | null = null;
/** The Chart.js chunk, fetched on first use; a failed fetch is forgotten so the next call retries. */
function loadCharts(): Promise<ChartsModule> {
  const loading = (chartsModule ??= import('./stats-charts'));
  loading.catch(() => {
    chartsModule = null;
  });
  return loading;
}

mountPage(
  {
    title: 'Stats',
    icon: 'bar-chart',
    lead: 'Spend, requests and tokens, computed from this browser’s history. Nothing leaves your device.',
    nav: 'stats',
  },
  ({ core, main }) => {
    new StatsPage(core, main).start();
  },
);

/** A hero figure that includes estimates: a small, quiet ≈ before the number (the text still reads "≈ $0.60"). */
const approximately = (text: string, estimatedUsd: number): Child =>
  estimatedUsd > 0
    ? [h('span', { class: 'or-kpi-approx', title: 'Includes estimated costs' }, '≈'), ' ', text]
    : text;

// --- chart card -----------------------------------------------------------------------------------------------

interface LegendEntry {
  id: string;
  label: string;
  slot: number | null;
}

interface CardData {
  input: BarChartInput;
  legend: LegendEntry[];
  table: { head: string[]; body: string[][] };
  summary: string;
}

/**
 * One chart with its legend, text alternative and table twin. The chart object is created the first time there
 * is data and the chart view is showing; after that it is updated in place.
 */
class ChartCard {
  readonly element: HTMLElement;
  private chart: BarChart | null = null;
  private data: CardData | null = null;
  private tableView = false;
  private creating = false;
  private hiddenSeries = new Set<string>();

  private readonly legend = h('ul', { class: 'or-legend mb-3', 'aria-label': 'Legend' });
  private readonly canvas: HTMLCanvasElement;
  private readonly frame: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly tableHost = h('div', { hidden: true });
  private readonly toggle: HTMLButtonElement;
  private readonly note = h('p', { class: 'small text-body-secondary mt-2 mb-0', hidden: true });
  private readonly card: HTMLElement;

  private readonly options: {
    testId: string;
    title: string;
    subtitle?: string;
    emptyText: string;
    tall?: boolean;
  };

  constructor(options: {
    testId: string;
    title: string;
    subtitle?: string;
    emptyText: string;
    tall?: boolean;
  }) {
    this.options = options;
    const titleId = uid('chart-title');
    this.canvas = h(
      'canvas',
      { role: 'img', 'aria-label': options.title, 'data-testid': `${options.testId}-canvas` },
      'Your browser cannot draw this chart. The table view has the same numbers.',
    );
    this.frame = h(
      'div',
      { class: ['or-chart-frame', options.tall && 'or-chart-frame-tall'] },
      this.canvas,
    );
    this.empty = h(
      'p',
      { class: 'text-body-secondary py-4 text-center mb-0', hidden: true },
      options.emptyText,
    );
    this.toggle = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2',
        'aria-pressed': 'false',
        'data-testid': `${options.testId}-table-toggle`,
        onclick: () => this.setTableView(!this.tableView),
      },
      icon('table'),
      'Table view',
    );
    this.card = h(
      'section',
      {
        class: 'card shadow-sm h-100 or-chart-card',
        'aria-labelledby': titleId,
        'data-testid': options.testId,
      },
      h(
        'div',
        { class: 'card-body d-flex flex-column' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-start gap-2 mb-2' },
          h(
            'div',
            { class: 'me-auto' },
            h('h3', { id: titleId, class: 'h6 mb-0' }, options.title),
            options.subtitle && h('div', { class: 'small text-body-secondary' }, options.subtitle),
          ),
          this.toggle,
        ),
        this.legend,
        this.frame,
        this.tableHost,
        this.empty,
        this.note,
      ),
    );
    this.element = h('div', { class: 'col-12 col-xl-6' }, this.card);
  }

  /** Dims the chart while new numbers load; the previous picture stays, so nothing jumps. */
  loading(on: boolean): void {
    this.card.dataset.loading = String(on);
  }

  show(data: CardData | null): void {
    this.data = data;
    // A hidden series can only be shown again through the legend, which is not drawn for fewer than two series:
    // forget what is hidden whenever the legend goes away or a hidden series left the chart.
    const kept = pruneHidden(this.hiddenSeries, data?.legend.map((entry) => entry.id) ?? []);
    const pruned = kept.size !== this.hiddenSeries.size;
    this.hiddenSeries = kept;
    this.canvas.dataset.hidden = String(kept.size);
    if (pruned) this.chart?.setHidden([...kept]);
    const hasData = data !== null && data.input.series.length > 0;
    this.empty.hidden = hasData;
    this.toggle.hidden = !hasData;
    if (!hasData || !data) {
      this.frame.hidden = true;
      this.tableHost.hidden = true;
      this.legend.hidden = true;
      this.chart?.destroy();
      this.chart = null;
      this.legend.replaceChildren();
      this.tableHost.replaceChildren();
      delete this.canvas.dataset.rendered;
      return;
    }
    // One series needs no legend: the title already says what is plotted.
    this.legend.hidden = data.legend.length < 2;
    this.canvas.setAttribute('aria-label', data.summary);
    this.renderLegend(data.legend.length < 2 ? [] : data.legend);
    this.renderTable(data);
    this.applyView();
  }

  private renderLegend(entries: LegendEntry[]): void {
    replace(
      this.legend,
      entries.map((entry) => {
        const visible = !this.hiddenSeries.has(entry.id);
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: 'or-legend-item',
              'aria-pressed': String(visible),
              'data-testid': `${this.options.testId}-legend-item`,
              onclick: (event: MouseEvent) => {
                const button = event.currentTarget as HTMLButtonElement;
                const show = this.hiddenSeries.has(entry.id);
                if (show) this.hiddenSeries.delete(entry.id);
                else this.hiddenSeries.add(entry.id);
                button.setAttribute('aria-pressed', String(show));
                this.canvas.dataset.hidden = String(this.hiddenSeries.size);
                this.chart?.setVisible(entry.id, show);
              },
            },
            h('span', {
              class: 'or-legend-swatch',
              'aria-hidden': 'true',
              ...(entry.slot === null ? {} : { 'data-slot': String(entry.slot + 1) }),
            }),
            entry.label,
          ),
        );
      }),
    );
  }

  private renderTable(data: CardData): void {
    this.tableHost.replaceChildren(
      dataTable({
        scrollerLabel: `${this.options.title}, table view`,
        scrollerClass: 'or-data-table',
        caption: `${this.options.title}, one row per day with data`,
        class: 'table table-sm mb-0',
        testId: `${this.options.testId}-table`,
        head: data.table.head,
        numericFrom: 1,
        rows: data.table.body,
      }),
    );
  }

  private setTableView(on: boolean): void {
    this.tableView = on;
    this.toggle.setAttribute('aria-pressed', String(on));
    this.applyView();
    announce(on ? 'Table view.' : 'Chart view.');
  }

  private applyView(): void {
    const data = this.data;
    if (!data) return;
    this.frame.hidden = this.tableView;
    this.tableHost.hidden = !this.tableView;
    if (!this.tableView) void this.drawChart(data);
  }

  private async drawChart(data: CardData): Promise<void> {
    if (this.chart) {
      this.chart.update(data.input);
      this.canvas.dataset.rendered = 'true';
      this.canvas.dataset.series = String(data.input.series.length);
      return;
    }
    if (this.creating) return;
    this.creating = true;
    try {
      const { createBarChart } = await loadCharts();
      // The page may have moved on (new data, table view, empty) while the chunk loaded.
      const latest = this.data;
      if (!latest || this.tableView || this.chart) return;
      this.chart = createBarChart(this.canvas, latest.input);
      this.chart.setHidden([...this.hiddenSeries]);
      this.canvas.dataset.rendered = 'true';
      this.canvas.dataset.series = String(latest.input.series.length);
      this.note.hidden = true;
    } catch {
      // Offline with the chart chunk never fetched: the table has the same numbers.
      this.note.hidden = false;
      this.note.textContent = 'The chart could not be loaded, so the table view is shown instead.';
      this.setTableView(true);
    } finally {
      this.creating = false;
    }
  }
}

// --- the page ---------------------------------------------------------------------------------------------------

class StatsPage {
  private preset: RangePreset = '30d';
  /** What the page shows now; a relative preset is resolved again on every load (see `resolveRange`). */
  private range: DateRange = presetRange('30d');
  /** The range of the Custom preset, kept apart so a reload cannot turn it into the last preset's days. */
  private customRange: DateRange = presetRange('30d');
  /** The whole ledger, read once per load: the range, the previous range, the month and today come from it. */
  private ledgerReady = false;
  private loadedDay = '';
  private rolloverTimer: ReturnType<typeof setTimeout> | undefined;
  private rows: StatsRow[] = [];
  private previousRows: StatsRow[] = [];
  private allRows: StatsRow[] = [];
  private dimension: SeriesDimension = 'tool';
  private generation = 0;
  private readonly reloadSoon = debounce(() => void this.reload(), 250);
  private budgetGeneration = 0;

  private readonly presetButtons = new Map<RangePreset, HTMLButtonElement>();
  private readonly rangeLabelNode = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'stats-range-label',
  });
  private readonly customForm: HTMLFormElement;
  private readonly fromInput = h('input', {
    id: uid('stats-from'),
    type: 'date',
    class: 'form-control',
    'data-testid': 'stats-from',
  });
  private readonly toInput = h('input', {
    id: uid('stats-to'),
    type: 'date',
    class: 'form-control',
    'data-testid': 'stats-to',
  });
  private readonly customError = h('div', {
    class: 'invalid-feedback d-block m-0',
    hidden: true,
    role: 'alert',
    'data-testid': 'stats-range-error',
  });

  private readonly dimensionButtons = new Map<SeriesDimension, HTMLButtonElement>();
  private readonly kpis = h('div', { class: 'row g-3 mb-2', 'data-testid': 'stats-kpis' });
  private readonly footnote = h(
    'p',
    { class: 'small text-body-secondary mb-4' },
    'Runs and requests come from the daily spend ledger kept in this browser; days are UTC, and free requests are those to :free models. A figure marked ≈ includes estimates: a cost worked out from catalog prices because OpenRouter reported none, or the amount reserved for a run whose cost is unknown.',
  );
  private readonly dashboard = h('div', { hidden: true, 'data-testid': 'stats-dashboard' });
  private readonly emptyAll = h('div', { 'data-testid': 'stats-empty-slot' });
  private readonly budget = h('section', {
    class: 'mb-4',
    'aria-labelledby': 'stats-budget-title',
    'data-testid': 'stats-budget',
  });

  private readonly spendCard = new ChartCard({
    testId: 'chart-spend',
    title: 'Spend per day',
    subtitle: 'US dollars',
    emptyText: 'No spend in this period.',
  });
  private readonly requestsCard = new ChartCard({
    testId: 'chart-requests',
    title: 'Requests per day',
    subtitle: 'Calls to OpenRouter',
    emptyText: 'No requests in this period.',
  });
  private readonly tokensCard = new ChartCard({
    testId: 'chart-tokens',
    title: 'Tokens per model',
    subtitle: 'Input and output of the 8 busiest models',
    emptyText: 'No tokens were used in this period.',
    tall: true,
  });
  private readonly breakdowns = h('div', { 'data-testid': 'stats-breakdowns' });
  private readonly toolTableHost = h('div', { class: 'col-12 col-xl-6' });

  private readonly core: CoreServices;
  private readonly main: HTMLElement;

  constructor(core: CoreServices, main: HTMLElement) {
    this.core = core;
    this.main = main;
    this.customForm = h(
      'form',
      {
        class: 'or-range-custom row g-2 align-items-end mb-3',
        hidden: true,
        noValidate: true,
        'data-testid': 'stats-custom',
        onsubmit: (event: Event) => {
          event.preventDefault();
          this.applyCustom();
        },
      },
      h(
        'div',
        { class: 'col-6' },
        h('label', { class: 'form-label small mb-1', htmlFor: this.fromInput.id }, 'From (UTC)'),
        this.fromInput,
      ),
      h(
        'div',
        { class: 'col-6' },
        h('label', { class: 'form-label small mb-1', htmlFor: this.toInput.id }, 'To (UTC)'),
        this.toInput,
      ),
      h(
        'div',
        { class: 'col-12 d-flex align-items-center gap-2' },
        h(
          'button',
          { type: 'submit', class: 'btn btn-primary btn-sm', 'data-testid': 'stats-apply' },
          'Apply',
        ),
        this.customError,
      ),
    );
  }

  start(): void {
    const saved = this.core.settings.get().ui[RANGE_KEY];
    const preset = RANGE_PRESETS.find((entry) => entry.id === saved);
    if (preset) {
      this.preset = preset.id;
      this.range = resolveRange(preset.id, this.customRange);
    }
    this.fromInput.value = this.range.from;
    this.toInput.value = this.range.to;

    this.main.append(this.rangeBar(), this.customForm, this.emptyAll, this.dashboard, this.budget);
    this.buildDashboard();
    this.syncRangeControls();
    this.emptyAll.replaceChildren(this.skeleton());
    this.renderBudget();
    void this.reload();

    this.core.stats.subscribe(() => this.reloadSoon());
    // A page left open (or a tab brought back) on a new UTC day shows the new day's ranges.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && utcDay() !== this.loadedDay) void this.reload();
    });
    this.core.keys.subscribe(() => this.renderBudget());
    this.core.settings.subscribe((next, prev) => {
      if (JSON.stringify(next.budgets) !== JSON.stringify(prev.budgets)) this.renderBudget();
    });
  }

  private skeleton(): HTMLElement {
    return h(
      'div',
      { class: 'row g-3 placeholder-glow mb-4', 'aria-hidden': 'true' },
      [0, 1, 2].map(() =>
        h(
          'div',
          { class: 'col-12 col-md-4' },
          h(
            'div',
            { class: 'card shadow-sm' },
            h(
              'div',
              { class: 'card-body' },
              h('span', { class: 'placeholder col-5 d-block mb-3' }),
              h('span', { class: 'placeholder col-8 placeholder-lg d-block' }),
            ),
          ),
        ),
      ),
    );
  }

  // --- range ---------------------------------------------------------------------------------------------

  private rangeBar(): HTMLElement {
    const button = (id: RangePreset, label: string): HTMLButtonElement => {
      const node = h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline-secondary',
          'aria-pressed': 'false',
          'data-testid': `stats-range-${id}`,
          onclick: () => this.choose(id),
        },
        label,
      );
      this.presetButtons.set(id, node);
      return node;
    };
    return h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-3 mb-3' },
      h(
        'div',
        { class: 'btn-group', role: 'group', 'aria-label': 'Date range' },
        RANGE_PRESETS.map((entry) => button(entry.id, entry.label)),
        button('custom', 'Custom'),
      ),
      this.rangeLabelNode,
    );
  }

  private choose(preset: RangePreset): void {
    if (preset === 'custom') {
      this.preset = 'custom';
      this.customRange = this.range;
      this.syncRangeControls();
      this.fromInput.focus();
      return;
    }
    this.preset = preset;
    this.range = resolveRange(preset, this.customRange);
    this.customError.hidden = true;
    this.fromInput.value = this.range.from;
    this.toInput.value = this.range.to;
    // Not remembered when storage is full; the range still applies.
    saveSettings(
      this.core,
      (draft) => {
        draft.ui[RANGE_KEY] = preset;
      },
      { onError: () => undefined },
    );
    this.syncRangeControls();
    if (this.ledgerReady) this.showRange(true);
    else void this.reload(true);
  }

  private applyCustom(): void {
    const result = parseCustomRange(this.fromInput.value, this.toInput.value);
    if ('error' in result) {
      this.customError.textContent = result.error;
      this.customError.hidden = false;
      return;
    }
    this.customError.hidden = true;
    this.customRange = result.range;
    this.range = result.range;
    this.preset = 'custom';
    this.syncRangeControls();
    if (this.ledgerReady) this.showRange(true);
    else void this.reload(true);
  }

  private syncRangeControls(): void {
    for (const [id, button] of this.presetButtons) {
      const on = id === this.preset;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
    this.customForm.hidden = this.preset !== 'custom';
    this.rangeLabelNode.textContent = `${rangeLabel(this.range)} · ${plural(rangeDays(this.range), 'day')}, UTC`;
  }

  // --- data ----------------------------------------------------------------------------------------------

  /** Reloads at the next UTC midnight (a little after), so the relative ranges and "this month" roll over. */
  private scheduleRollover(): void {
    clearTimeout(this.rolloverTimer);
    const untilMidnight = DAY_MS - (Date.now() % DAY_MS) + 1000;
    this.rolloverTimer = setTimeout(
      () => void this.reload(),
      Math.min(untilMidnight, MAX_TIMEOUT_MS),
    );
  }

  /**
   * Derives everything on screen from the ledger in memory: the range (resolved again from the clock for a
   * relative preset), the range before it, this month, today and each key's spend. Changing the range needs no
   * new read; only a change of the ledger (or the clock rolling over) reads it again.
   */
  private showRange(announceResult: boolean): void {
    this.range = resolveRange(this.preset, this.customRange);
    this.rows = rowsIn(this.allRows, this.range);
    this.previousRows = rowsIn(this.allRows, previousRange(this.range));
    if (this.preset !== 'custom') {
      this.fromInput.value = this.range.from;
      this.toInput.value = this.range.to;
    }
    this.syncRangeControls();
    this.render();
    this.renderBudget();
    this.scheduleRollover();
    if (announceResult) {
      announce(
        `Showing ${rangeLabel(this.range)}: ${formatUsd(totalsOf(this.rows).costUsd)} spent.`,
      );
    }
  }

  /**
   * Reads the whole ledger once and derives everything from it in memory: the range (recomputed from the clock
   * for a relative preset, so the page rolls over at UTC midnight and at the end of the month), the range before
   * it, this month, today and each key's spend.
   */
  private async reload(announceResult = false): Promise<void> {
    const mine = ++this.generation;
    for (const card of [this.spendCard, this.requestsCard, this.tokensCard]) card.loading(true);
    try {
      const allRows = await this.core.stats.rows(ALL_TIME);
      if (mine !== this.generation) return;
      this.allRows = allRows;
      this.ledgerReady = true;
      this.loadedDay = utcDay();
      this.showRange(announceResult);
    } catch (error) {
      if (mine !== this.generation) return;
      this.dashboard.hidden = true;
      this.emptyAll.replaceChildren(
        h(
          'div',
          { class: 'alert alert-danger', role: 'alert', 'data-testid': 'stats-error' },
          h('div', { class: 'fw-semibold' }, 'The stats could not be loaded.'),
          userMessage(error),
        ),
      );
    } finally {
      if (mine === this.generation) {
        for (const card of [this.spendCard, this.requestsCard, this.tokensCard])
          card.loading(false);
      }
    }
  }

  // --- layout --------------------------------------------------------------------------------------------

  private buildDashboard(): void {
    const segment = (dimension: SeriesDimension, label: string): HTMLButtonElement => {
      const button = h(
        'button',
        {
          type: 'button',
          class: ['btn btn-outline-secondary btn-sm', this.dimension === dimension && 'active'],
          'aria-pressed': String(this.dimension === dimension),
          'data-testid': `stats-stack-${dimension}`,
          onclick: () => {
            this.dimension = dimension;
            for (const [id, node] of this.dimensionButtons) {
              node.classList.toggle('active', id === dimension);
              node.setAttribute('aria-pressed', String(id === dimension));
            }
            this.renderTimeCharts();
          },
        },
        label,
      );
      this.dimensionButtons.set(dimension, button);
      return button;
    };

    this.dashboard.append(
      this.kpis,
      this.footnote,
      h(
        'section',
        { class: 'mb-4', 'aria-labelledby': 'stats-time-title' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2 mb-3' },
          h('h2', { id: 'stats-time-title', class: 'or-section-title mb-0 me-auto' }, 'Over time'),
          h(
            'div',
            { class: 'd-flex align-items-center gap-2' },
            h('span', { class: 'small text-body-secondary' }, 'Stacked by'),
            h(
              'div',
              { class: 'btn-group', role: 'group', 'aria-label': 'Stack by' },
              segment('tool', 'Tool'),
              segment('model', 'Model'),
            ),
          ),
        ),
        h('div', { class: 'row g-3' }, this.spendCard.element, this.requestsCard.element),
      ),
      h(
        'section',
        { class: 'mb-4', 'aria-labelledby': 'stats-breakdown-title' },
        h('h2', { id: 'stats-breakdown-title', class: 'or-section-title mb-3' }, 'Breakdowns'),
        h('div', { class: 'row g-3 mb-3' }, this.tokensCard.element, this.toolTableHost),
        this.breakdowns,
      ),
    );
  }

  private render(): void {
    const hasAny = this.allRows.length > 0;
    this.dashboard.hidden = !hasAny;
    if (!hasAny) {
      this.emptyAll.replaceChildren(
        h(
          'div',
          { class: 'card shadow-sm mb-4', 'data-testid': 'stats-empty' },
          h(
            'div',
            { class: 'card-body py-4' },
            h(
              'div',
              { class: 'or-ghost-chart', 'aria-hidden': 'true' },
              [30, 55, 40, 75, 60, 90, 70, 45, 65, 85].map((height) =>
                h('span', { style: { height: `${height}%` } }),
              ),
            ),
            emptyState({
              icon: 'bar-chart',
              title: 'No numbers yet',
              text: 'Run any tool and its spend, requests, tokens and speed show up here. Everything is computed on this device from your own runs.',
              action: h(
                'a',
                { class: 'btn btn-primary btn-sm', href: url() },
                icon('house', 'me-2'),
                'Pick a tool',
              ),
              compact: true,
              testId: 'stats-empty-state',
            }),
          ),
        ),
      );
      return;
    }
    this.emptyAll.replaceChildren();
    this.renderKpis();
    this.renderTimeCharts();
    this.renderTokens();
    this.renderBreakdowns();
  }

  // --- KPIs ----------------------------------------------------------------------------------------------

  private tile(options: {
    id: string;
    label: string;
    value: Child;
    note?: Child;
    columns: string;
    hero?: boolean;
    extra?: Child;
  }): HTMLElement {
    return h(
      'div',
      { class: options.columns },
      h(
        'div',
        {
          class: ['card shadow-sm or-kpi', options.hero && 'or-kpi-hero'],
          'data-testid': `kpi-${options.id}`,
        },
        h(
          'div',
          { class: 'card-body' },
          h('div', { class: 'or-kpi-label mb-1' }, options.label),
          h(
            'div',
            { class: 'or-kpi-value', 'data-testid': `kpi-${options.id}-value` },
            options.value,
          ),
          options.note && h('div', { class: 'or-kpi-note mt-1' }, options.note),
          options.extra,
        ),
      ),
    );
  }

  private deltaNote(current: number, previous: number): Child {
    const delta = change(current, previous);
    if (delta === null) return null;
    const rounded = Math.round(delta * 100);
    return [
      rounded === 0 ? icon('dash') : icon(rounded > 0 ? 'arrow-up-right' : 'arrow-down-right'),
      ` ${formatChange(delta)} vs the ${plural(rangeDays(this.range), 'day')} before`,
    ];
  }

  private renderKpis(): void {
    const totals = totalsOf(this.rows);
    const before = totalsOf(this.previousRows);
    const rate = errorRate(totals);
    const latency = averageLatency(totals);
    const share = freeShare(totals);
    const small = 'col-6 col-md-4 col-xl';

    this.kpis.replaceChildren(
      this.tile({
        id: 'spend',
        label: 'Spend',
        value: approximately(formatUsd(totals.costUsd), totals.estimatedUsd),
        note: [
          this.deltaNote(totals.costUsd, before.costUsd) ?? 'in this period',
          totals.estimatedUsd > 0
            ? h(
                'div',
                { 'data-testid': 'kpi-spend-estimated' },
                `Includes ${formatUsd(totals.estimatedUsd)} estimated`,
              )
            : null,
        ],
        columns: 'col-12 col-xl-3',
        hero: true,
      }),
      this.tile({
        id: 'requests',
        label: 'Requests',
        value: formatInt(totals.requests),
        note: this.deltaNote(totals.requests, before.requests),
        columns: small,
      }),
      this.tile({
        id: 'runs',
        label: 'Runs',
        value: formatInt(totals.runs),
        note: this.deltaNote(totals.runs, before.runs),
        columns: small,
      }),
      this.tile({
        id: 'errors',
        label: 'Error rate',
        value: rate === null ? '—' : formatPercent(rate),
        note:
          rate === null ? 'No runs' : `${totals.errors} of ${plural(totals.runs, 'run')} failed`,
        columns: small,
      }),
      this.tile({
        id: 'latency',
        label: 'Average latency',
        value: latency === null ? '—' : formatMs(latency),
        note: 'per request',
        columns: small,
      }),
      this.tile({
        id: 'free',
        label: 'Free vs paid',
        value: share === null ? '—' : `${formatPercent(share)} free`,
        note: `${formatInt(totals.freeRequests)} free · ${formatInt(totals.paidRequests)} paid requests`,
        columns: small,
        extra:
          share === null
            ? null
            : h(
                'div',
                {
                  class: 'or-stats-meter-split mt-2',
                  role: 'img',
                  'aria-label': `${formatPercent(share)} of requests were free, ${formatPercent(1 - share)} paid`,
                  'data-testid': 'kpi-free-split',
                },
                totals.paidRequests > 0
                  ? h('span', {
                      class: 'or-stats-meter-paid',
                      style: { flex: `${totals.paidRequests} 1 0` },
                    })
                  : null,
                totals.freeRequests > 0
                  ? h('span', {
                      class: 'or-stats-meter-free',
                      style: { flex: `${totals.freeRequests} 1 0` },
                    })
                  : null,
              ),
      }),
    );
  }

  // --- charts --------------------------------------------------------------------------------------------

  private entityLabel(id: string): string {
    if (id === OTHER) return 'Other';
    if (this.dimension === 'tool') return findTool(id)?.name ?? id;
    return id;
  }

  private timeCard(
    metric: 'costUsd' | 'requests',
    title: string,
    format: (value: number) => string,
    integers: boolean,
  ): CardData {
    const days = daysOf(this.range);
    const preferred = preferredOrder(this.allRows, this.dimension);
    const series: Series[] = timeSeries(this.rows, days, this.dimension, metric, preferred);
    const label = (id: string): string => this.entityLabel(id);
    return {
      input: {
        labels: days.map(shortDay),
        titles: days.map((day) => formatDate(day)),
        series: series.map((s) => ({
          id: s.id,
          label: label(s.id),
          slot: s.slot,
          values: s.values,
          ...(s.estimated ? { estimated: s.estimated } : {}),
        })),
        format,
        integers,
      },
      legend: series.map((s) => ({ id: s.id, label: label(s.id), slot: s.slot })),
      table: seriesTable(days, series, label, format),
      summary: seriesSummary(
        `${title} by ${this.dimension}, ${rangeLabel(this.range)}`,
        days,
        series,
        label,
        format,
      ),
    };
  }

  private renderTimeCharts(): void {
    this.spendCard.show(this.timeCard('costUsd', 'Spend per day', formatUsd, false));
    this.requestsCard.show(this.timeCard('requests', 'Requests per day', formatCount, true));
  }

  private renderTokens(): void {
    const bars = tokensByModel(this.rows);
    if (bars.length === 0) {
      this.tokensCard.show(null);
      return;
    }
    const sum = (pick: (bar: (typeof bars)[number]) => number): number =>
      bars.reduce((total, bar) => total + pick(bar), 0);
    const series: Series[] = [
      {
        id: 'in',
        slot: 0,
        values: bars.map((bar) => bar.promptTokens),
        total: sum((bar) => bar.promptTokens),
      },
      {
        id: 'out',
        slot: 1,
        values: bars.map((bar) => bar.completionTokens),
        total: sum((bar) => bar.completionTokens),
      },
    ];
    const label = (id: string): string => (id === 'in' ? 'Tokens in' : 'Tokens out');
    const busiest = bars[0]!;
    this.tokensCard.show({
      input: {
        labels: bars.map((bar) => bar.model),
        series: series.map((s) => ({
          id: s.id,
          label: label(s.id),
          slot: s.slot,
          values: s.values,
        })),
        format: formatCount,
        integers: true,
        horizontal: true,
      },
      legend: series.map((s) => ({ id: s.id, label: label(s.id), slot: s.slot })),
      table: {
        head: ['Model', 'Tokens in', 'Tokens out', 'Total'],
        body: bars.map((bar) => [
          bar.model,
          formatInt(bar.promptTokens),
          formatInt(bar.completionTokens),
          formatInt(bar.promptTokens + bar.completionTokens),
        ]),
      },
      summary: `Tokens in and out for ${plural(bars.length, 'model')}. Busiest: ${busiest.model} with ${formatCount(busiest.promptTokens + busiest.completionTokens)} tokens. The table view lists every value.`,
    });
  }

  // --- breakdown tables ----------------------------------------------------------------------------------

  private breakdownTable(options: {
    testId: string;
    title: string;
    first: string;
    groups: Group[];
    label: (group: Group) => Child;
    columns: { label: string; cell: (group: Group) => Child }[];
  }): HTMLElement {
    return h(
      'section',
      { class: 'card shadow-sm h-100', 'aria-label': options.title, 'data-testid': options.testId },
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'h6 mb-3' }, options.title),
        options.groups.length === 0
          ? h('p', { class: 'text-body-secondary mb-0' }, 'Nothing in this period.')
          : dataTable({
              scrollerLabel: `${options.title}, table`,
              class: 'table table-sm align-middle mb-0 or-breakdown-table',
              head: [options.first, ...options.columns.map((column) => column.label)],
              numericFrom: 1,
              rowTestId: `${options.testId}-row`,
              rowHeaderClass: 'fw-normal text-break',
              cellClass: 'text-nowrap',
              rows: options.groups.map((group) => [
                options.label(group),
                ...options.columns.map((column) => column.cell(group)),
              ]),
            }),
      ),
    );
  }

  /** The spend column: the amount and its share, with a thin share bar under it. */
  private spendCell(group: Group, total: number): Child {
    const share = total > 0 ? group.costUsd / total : 0;
    return h(
      'div',
      { class: 'd-flex flex-column align-items-end gap-1' },
      h(
        'span',
        group.estimatedUsd > 0
          ? {
              title: `Includes ${formatUsd(group.estimatedUsd)} estimated from catalog prices or reserved for runs of unknown cost.`,
              'data-estimated': 'true',
            }
          : null,
        markEstimate(formatUsd(group.costUsd), group.estimatedUsd),
        total > 0
          ? h('span', { class: 'text-body-secondary' }, ` · ${formatPercent(share)}`)
          : null,
      ),
      h(
        'span',
        { class: 'or-share', 'aria-hidden': 'true' },
        h('span', { style: { width: `${Math.round(share * 100)}%` } }),
      ),
    );
  }

  private errorCell(group: Group): Child {
    const rate = errorRate(group);
    if (rate === null) return '—';
    const high = rate >= 0.1;
    return h(
      'span',
      { class: high ? 'text-danger-emphasis' : '', 'data-high': String(high) },
      high ? icon('exclamation-triangle-fill', 'me-1') : null,
      formatPercent(rate),
      high ? h('span', { class: 'visually-hidden' }, ' (high)') : null,
    );
  }

  private renderBreakdowns(): void {
    const total = totalsOf(this.rows);
    const requests = (group: Group): string => formatInt(group.requests);

    this.toolTableHost.replaceChildren(
      this.breakdownTable({
        testId: 'breakdown-tools',
        title: 'By tool',
        first: 'Tool',
        groups: groupBy(this.rows, 'tool'),
        label: (group) => {
          const tool = findTool(group.id);
          // A tool that no longer exists keeps its id.
          return tool ? [icon(tool.icon, 'me-2 text-body-secondary'), tool.name] : group.id;
        },
        columns: [
          { label: 'Runs', cell: (group) => formatInt(group.runs) },
          { label: 'Requests', cell: requests },
          { label: 'Spend', cell: (group) => this.spendCell(group, total.costUsd) },
        ],
      }),
    );

    const modelTable = this.breakdownTable({
      testId: 'breakdown-models',
      title: 'By model',
      first: 'Model',
      groups: groupBy(this.rows, 'model'),
      label: (group) => group.id,
      columns: [
        { label: 'Runs', cell: (group) => formatInt(group.runs) },
        { label: 'Requests', cell: requests },
        { label: 'Spend', cell: (group) => this.spendCell(group, total.costUsd) },
        { label: 'Tokens in', cell: (group) => formatCount(group.promptTokens) },
        { label: 'Tokens out', cell: (group) => formatCount(group.completionTokens) },
        {
          label: 'Avg latency',
          cell: (group) => {
            const latency = averageLatency(group);
            return latency === null ? '—' : formatMs(latency);
          },
        },
        { label: 'Error rate', cell: (group) => this.errorCell(group) },
      ],
    });

    const keyTable = this.breakdownTable({
      testId: 'breakdown-keys',
      title: 'By key',
      first: 'Key',
      groups: groupBy(this.rows, 'key'),
      label: (group) => {
        const key = this.core.keys.get(group.id);
        return key
          ? h('span', { class: 'd-inline-flex align-items-center gap-2' }, keyDot(key), key.name)
          : h('span', { class: 'text-body-secondary' }, 'Removed key');
      },
      columns: [
        { label: 'Requests', cell: requests },
        { label: 'Spend', cell: (group) => this.spendCell(group, total.costUsd) },
      ],
    });

    this.breakdowns.replaceChildren(
      h('div', { class: 'mb-3' }, modelTable),
      h('div', { class: 'row g-3' }, h('div', { class: 'col-12 col-xl-6' }, keyTable)),
    );
  }

  // --- budget, free tier, key balances -------------------------------------------------------------------

  private renderBudget(): void {
    const mine = ++this.budgetGeneration;
    const keys = this.core.keys.list();
    const settings = this.core.settings.get();

    const monthCard = h('div', { class: 'col-12 col-lg-6' });
    const freeCard = h('div', { class: 'col-12 col-lg-6' });
    const keysCard = h('div', { class: 'col-12' });
    const placeholder = (): HTMLElement =>
      h(
        'div',
        { class: 'card shadow-sm h-100' },
        h(
          'div',
          { class: 'card-body placeholder-glow', 'aria-hidden': 'true' },
          h('span', { class: 'placeholder col-4 d-block mb-3' }),
          h('span', { class: 'placeholder col-10 d-block' }),
        ),
      );
    monthCard.append(placeholder());
    freeCard.append(placeholder());
    keysCard.append(placeholder());

    this.budget.replaceChildren(
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-baseline gap-2 mb-3' },
        h(
          'h2',
          { id: 'stats-budget-title', class: 'or-section-title mb-0' },
          'Budget and balances',
        ),
        h(
          'span',
          { class: 'small text-body-secondary' },
          'This month and today (UTC). The date range above does not change them.',
        ),
      ),
      h(
        'div',
        { class: 'row g-3', 'data-testid': 'stats-budget-cards' },
        monthCard,
        freeCard,
        keysCard,
      ),
    );
    // Until the ledger is read the cards are placeholders; the load that reads it draws them for real.
    if (!this.ledgerReady) return;

    // The month, today and each key come from the ledger already in memory (no further reads).
    const month = rowsIn(this.allRows, presetRange('month'));
    const today = utcDay();
    const freeToday = totalsOf(rowsIn(this.allRows, { from: today, to: today })).freeRequests;
    const monthByKey = new Map(
      keys.map((key) => [key.id, totalsOf(month.filter((row) => row.keyId === key.id))]),
    );
    monthCard.replaceChildren(this.monthCard(totalsOf(month), settings.budgets));

    keysCard.replaceChildren(this.keysCard(keys, monthByKey, settings.budgets));
    void accountFreeDaily(this.core).then((remote) => {
      if (mine !== this.budgetGeneration) return;
      freeCard.replaceChildren(this.freeCard(freeToday, remote));
    });
  }

  private meter(options: {
    fraction: number;
    label: string;
    valueText: string;
    severity?: 'ok' | 'warning' | 'over';
    pace?: number;
    testId?: string;
  }): HTMLElement {
    const clamped = Math.min(
      1,
      Math.max(0, Number.isFinite(options.fraction) ? options.fraction : 1),
    );
    return h(
      'div',
      {
        class: 'or-stats-meter',
        role: 'meter',
        'aria-label': options.label,
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-valuenow': String(Math.round(clamped * 100)),
        'aria-valuetext': options.valueText,
        'data-testid': options.testId,
      },
      h('div', {
        class: 'or-stats-meter-fill',
        'data-severity': options.severity ?? 'ok',
        style: { width: `${clamped * 100}%` },
      }),
      options.pace === undefined
        ? null
        : h('div', {
            class: 'or-stats-meter-pace',
            title: 'Where an even spender would be today',
            style: { left: `calc(${Math.min(1, options.pace) * 100}% - 1px)` },
          }),
    );
  }

  private monthCard(
    totals: Totals,
    budgets: { mode: string; monthlyUsd: number | null },
  ): HTMLElement {
    const spend = totals.costUsd;
    const limit = budgets.monthlyUsd;
    const mode =
      budgets.mode === 'hard' ? 'Hard stop' : budgets.mode === 'warn' ? 'Warn' : 'Disabled';
    const pace = limit === null ? null : budgetPace(spend, limit);
    return h(
      'section',
      { class: 'card shadow-sm h-100', 'aria-label': 'This month', 'data-testid': 'budget-month' },
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'h6 mb-2' }, 'This month'),
        h(
          'div',
          { class: 'or-kpi-value mb-1', 'data-testid': 'budget-month-spend' },
          markEstimate(formatUsd(spend), totals.estimatedUsd),
        ),
        pace && limit !== null
          ? [
              h(
                'div',
                { class: 'or-kpi-note mb-2', 'data-testid': 'budget-month-limit' },
                `of your ${formatUsd(limit)} monthly budget · ${formatPercent(pace.fraction)} used`,
              ),
              this.meter({
                fraction: pace.fraction,
                label: 'Monthly budget used',
                valueText: `${formatUsd(spend)} of ${formatUsd(limit)}`,
                severity: pace.severity,
                pace: pace.elapsed,
                testId: 'budget-month-meter',
              }),
              h(
                'ul',
                { class: 'list-unstyled small mt-3 mb-0 vstack gap-1' },
                h(
                  'li',
                  null,
                  pace.severity === 'over'
                    ? [
                        icon('exclamation-octagon-fill', 'text-danger-emphasis me-1'),
                        'The budget is used up. ',
                      ]
                    : pace.severity === 'warning'
                      ? [
                          icon('exclamation-triangle-fill', 'text-warning-emphasis me-1'),
                          'Close to the budget. ',
                        ]
                      : null,
                  `${formatUsd(pace.remainingUsd)} left, ${plural(pace.daysLeft, 'day')} to go.`,
                ),
                pace.projectedUsd === null
                  ? null
                  : h(
                      'li',
                      { 'data-testid': 'budget-projection' },
                      `At this pace: about ${formatUsd(pace.projectedUsd)} by month end`,
                      pace.projectedUsd > limit ? ', over the budget.' : '.',
                    ),
              ),
            ]
          : h(
              'div',
              { class: 'or-kpi-note' },
              'No monthly budget is set. ',
              h('a', { href: settingsUrl('budgets') }, 'Set one in Settings'),
              '.',
            ),
        h(
          'div',
          { class: 'small text-body-secondary mt-3' },
          `Budget mode: ${mode}. `,
          budgets.mode === 'disabled' ? 'Limits are not enforced. ' : '',
          h('a', { href: settingsUrl('budgets') }, 'Budget settings'),
        ),
      ),
    );
  }

  private freeCard(today: number, remote: KeyStatus['freeDaily']): HTMLElement {
    return h(
      'section',
      {
        class: 'card shadow-sm h-100',
        'aria-label': 'Free requests today',
        'data-testid': 'budget-free',
      },
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'h6 mb-2' }, 'Free requests today'),
        h('div', { class: 'or-kpi-value mb-1', 'data-testid': 'free-today' }, formatInt(today)),
        h(
          'div',
          { class: 'or-kpi-note mb-2' },
          'requests to :free models from this browser since 00:00 UTC',
        ),
        remote
          ? [
              this.meter({
                fraction: remote.limit > 0 ? remote.used / remote.limit : 0,
                label: 'Free requests used according to OpenRouter',
                valueText: `${remote.used} of ${remote.limit}`,
                severity:
                  remote.remaining <= 0
                    ? 'over'
                    : remote.remaining <= remote.limit * 0.2
                      ? 'warning'
                      : 'ok',
              }),
              h(
                'div',
                { class: 'small mt-2', 'data-testid': 'free-remote' },
                `OpenRouter counts ${remote.used} of ${remote.limit} for your account, ${remote.remaining} left. Its counter can lag, and other devices count too.`,
              ),
            ]
          : h(
              'div',
              { class: 'small text-body-secondary' },
              'Free models allow 20 requests a minute and 50 a day (1,000 once you have bought credits).',
            ),
      ),
    );
  }

  private keysCard(
    keys: KeyInfo[],
    monthByKey: Map<string, Totals>,
    budgets: { perKeyMonthlyUsd: Record<string, number | null> },
  ): HTMLElement {
    if (keys.length === 0) {
      return h(
        'section',
        { class: 'card shadow-sm', 'aria-label': 'Keys' },
        emptyState({
          icon: 'key',
          title: 'No keys yet',
          text: 'Add an OpenRouter key and its balance and monthly spend show up here.',
          action: h(
            'a',
            { class: 'btn btn-primary btn-sm', href: settingsUrl('keys') },
            'Add a key',
          ),
          compact: true,
          testId: 'budget-keys-empty',
        }),
      );
    }
    const monthly = (key: KeyInfo): Child => {
      const totals = monthByKey.get(key.id);
      const spend = totals?.costUsd ?? 0;
      const spendText = markEstimate(formatUsd(spend), totals?.estimatedUsd ?? 0);
      const limit = budgets.perKeyMonthlyUsd[key.id] ?? null;
      if (limit === null) return spendText;
      const pace = budgetPace(spend, limit);
      return h(
        'div',
        { class: 'd-flex flex-column align-items-end gap-1' },
        h(
          'span',
          null,
          spendText,
          h('span', { class: 'text-body-secondary' }, ` of ${formatUsd(limit)}`),
        ),
        h(
          'div',
          { class: 'w-100', style: { minWidth: '6rem' } },
          this.meter({
            fraction: pace.fraction,
            label: `Monthly budget used for ${key.name}`,
            valueText: `${formatUsd(spend)} of ${formatUsd(limit)}`,
            severity: pace.severity,
            pace: pace.elapsed,
          }),
        ),
      );
    };
    const row = (key: KeyInfo): HTMLElement => {
      const balance = keyBalanceView(this.core, key, { compact: true });
      balance.load();
      return h(
        'tr',
        { 'data-testid': 'budget-key-row' },
        h(
          'th',
          { scope: 'row', class: 'fw-normal' },
          h(
            'span',
            { class: 'd-inline-flex align-items-center gap-2' },
            keyDot(key),
            key.name,
            h('span', { class: 'small text-body-secondary' }, key.masked),
          ),
        ),
        h('td', { class: 'text-end text-nowrap' }, balance.element),
        h('td', { class: 'text-end' }, monthly(key)),
      );
    };
    return h(
      'section',
      { class: 'card shadow-sm', 'aria-label': 'Keys', 'data-testid': 'budget-keys' },
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'h6 mb-3' }, 'Keys'),
        dataTable({
          scrollerLabel: 'Keys, table',
          class: 'table table-sm align-middle mb-0',
          head: ['Key', 'Balance at OpenRouter', 'Spent this month here'],
          numericFrom: 1,
          rows: keys.map(row),
        }),
      ),
    );
  }
}
