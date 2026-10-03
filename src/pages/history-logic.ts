/**
 * The History page without a DOM: turning filters into a `HistoryQuery`, paging with the `before` cursor, grouping
 * by day, and the readable forms of a run's cost, tokens, settings and output. Pure, so history-logic.test.ts
 * covers the rules and the page only draws them.
 */
import type { HistoryQuery, RunRecord, RunStatus } from '../core/types';
import { TOOL_IDS, type ToolId } from '../tools/types';
import { formatCount, formatMs, formatUsd } from '../ui/format';

export interface HistoryFilters {
  text: string;
  tool: ToolId | '';
  status: RunStatus | '';
  model: string;
  keyId: string;
  starred: boolean;
  /** Local calendar days, `YYYY-MM-DD`, both inclusive; '' = open. */
  from: string;
  to: string;
}

export const NO_HISTORY_FILTERS: Readonly<HistoryFilters> = {
  text: '',
  tool: '',
  status: '',
  model: '',
  keyId: '',
  starred: false,
  from: '',
  to: '',
};

export const STATUS_INFO: Readonly<Record<RunStatus, { label: string; badge: string }>> = {
  ok: { label: 'Done', badge: 'bg-success-subtle text-success-emphasis' },
  error: { label: 'Failed', badge: 'bg-danger-subtle text-danger-emphasis' },
  aborted: { label: 'Stopped', badge: 'bg-secondary-subtle text-secondary-emphasis' },
  running: { label: 'Running', badge: 'bg-primary-subtle text-primary-emphasis' },
};

export function activeHistoryFilters(filters: HistoryFilters): number {
  return [
    filters.text.trim() !== '',
    filters.tool !== '',
    filters.status !== '',
    filters.model !== '',
    filters.keyId !== '',
    filters.starred,
    filters.from !== '',
    filters.to !== '',
  ].filter(Boolean).length;
}

// --- dates ------------------------------------------------------------------------------------------------

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Start of a local calendar day (`YYYY-MM-DD`) in ms, or null when the text is not a real date. */
export function localDayStart(day: string): number | null {
  const match = DAY_PATTERN.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = new Date(year, month - 1, date);
  // `new Date(2026, 1, 31)` rolls over to March; refuse it.
  return time.getFullYear() === year && time.getMonth() === month - 1 && time.getDate() === date
    ? time.getTime()
    : null;
}

/** Last millisecond of a local calendar day. */
export function localDayEnd(day: string): number | null {
  const start = localDayStart(day);
  if (start === null) return null;
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  return next.getTime() - 1;
}

