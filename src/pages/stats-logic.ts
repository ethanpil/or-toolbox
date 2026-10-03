/**
 * The Stats page without a DOM or a chart library: date ranges (UTC days, like the stats ledger), totals,
 * grouping, the time series behind the charts (top series, the rest folded into "Other", colours that follow the
 * entity and not its rank), the table twin of every chart, and the budget pace. Pure, so stats-logic.test.ts
 * covers the numbers; stats.ts draws them and stats-charts.ts hands them to Chart.js.
 */
import type { StatsRow } from '../core/types';
import { utcDay, utcMonthStart } from '../core/util';

const DAY_MS = 86_400_000;

// --- ranges -----------------------------------------------------------------------------------------------

export type RangePreset = '7d' | '30d' | '90d' | 'month' | 'custom';
export interface DateRange {
  /** UTC days `YYYY-MM-DD`, both inclusive. */
  from: string;
  to: string;
}

/** Every day the ledger can hold: one read of it serves a whole page. */
export const ALL_TIME: DateRange = { from: '0000-01-01', to: '9999-12-31' };

export const RANGE_PRESETS: readonly { id: Exclude<RangePreset, 'custom'>; label: string }[] = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'month', label: 'This month' },
];

/** The longest custom range the page draws (two years of daily bars). */
export const MAX_RANGE_DAYS = 731;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC time of a `YYYY-MM-DD` day, or null for anything that is not a real date. */
export function dayTime(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && utcDay(time) === day ? time : null;
}

/** A preset ending today (UTC): the last N days including today, or the month so far. */
export function presetRange(
  preset: Exclude<RangePreset, 'custom'>,
  now: number = Date.now(),
): DateRange {
  const to = utcDay(now);
  if (preset === 'month') return { from: utcMonthStart(now), to };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { from: utcDay(now - (days - 1) * DAY_MS), to };
}

/**
 * The range for a preset, from the current time: a relative range (7, 30, 90 days, this month) is recomputed on
 * every load, so a page left open rolls over at UTC midnight and at the end of the month. A custom range is kept.
 */
export function resolveRange(
  preset: RangePreset,
  custom: DateRange,
  now: number = Date.now(),
): DateRange {
  return preset === 'custom' ? custom : presetRange(preset, now);
}

/** The rows of one range (both days included) out of a ledger already read: one read serves the whole page. */
export function rowsIn(rows: readonly StatsRow[], range: DateRange): StatsRow[] {
  return rows.filter((row) => row.day >= range.from && row.day <= range.to);
}

/** Number of days in a range, inclusive; 0 for a reversed or unreadable one. */
export function rangeDays(range: DateRange): number {
  const from = dayTime(range.from);
  const to = dayTime(range.to);
  return from === null || to === null || to < from ? 0 : Math.round((to - from) / DAY_MS) + 1;
}

/** A custom range from two inputs, or the reason it is not usable. */
export function parseCustomRange(
  from: string,
  to: string,
): { range: DateRange } | { error: string } {
  if (dayTime(from) === null || dayTime(to) === null)
    return { error: 'Pick a start and an end day.' };
  const range = { from, to };
  const days = rangeDays(range);
  if (days === 0) return { error: 'The start day must not be after the end day.' };
  if (days > MAX_RANGE_DAYS) return { error: `Pick at most ${MAX_RANGE_DAYS} days.` };
  return { range };
}

/** The range of equal length that ends the day before `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const days = Math.max(1, rangeDays(range));
  const from = dayTime(range.from) ?? 0;
  return { from: utcDay(from - days * DAY_MS), to: utcDay(from - DAY_MS) };
}

/** Every day of the range, oldest first. */
export function daysOf(range: DateRange): string[] {
  const from = dayTime(range.from);
  const count = rangeDays(range);
  if (from === null) return [];
  return Array.from({ length: count }, (_, index) => utcDay(from + index * DAY_MS));
}

/** `Sep 4 to Oct 3, 2026` (UTC days). */
export function rangeLabel(range: DateRange): string {
  const format = (day: string, year: boolean): string =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      ...(year ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
    });
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return range.from === range.to
    ? format(range.to, true)
    : `${format(range.from, !sameYear)} to ${format(range.to, true)}`;
}

/** `Oct 3` for chart axes and tables (UTC). */
export function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

