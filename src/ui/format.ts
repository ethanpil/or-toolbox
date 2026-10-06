/**
 * Display formatting shared by the shell, the platform pages and the tools: money, tokens, latencies,
 * context sizes, model prices, relative times and keyboard shortcuts. Media durations and byte sizes come
 * from src/core/files (re-exported here so UI code has one import).
 */

import type { KeyStatus } from '../core/types';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../core/util';
import { describePrice, modelPrice, type PriceModel } from './model-price';

export { formatBytes, formatDuration } from '../core/files';

/**
 * US dollars with as much precision as small amounts need: `$1,234.50`, `$0.10`, `$0.051`, `$0.0012`.
 * Below one dollar two significant digits are kept (at least two decimals); anything under a hundredth of a
 * cent shows as `<$0.0001`. Not finite → `—`.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  const sign = usd < 0 ? '−' : '';
  const value = Math.abs(usd);
  if (value === 0) return '$0.00';
  if (value >= 1) {
    return `${sign}$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (value < 0.0001) return `${sign}<$0.0001`;
  // Two significant digits (no trailing zeros), never fewer than two decimals: 0.0512 → 0.051, 0.04 → 0.04.
  const decimals = Math.max(2, 1 - Math.floor(Math.log10(value)));
  const text = value.toFixed(decimals).replace(/(\.\d\d\d*?)0+$/, '$1');
  return `${sign}$${text}`;
}

/** A pre-run estimate: `≈ $0.0012`, `Free` for exactly zero, `Unknown` for null. */
export function formatEstimate(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd)) return 'Unknown';
  if (usd === 0) return 'Free';
  return `≈ ${formatUsd(usd)}`;
}

/** What a finished request or run says about its cost (`Usage`, `UsageTotals`, a run's or a turn's totals). */
export interface RunCostFields {
  /** null: no number to show (a panel that has not answered yet). */
  costUsd: number | null;
  /** `costUsd` is the client's estimate from catalog prices, not what OpenRouter reported. */
  costEstimated?: boolean;
  /** Some request's cost could not be determined at all: the number is not the cost. */
  costUnknown?: boolean;
}

export interface RunCostOptions {
  /** The model is free: a zero cost reads `Free`, not `$0.00`. Never applies to an unknown cost. */
  free?: boolean;
  /** USD counted against budgets in place of an unknown cost (the run's reservation); said with it. */
  booked?: number | null;
}

export type RunCostKind = 'free' | 'known' | 'estimated' | 'unknown' | 'none';

export interface RunCost {
  kind: RunCostKind;
  /** Short, for a cell or a labelled value: `Free`, `$0.012`, `≈ $0.012`, `Unknown`, `—`. */
  text: string;
  /** For `unknown`: what was counted instead (`≈ $0.0034`), or null when nothing is known about it. */
  counted: string | null;
}

/**
 * The one rule for what a run cost: unknown first (never free, never zero, never `≈`: the amount counted for it is
 * said separately), then free (a zero cost on a free model), then an estimate (`≈ $0.012`), else the amount
 * OpenRouter reported. History, Chat, Bot-to-bot and Model arena all word costs through this.
 */
export function describeRunCost(cost: RunCostFields, options: RunCostOptions = {}): RunCost {
  if (cost.costUnknown) {
    const booked = options.booked ?? 0;
    return {
      kind: 'unknown',
      text: 'Unknown',
      counted: booked > 0 ? `≈ ${formatUsd(booked)}` : null,
    };
  }
  if (cost.costUsd === null) return { kind: 'none', text: '—', counted: null };
  if (cost.costUsd === 0 && options.free) return { kind: 'free', text: 'Free', counted: null };
  return cost.costEstimated
    ? { kind: 'estimated', text: `≈ ${formatUsd(cost.costUsd)}`, counted: null }
    : { kind: 'known', text: formatUsd(cost.costUsd), counted: null };
}

/** `describeRunCost` as one string: `Unknown (≈ $0.0034 counted)` when something was counted for an unknown cost. */
export function formatRunCost(cost: RunCostFields, options: RunCostOptions = {}): string {
  const { text, counted } = describeRunCost(cost, options);
  return counted ? `${text} (${counted} counted)` : text;
}

