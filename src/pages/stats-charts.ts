/**
 * The Chart.js half of the Stats page. Loaded with `import()` only when the page has data to draw, and only the
 * pieces a stacked bar chart needs are registered (controller, element, two scales, tooltip), so the chunk stays
 * small. Everything visual comes from CSS variables (`--or-viz-*`, Bootstrap's text and border colours), read
 * again whenever `data-bs-theme` or `data-reduced-motion` changes on <html>, so the charts match light and dark
 * without being rebuilt. The legend, the table twin and the text alternative are plain DOM in stats.ts.
 */
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  type ChartConfiguration,
  LinearScale,
  type ScriptableContext,
  Tooltip,
  type TooltipItem,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);

export interface BarSeries {
  id: string;
  label: string;
  /** 0-based colour slot of the categorical palette, or null for the neutral "Other" grey. */
  slot: number | null;
  values: number[];
}

export interface BarChartInput {
  /** Short category labels (axis ticks). */
  labels: string[];
  /** Full labels for the tooltip heading; defaults to `labels`. */
  titles?: string[];
  series: BarSeries[];
  /** Values in tooltips and on the value axis. */
  format: (value: number) => string;
  /** Whole numbers only on the value axis (request counts). */
  integers?: boolean;
  /** Categories on the vertical axis (tokens per model). */
  horizontal?: boolean;
}

export interface BarChart {
  update(input: BarChartInput): void;
  /** Shows or hides one series (the legend's toggle); the choice survives `update`. */
  setVisible(id: string, visible: boolean): void;
  destroy(): void;
}

interface Theme {
  text: string;
  muted: string;
  grid: string;
  axis: string;
  surface: string;
  border: string;
  slots: string[];
  other: string;
}

const SLOT_COUNT = 7;
const BAR_THICKNESS = 24;
const RADIUS = 4;

const rootStyle = (): CSSStyleDeclaration => getComputedStyle(document.documentElement);

function readTheme(): Theme {
  const style = rootStyle();
  const token = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    text: token('--bs-body-color', '#212529'),
    muted: token('--bs-secondary-color', '#6c757d'),
    grid: token('--bs-border-color-translucent', 'rgba(0, 0, 0, 0.1)'),
    axis: token('--bs-border-color', '#dee2e6'),
    // The charts sit on cards: the gap between touching marks is the card's own surface colour.
    surface: token('--or-surface', token('--bs-body-bg', '#fff')),
    border: token('--bs-border-color', '#dee2e6'),
    slots: Array.from({ length: SLOT_COUNT }, (_, index) =>
      token(`--or-viz-${index + 1}`, '#2a78d6'),
    ),
    other: token('--or-viz-other', '#898781'),
  };
}

const reducedMotion = (): boolean =>
  document.documentElement.hasAttribute('data-reduced-motion') ||
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function colourOf(series: BarSeries, theme: Theme): string {
  return series.slot === null ? theme.other : (theme.slots[series.slot] ?? theme.other);
}