// --- totals and groups ------------------------------------------------------------------------------------

export interface Totals {
  costUsd: number;
  /** The part of `costUsd` that is an estimate (see `StatsRow.estimatedUsd`). */
  estimatedUsd: number;
  requests: number;
  runs: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  latencyMsTotal: number;
  freeRequests: number;
  paidRequests: number;
}

const emptyTotals = (): Totals => ({
  costUsd: 0,
  estimatedUsd: 0,
  requests: 0,
  runs: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  latencyMsTotal: 0,
  freeRequests: 0,
  paidRequests: 0,
});

function add(into: Totals, row: StatsRow): void {
  into.costUsd += row.costUsd;
  into.estimatedUsd += row.estimatedUsd ?? 0;
  into.requests += row.requests;
  into.runs += row.runs;
  into.errors += row.errors;
  into.promptTokens += row.promptTokens;
  into.completionTokens += row.completionTokens;
  into.latencyMsTotal += row.latencyMsTotal;
  if (row.free) into.freeRequests += row.requests;
  else into.paidRequests += row.requests;
}

export function totalsOf(rows: readonly StatsRow[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) add(totals, row);
  return totals;
}

/** A money figure that includes estimates reads `≈ $1.65`; an exact one is left as it is. */
export const markEstimate = (text: string, estimatedUsd: number): string =>
  estimatedUsd > 0 ? `≈ ${text}` : text;

/** Failed runs per run, or null when nothing ran. */
export const errorRate = (totals: Pick<Totals, 'errors' | 'runs'>): number | null =>
  totals.runs > 0 ? totals.errors / totals.runs : null;

/** Mean latency per request, or null without requests. */
export const averageLatency = (
  totals: Pick<Totals, 'latencyMsTotal' | 'requests'>,
): number | null => (totals.requests > 0 ? totals.latencyMsTotal / totals.requests : null);

/** Share of requests served by free models, or null without requests. */
export const freeShare = (totals: Pick<Totals, 'freeRequests' | 'requests'>): number | null =>
  totals.requests > 0 ? totals.freeRequests / totals.requests : null;

export type Dimension = 'tool' | 'model' | 'key';
export interface Group extends Totals {
  id: string;
}

/** Totals per tool, model or key, biggest spender first (then most requests, then id). */
export function groupBy(rows: readonly StatsRow[], dimension: Dimension): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const id = dimension === 'tool' ? row.tool : dimension === 'model' ? row.model : row.keyId;
    let group = groups.get(id);
    if (!group) {
      group = { id, ...emptyTotals() };
      groups.set(id, group);
    }
    add(group, row);
  }
  return [...groups.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.id.localeCompare(b.id),
  );
}

/** Change from `previous` to `current` as a fraction (0.12 = +12%); null when there is no baseline. */
export function change(current: number, previous: number): number | null {
  return previous > 0 ? (current - previous) / previous : null;
}