/** Tokens, cost and latency of one answer or turn. */
export interface UsageFields extends RunCostFields {
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/**
 * `1.2K in · 340 out · $0.0012 · 1.4 s`: the line under a reply. The cost follows `describeRunCost`, in lower case
 * because nothing labels it (`free`, `cost unknown (≈ $0.0034 counted)`); no latency when it is 0.
 */
export function usageLine(usage: UsageFields | undefined, options: RunCostOptions = {}): string {
  if (!usage) return '';
  const cost = describeRunCost(usage, options);
  const text =
    cost.kind === 'unknown'
      ? `cost unknown${cost.counted ? ` (${cost.counted} counted)` : ''}`
      : cost.kind === 'free'
        ? 'free'
        : cost.text;
  return [
    `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out`,
    cost.kind === 'none' ? null : text,
    usage.latencyMs > 0 ? formatMs(usage.latencyMs) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Compact counts: `950`, `1.2K`, `34K`, `1.5M`. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const compact = (value: number, suffix: string): string =>
    `${Number(value >= 100 ? value.toFixed(0) : value.toFixed(1))}${suffix}`;
  if (abs >= 1e9) return compact(n / 1e9, 'B');
  if (abs >= 1e6) return compact(n / 1e6, 'M');
  if (abs >= 1e3) return compact(n / 1e3, 'K');
  return String(Math.round(n));
}

/** A whole number with thousands separators: `1,234`. Not finite → `—`. */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
}

/** `1,234 tokens` / `1 token`. */
export function formatTokens(n: number): string {
  return `${formatInt(n)} ${Math.round(n) === 1 ? 'token' : 'tokens'}`;
}

/** Latencies and elapsed times: `850 ms`, `1.2 s`, `42 s`, `3 min 5 s`, `1 h 2 min`. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    const rest = totalSeconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} h ${restMinutes} min` : `${hours} h`;
}

/** Context window: `128K context`, `1M context`. */
export function formatContext(tokens: number | null): string | null {
  if (!tokens || tokens <= 0) return null;
  return `${formatCount(tokens)} context`;
}

/**
 * One line describing what a model costs, for pickers and chips: `Free`, `$0.10 in · $0.50 out per 1M tokens`,
 * `≈ $0.03 per image`, `$0.36 per hour of audio`, `$0.04 per request`, or `Price varies`. The unit is the model's
 * own billing unit; the rules live in model-price.ts, shared with the Models page (see docs/openrouter-api.md §9.3).
 */
export function formatModelPrice(model: PriceModel): string {
  return describePrice(modelPrice(model), formatUsd).text;
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * `just now`, `5 minutes ago`, `3 hours ago`, `yesterday`, `4 days ago`, then a date (`Mar 4`, or
 * `Mar 4, 2025` in another year). Future times read `in 5 minutes`.
 */
export function formatRelativeTime(time: number, now: number = Date.now()): string {
  const diff = time - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (abs < HOUR_MS) return RELATIVE.format(Math.round(diff / MINUTE_MS), 'minute');
  if (abs < DAY_MS) return RELATIVE.format(Math.round(diff / HOUR_MS), 'hour');
  if (abs < 7 * DAY_MS) {
    // Calendar days, so "yesterday" means the previous date, not "24 to 48 hours ago".
    const startOf = (t: number): number => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    return RELATIVE.format(Math.round((startOf(time) - startOf(now)) / DAY_MS), 'day');
  }
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return formatDate(time, { year: !sameYear });
}

export interface DateOptions {
  /** Include the year (default true). */
  year?: boolean;
  /** Include the short weekday (`Mon, Oct 3`). */
  weekday?: boolean;
}

/**
 * `Oct 3, 2026`. A number is a timestamp, shown in the user's time zone; a `YYYY-MM-DD` string is a UTC day (the
 * stats ledger, model expiry dates), shown as that same day everywhere.
 */
export function formatDate(when: number | string, options: DateOptions = {}): string {
  const { year = true, weekday = false } = options;
  const day = typeof when === 'string';
  return new Date(day ? `${when.slice(0, 10)}T00:00:00Z` : when).toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    ...(year ? { year: 'numeric' } : {}),
    ...(day ? { timeZone: 'UTC' } : {}),
  });
}

/**
 * The `dateTime` of a `<time>`: an ISO string, or undefined (no attribute) for a time no `Date` can hold, on
 * which `toISOString()` throws. Use it for stored times, so one bad record cannot break a whole list.
 */
export function isoDateTime(time: number): string | undefined {
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Full date and time for tooltips and `<time>` titles. */
export function formatDateTime(time: number): string {
  return new Date(time).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export interface KeyBalance {
  /** `Used this month` / `Used in total`, with the amount. */
  usageLabel: string;
  usage: string;
  /** `$5.00`, or `No limit`. */
  limit: string;
  /** `$4.50 left`, or null without a limit. */
  remaining: string | null;
  /** Share of the limit still available, 0–100; null without a limit. */
  remainingPercent: number | null;
  /** `resets monthly`, or null. */
  reset: string | null;
  /** `12 of 50 used`, or null when OpenRouter did not say. */
  freeDaily: string | null;
}

/** What a key's `GET /key` status says, as display text (Settings → Keys, the key menu, Stats). */
export function keyBalance(status: KeyStatus): KeyBalance {
  const monthly = status.usageMonthlyUsd !== null;
  const limited = status.limitUsd !== null;
  const remaining =
    status.limitRemainingUsd ?? (limited ? Math.max(0, status.limitUsd! - status.usageUsd) : null);
  return {
    usageLabel: monthly ? 'Used this month' : 'Used in total',
    usage: formatUsd(status.usageMonthlyUsd ?? status.usageUsd),
    limit: limited ? formatUsd(status.limitUsd!) : 'No limit',
    remaining: remaining !== null ? `${formatUsd(remaining)} left` : null,
    remainingPercent:
      limited && remaining !== null
        ? status.limitUsd! > 0
          ? Math.min(100, Math.max(0, Math.round((remaining / status.limitUsd!) * 100)))
          : 0
        : null,
    reset: status.limitReset ? `resets ${status.limitReset}` : null,
    freeDaily: status.freeDaily
      ? `${formatInt(status.freeDaily.used)} of ${formatInt(status.freeDaily.limit)} used`
      : null,
  };
}

/** True on Apple platforms, where shortcuts use ⌘ instead of Ctrl. */
export function isApplePlatform(): boolean {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** A shortcut for display: `formatShortcut('K')` → `Ctrl K` (or `⌘ K` on Apple platforms). */
export function formatShortcut(key: string): string {
  return `${isApplePlatform() ? '⌘' : 'Ctrl'} ${key}`;
}

/** `1 image`, `3 images`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