/** `openai/gpt-6-luna` → `gpt-6-luna`, cut at 22 characters: model ids are long and the axis is narrow. */
function shorten(label: string): string {
  const name = label.includes('/') ? label.slice(label.indexOf('/') + 1) : label;
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

export function createBarChart(canvas: HTMLCanvasElement, initial: BarChartInput): BarChart {
  let input = initial;
  let theme = readTheme();
  const hidden = new Set<string>();

  /**
   * Only the end of a stack is rounded (4 px, square at the baseline); the segments in between stay square, and
   * the 1 px surface-coloured border on each side adds up to the 2 px gap between touching segments.
   */
  const radius = (context: ScriptableContext<'bar'>) => {
    const { chart, datasetIndex, dataIndex } = context;
    for (let later = datasetIndex + 1; later < chart.data.datasets.length; later++) {
      if (!chart.isDatasetVisible(later)) continue;
      const value = chart.data.datasets[later]?.data[dataIndex];
      if (typeof value === 'number' && value > 0) return 0;
    }
    return input.horizontal
      ? { topRight: RADIUS, bottomRight: RADIUS, topLeft: 0, bottomLeft: 0 }
      : { topLeft: RADIUS, topRight: RADIUS, bottomLeft: 0, bottomRight: 0 };
  };

  const datasets = () =>
    input.series.map((series) => ({
      label: series.label,
      data: series.values,
      backgroundColor: colourOf(series, theme),
      borderColor: theme.surface,
      borderWidth: 1,
      borderSkipped: false as const,
      borderRadius: radius,
      maxBarThickness: BAR_THICKNESS,
      categoryPercentage: 0.85,
      barPercentage: 0.9,
    }));

  const valueOf = (item: TooltipItem<'bar'>): number =>
    (input.horizontal ? item.parsed.x : item.parsed.y) ?? 0;

  const config: ChartConfiguration<'bar'> = {
    type: 'bar',
    data: { labels: input.labels, datasets: datasets() },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: input.horizontal ? 'y' : 'x',
      animation: reducedMotion() ? false : { duration: 200 },
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 4, right: 4 } },
      plugins: {
        tooltip: {
          enabled: true,
          position: 'nearest',
          backgroundColor: theme.surface,
          borderColor: theme.border,
          borderWidth: 1,
          titleColor: theme.muted,
          bodyColor: theme.text,
          footerColor: theme.muted,
          padding: 10,
          cornerRadius: 8,
          boxWidth: 12,
          boxHeight: 3,
          boxPadding: 4,
          bodySpacing: 4,
          titleMarginBottom: 8,
          titleFont: { weight: 'normal', size: 12 },
          bodyFont: { weight: 'bold', size: 13 },
          footerFont: { weight: 'normal', size: 12 },
          // Biggest first, and silent about series with nothing on that day.
          itemSort: (a, b) => valueOf(b) - valueOf(a),
          filter: (item) => valueOf(item) !== 0,
          callbacks: {
            title: (items) => {
              const index = items[0]?.dataIndex ?? 0;
              return input.titles?.[index] ?? input.labels[index] ?? '';
            },
            // The value leads, the series name follows.
            label: (item) => `${input.format(valueOf(item))}  ${item.dataset.label ?? ''}`,
            labelColor: (item) => {
              const fill = item.dataset.backgroundColor;
              const colour = typeof fill === 'string' ? fill : theme.other;
              return { borderColor: colour, backgroundColor: colour, borderWidth: 0 };
            },
            footer: (items) => {
              if (items.length < 2 || input.series.length < 2) return '';
              const total = items.reduce((sum, item) => sum + valueOf(item), 0);
              return `Total ${input.format(total)}`;
            },
          },
        },
      },
      scales: scales(),
    },
  };

  function scales(): NonNullable<ChartConfiguration<'bar'>['options']>['scales'] {
    const category = {
      stacked: true,
      grid: { display: false },
      border: { color: theme.axis },
      ticks: {
        color: theme.muted,
        font: { size: 11 },
        maxRotation: 0,
        autoSkip: true,
        ...(input.horizontal
          ? { callback: (_: unknown, index: number) => shorten(input.labels[index] ?? '') }
          : { maxTicksLimit: 8 }),
      },
    };
    const value = {
      stacked: true,
      beginAtZero: true,
      border: { display: false },
      grid: { color: theme.grid },
      ticks: {
        color: theme.muted,
        font: { size: 11 },
        maxTicksLimit: 6,
        ...(input.integers ? { precision: 0 } : {}),
        callback: (tick: string | number) => input.format(Number(tick)),
      },
    };
    return input.horizontal ? { x: value, y: category } : { x: category, y: value };
  }

  const chart = new Chart(canvas, config);

  /** Re-reads every colour and the motion setting from the page (theme switch, Reduced motion toggle). */
  function restyle(): void {
    theme = readTheme();
    const options = chart.options;
    options.animation = reducedMotion() ? false : { duration: 200 };
    const tooltip = options.plugins?.tooltip;
    if (tooltip) {
      tooltip.backgroundColor = theme.surface;
      tooltip.borderColor = theme.border;
      tooltip.titleColor = theme.muted;
      tooltip.bodyColor = theme.text;
      tooltip.footerColor = theme.muted;
    }
    options.scales = scales();
    chart.data.datasets.forEach((dataset, index) => {
      const series = input.series[index];
      if (!series) return;
      dataset.backgroundColor = colourOf(series, theme);
      dataset.borderColor = theme.surface;
    });
    chart.update('none');
  }

  const observer = new MutationObserver(restyle);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-bs-theme', 'data-reduced-motion'],
  });
  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motionQuery.addEventListener('change', restyle);

  const applyVisibility = (): void => {
    input.series.forEach((series, index) => {
      chart.setDatasetVisibility(index, !hidden.has(series.id));
    });
  };

  return {
    update(next) {
      input = next;
      chart.data.labels = next.labels;
      chart.data.datasets = datasets();
      chart.options.indexAxis = next.horizontal ? 'y' : 'x';
      chart.options.scales = scales();
      applyVisibility();
      chart.update();
    },
    setVisible(id, visible) {
      if (visible) hidden.delete(id);
      else hidden.add(id);
      applyVisibility();
      chart.update();
    },
    destroy() {
      observer.disconnect();
      motionQuery.removeEventListener('change', restyle);
      chart.destroy();
    },
  };
}