export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  const percent = fraction * 100;
  if (percent === 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

/** `+12%`, `−5%`, `no change`. */
export function formatChange(fraction: number): string {
  const percent = Math.round(fraction * 100);
  return percent === 0 ? 'no change' : `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

// --- time series for the charts ---------------------------------------------------------------------------

/** Colour slots of the categorical palette in use (the 8th hue stays out: red reads as an error). */
export const SERIES_SLOTS = 7;

export type SeriesDimension = 'tool' | 'model';
export type Metric = 'costUsd' | 'requests';

export interface Series {
  /** The tool id or model id; `OTHER` for the folded rest. */
  id: string;
  /** 0 to `SERIES_SLOTS - 1`, or null for "Other" (drawn in the neutral grey). */
  slot: number | null;
  /** One value per day of the range. */
  values: number[];
  total: number;
  /** For the spend metric, the part of each day's value that is an estimate (absent or 0: all of it is exact). */
  estimated?: number[];
}

export const OTHER = '__other__';

/** Entities best first by cost, then requests: the order colours are handed out in. */
export function preferredOrder(rows: readonly StatsRow[], dimension: SeriesDimension): string[] {
  return groupBy(rows, dimension).map((group) => group.id);
}

/**
 * Colour slots that follow the entity: an entity keeps the slot of its overall rank (`preferred`, e.g. computed
 * from all-time rows) whenever that rank is within the palette and nobody else holds it, so changing the date
 * range or the series count does not repaint the survivors. The rest take the free slots in order.
 */
export function assignSlots(
  ids: readonly string[],
  preferred: readonly string[],
  slots: number = SERIES_SLOTS,
): Map<string, number> {
  const result = new Map<string, number>();
  const used = new Set<number>();
  for (const id of ids) {
    const rank = preferred.indexOf(id);
    if (rank >= 0 && rank < slots && !used.has(rank)) {
      result.set(id, rank);
      used.add(rank);
    }
  }
  let next = 0;
  for (const id of ids) {
    if (result.has(id)) continue;
    while (used.has(next)) next++;
    if (next >= slots) break;
    result.set(id, next);
    used.add(next);
  }
  return result;
}

/**
 * Daily values of `metric` per tool or model: the biggest `SERIES_SLOTS` entities get a series each (ranked by
 * the metric, then by the other one), everything else is folded into one "Other" series. Series come out
 * biggest first, "Other" last. A day outside `days` is ignored.
 */
export function timeSeries(
  rows: readonly StatsRow[],
  days: readonly string[],
  dimension: SeriesDimension,
  metric: Metric,
  preferred: readonly string[] = [],
): Series[] {
  const index = new Map(days.map((day, position) => [day, position]));
  const byId = new Map<string, number[]>();
  const estimatedById = new Map<string, number[]>();
  const totals = new Map<string, { metric: number; other: number }>();
  const otherMetric: Metric = metric === 'costUsd' ? 'requests' : 'costUsd';

  for (const row of rows) {
    const position = index.get(row.day);
    if (position === undefined) continue;
    const id = dimension === 'tool' ? row.tool : row.model;
    let values = byId.get(id);
    if (!values) {
      values = new Array<number>(days.length).fill(0);
      byId.set(id, values);
      estimatedById.set(id, new Array<number>(days.length).fill(0));
      totals.set(id, { metric: 0, other: 0 });
    }
    values[position] = (values[position] ?? 0) + row[metric];
    if (metric === 'costUsd') {
      const estimated = estimatedById.get(id)!;
      estimated[position] = (estimated[position] ?? 0) + (row.estimatedUsd ?? 0);
    }
    const total = totals.get(id)!;
    total.metric += row[metric];
    total.other += row[otherMetric];
  }

  // Entities with nothing in this metric (free models in a spend chart) have no series at all.
  const ranked = [...byId.keys()]
    .filter((id) => (totals.get(id)?.metric ?? 0) > 0)
    .sort((a, b) => {
      const x = totals.get(a)!;
      const y = totals.get(b)!;
      return y.metric - x.metric || y.other - x.other || a.localeCompare(b);
    });
  const top = ranked.slice(0, SERIES_SLOTS);
  const rest = ranked.slice(SERIES_SLOTS);
  const slots = assignSlots(top, preferred);

  const series: Series[] = top.map((id) => ({
    id,
    slot: slots.get(id) ?? null,
    values: byId.get(id)!,
    total: totals.get(id)!.metric,
    estimated: estimatedById.get(id)!,
  }));
  if (rest.length > 0) {
    const values = new Array<number>(days.length).fill(0);
    const estimated = new Array<number>(days.length).fill(0);
    for (const id of rest) {
      byId.get(id)!.forEach((value, position) => {
        values[position] = (values[position] ?? 0) + value;
      });
      estimatedById.get(id)!.forEach((value, position) => {
        estimated[position] = (estimated[position] ?? 0) + value;
      });
    }
    series.push({
      id: OTHER,
      slot: null,
      values,
      total: values.reduce((a, b) => a + b, 0),
      estimated,
    });
  }
  return series;
}

/**
 * The hidden series that may stay hidden. A legend is only drawn for two or more series, and it is the only way to
 * show a series again, so with fewer than two everything is shown; a series that left the chart is forgotten.
 */
export function pruneHidden(hidden: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  if (ids.length < 2) return new Set();
  const present = new Set(ids);
  return new Set([...hidden].filter((id) => present.has(id)));
}

export interface TokenBar {
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** Tokens in and out for the `limit` models that used the most. */
export function tokensByModel(rows: readonly StatsRow[], limit = 8): TokenBar[] {
  return groupBy(rows, 'model')
    .filter((group) => group.promptTokens + group.completionTokens > 0)
    .sort(
      (a, b) =>
        b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
    .map((group) => ({
      model: group.id,
      promptTokens: group.promptTokens,
      completionTokens: group.completionTokens,
    }));
}

/**
 * The table twin of a time chart: a header row (Day, one column per series, Total), a row per day that has
 * data (days with nothing add nothing to read), formatted by `format`; a figure that includes estimates is marked ≈.
 */
export function seriesTable(
  days: readonly string[],
  series: readonly Series[],
  label: (id: string) => string,
  format: (value: number) => string,
): { head: string[]; body: string[][] } {
  const head = ['Day', ...series.map((s) => label(s.id)), ...(series.length > 1 ? ['Total'] : [])];
  const body: string[][] = [];
  days.forEach((day, position) => {
    const values = series.map((s) => s.values[position] ?? 0);
    const estimates = series.map((s) => s.estimated?.[position] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const estimatedTotal = estimates.reduce((a, b) => a + b, 0);
    body.push([
      shortDay(day),
      ...values.map((value, i) => markEstimate(format(value), estimates[i] ?? 0)),
      ...(series.length > 1 ? [markEstimate(format(total), estimatedTotal)] : []),
    ]);
  });
  return { head, body };
}

// --- budget pace ------------------------------------------------------------------------------------------

export interface BudgetPace {
  spendUsd: number;
  limitUsd: number;
  /** Spend over limit; above 1 the limit is passed. */
  fraction: number;
  remainingUsd: number;
  /** How much of the UTC month has passed, 0 to 1: where an even spender would be. */
  elapsed: number;
  daysLeft: number;
  /** Month-end spend at the current pace; null in the first day of the month (too early to say). */
  projectedUsd: number | null;
  severity: 'ok' | 'warning' | 'over';
}

/** Where this month's spend stands against a limit (the UTC month, like the ledger and the budgets). */
export function budgetPace(
  spendUsd: number,
  limitUsd: number,
  now: number = Date.now(),
): BudgetPace {
  const start = dayTime(utcMonthStart(now)) ?? now;
  const date = new Date(now);
  const daysInMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const elapsedDays = Math.max(0, (now - start) / DAY_MS);
  const fraction = limitUsd > 0 ? spendUsd / limitUsd : spendUsd > 0 ? Infinity : 0;
  return {
    spendUsd,
    limitUsd,
    fraction,
    remainingUsd: Math.max(0, limitUsd - spendUsd),
    elapsed: Math.min(1, elapsedDays / daysInMonth),
    daysLeft: Math.max(0, Math.ceil(daysInMonth - elapsedDays)),
    projectedUsd: elapsedDays >= 1 ? (spendUsd / elapsedDays) * daysInMonth : null,
    severity: fraction >= 1 ? 'over' : fraction >= 0.8 ? 'warning' : 'ok',
  };
}

// --- text alternatives ------------------------------------------------------------------------------------

/**
 * One sentence that tells a screen-reader user what a time chart shows: the total, the busiest day and the
 * biggest series. The data table next to the chart has every value.
 */
export function seriesSummary(
  title: string,
  days: readonly string[],
  series: readonly Series[],
  label: (id: string) => string,
  format: (value: number) => string,
): string {
  if (series.length === 0) return `${title}: no data in this period.`;
  const perDay = days.map((_, position) =>
    series.reduce((sum, s) => sum + (s.values[position] ?? 0), 0),
  );
  const total = perDay.reduce((a, b) => a + b, 0);
  let peak = 0;
  perDay.forEach((value, position) => {
    if (value > (perDay[peak] ?? 0)) peak = position;
  });
  const biggest = series.reduce((best, s) => (s.total > best.total ? s : best));
  const active = perDay.filter((value) => value > 0).length;
  return [
    `${title}: ${format(total)} over ${active} active ${active === 1 ? 'day' : 'days'}.`,
    `Busiest day ${shortDay(days[peak] ?? '')} with ${format(perDay[peak] ?? 0)}.`,
    series.length > 1 ? `Largest series ${label(biggest.id)} with ${format(biggest.total)}.` : '',
    series.some((s) => (s.estimated ?? []).some((value) => value > 0))
      ? 'Includes estimated costs.'
      : '',
    'The table view lists every value.',
  ]
    .filter(Boolean)
    .join(' ');
}