/** `YYYY-MM-DD` in local time. */
export function dayKey(time: number): string {
  const date = new Date(time);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `Today`, `Yesterday`, `Mon, Oct 3`, or `Oct 3, 2025` in another year. */
export function dayLabel(time: number, now: number = Date.now()): string {
  const key = dayKey(time);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString('en-US', {
    weekday: sameYear ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
}

export interface DayGroup {
  key: string;
  label: string;
  runs: RunRecord[];
}

/** Newest-first runs split into consecutive days (local time), keeping their order. */
export function groupByDay(runs: readonly RunRecord[], now: number = Date.now()): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const run of runs) {
    const key = dayKey(run.startedAt);
    const last = groups.at(-1);
    if (last?.key === key) last.runs.push(run);
    else groups.push({ key, label: dayLabel(run.startedAt, now), runs: [run] });
  }
  return groups;
}

// --- queries and paging -----------------------------------------------------------------------------------

export const PAGE_SIZE = 40;

/** The `HistoryQuery` for the filters; unset filters are left out. */
export function toQuery(filters: HistoryFilters, extra: Partial<HistoryQuery> = {}): HistoryQuery {
  const query: HistoryQuery = { ...extra };
  const text = filters.text.trim();
  if (text) query.text = text;
  if (filters.tool) query.tool = filters.tool;
  if (filters.status) query.status = filters.status;
  if (filters.model) query.model = filters.model;
  if (filters.keyId) query.keyId = filters.keyId;
  if (filters.starred) query.starred = true;
  const from = filters.from ? localDayStart(filters.from) : null;
  const to = filters.to ? localDayEnd(filters.to) : null;
  if (from !== null) query.from = from;
  if (to !== null) query.to = to;
  return query;
}

/**
 * The query for the page after `shown`. `before` is exclusive, and parallel runs (arena contenders) can start in
 * the same millisecond, so the cursor is the last row's time plus one and the rows already shown at that time are
 * asked for again (and dropped by `appendPage`); nothing is skipped at a page boundary.
 */
export function nextPage(
  shown: readonly RunRecord[],
  size: number = PAGE_SIZE,
): { before: number; limit: number } | null {
  const last = shown.at(-1);
  if (!last) return null;
  const repeated = shown.filter((run) => run.startedAt === last.startedAt).length;
  return { before: last.startedAt + 1, limit: size + repeated };
}

/** `page` appended to `shown`, without the runs `shown` already has. */
export function appendPage(shown: readonly RunRecord[], page: readonly RunRecord[]): RunRecord[] {
  const seen = new Set(shown.map((run) => run.id));
  return [...shown, ...page.filter((run) => !seen.has(run.id))];
}

/** `?tool=` and `?run=` from the address bar; anything else is ignored. */
export function parseHistoryParams(search: string): { tool: ToolId | null; run: string | null } {
  const params = new URLSearchParams(search);
  const tool = params.get('tool');
  const run = params.get('run');
  return {
    tool: (TOOL_IDS as readonly string[]).includes(tool ?? '') ? (tool as ToolId) : null,
    run: run && /^[\w-]{1,100}$/.test(run) ? run : null,
  };
}

// --- readable run facts -----------------------------------------------------------------------------------

export interface CostInfo {
  text: string;
  /** Marked in the list: the number is a guess, or missing. */
  note: 'estimated' | 'unknown' | null;
  title: string;
}

/** What a run cost, with estimated and unknown costs marked rather than shown as exact or zero. */
export function costInfo(run: RunRecord, isFree: (model: string) => boolean): CostInfo {
  if (run.status === 'running') return { text: 'Running', note: null, title: 'Still running.' };
  const { costUsd, costUnknown, costEstimated } = run.usage;
  if (costUnknown) {
    return {
      text: 'Unknown',
      note: 'unknown',
      title: 'OpenRouter did not report a cost for this run. Budgets counted the pre-run estimate.',
    };
  }
  if (costEstimated && costUsd > 0) {
    return {
      text: `≈ ${formatUsd(costUsd)}`,
      note: 'estimated',
      title: 'Estimated from catalog prices; OpenRouter did not report the cost.',
    };
  }
  if (costUsd === 0) {
    return isFree(run.model)
      ? { text: 'Free', note: null, title: 'A free model.' }
      : { text: '$0.00', note: null, title: 'OpenRouter reported no charge.' };
  }
  return { text: formatUsd(costUsd), note: null, title: 'Reported by OpenRouter.' };
}

/** `1.2K in · 340 out`, or null when the run used no tokens (images, speech, video). */
export function tokenText(run: Pick<RunRecord, 'usage'>): string | null {
  const { promptTokens, completionTokens } = run.usage;
  if (promptTokens === 0 && completionTokens === 0) return null;
  return `${formatCount(promptTokens)} in · ${formatCount(completionTokens)} out`;
}

export function latencyText(run: Pick<RunRecord, 'latencyMs'>): string | null {
  return run.latencyMs === null ? null : formatMs(run.latencyMs);
}

export interface UsageRow {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
}

/** The "usage by model" table: one row per model the run called. */
export function usageRows(run: Pick<RunRecord, 'usage'>): UsageRow[] {
  return Object.entries(run.usage.byModel).map(([model, totals]) => ({
    model,
    requests: totals.requests,
    promptTokens: totals.promptTokens,
    completionTokens: totals.completionTokens,
    costUsd: totals.costUsd,
    avgLatencyMs: totals.requests > 0 ? totals.latencyMsTotal / totals.requests : null,
  }));
}

export interface Entry {
  label: string;
  value: string;
  /** Long or multi-line: shown in a block of its own rather than beside the label. */
  block: boolean;
}

/** `aspectRatio` → `Aspect ratio`, `max_tokens` → `Max tokens`. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (Array.isArray(value) && value.every((item) => typeof item !== 'object' || item === null)) {
    return value.length === 0 ? '—' : value.map(formatValue).join(', ');
  }
  try {
    const compact = JSON.stringify(value);
    return compact.length > 80 ? JSON.stringify(value, null, 2) : compact;
  } catch {
    return '—';
  }
}

/** A tool's saved settings (or a run's meta) as readable label/value pairs. */
export function entriesOf(values: Record<string, unknown> | null): Entry[] {
  if (!values) return [];
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const text = formatValue(value);
      return {
        label: humanizeKey(key),
        value: text,
        block: text.length > 80 || text.includes('\n'),
      };
    });
}

export interface OutputView {
  /** `json` is shown in monospace as written; `markdown` goes through renderMarkdown. */
  kind: 'json' | 'markdown';
  text: string;
}

/** JSON outputs (extractors, decisions) are pretty-printed; everything else is Markdown/plain text. */
export function outputView(output: string): OutputView {
  const trimmed = output.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { kind: 'json', text: JSON.stringify(JSON.parse(trimmed) as unknown, null, 2) };
    } catch {
      // Not JSON after all.
    }
  }
  return { kind: 'markdown', text: output };
}
