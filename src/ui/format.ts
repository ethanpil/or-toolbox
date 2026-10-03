/**
 * Display formatting shared by the shell, the platform pages and the tools: money, tokens, latencies,
 * context sizes, model prices, relative times and keyboard shortcuts. Media durations and byte sizes come
 * from src/core/files (re-exported here so UI code has one import).
 */

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

/** `1,234 tokens` / `1 token`. */
export function formatTokens(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} ${Math.round(n) === 1 ? 'token' : 'tokens'}`;
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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `just now`, `5 minutes ago`, `3 hours ago`, `yesterday`, `4 days ago`, then a date (`Mar 4`, or
 * `Mar 4, 2025` in another year). Future times read `in 5 minutes`.
 */
export function formatRelativeTime(time: number, now: number = Date.now()): string {
  const diff = time - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  if (abs < HOUR) return RELATIVE.format(Math.round(diff / MINUTE), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.round(diff / HOUR), 'hour');
  if (abs < 7 * DAY) {
    // Calendar days, so "yesterday" means the previous date, not "24 to 48 hours ago".
    const startOf = (t: number): number => {
      const d = new Date(t);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    };
    return RELATIVE.format(Math.round((startOf(time) - startOf(now)) / DAY), 'day');
  }
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** Full date and time for tooltips and `<time>` titles. */
export function formatDateTime(time: number): string {
  return new Date(time).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
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
