/**
 * One arena round as data, and every rule about it that is not drawing: the form's settings (what
 * `getState`/`applyState` carry), default contenders, the blind shuffle, voting and revealing, and the metrics
 * each panel and the summary table show. arena.ts runs the requests and draws; nothing here touches the DOM.
 *
 * A round keeps its contenders in the order of the form (`entries`); `order` maps panels to entries
 * (`entries[order[p]]` is panel p, labelled "Model A" for p = 0). Blind rounds shuffle `order` and keep names,
 * costs and anything else that tells models apart hidden until the user votes or reveals (`revealed`).
 */
import { isPdfEngineId, type PdfEngineId } from '../../core/models/pdf-engines';
import type { ModelInfo } from '../../core/types';
import { isFiniteNumber, isString } from '../../core/util';
import type { FailureText } from '../../ui/feedback/errors';

export const MIN_CONTENDERS = 2;
export const MAX_CONTENDERS = 4;
export const PANEL_LETTERS = ['A', 'B', 'C', 'D'] as const;

/** The form apart from the prompt: what a snapshot (Prompts, History) restores. */
export interface ArenaSettings {
  /** 2 to 4 contender model ids, in the form's order. */
  models: string[];
  system: string;
  temperature: number | null;
  /** Sent as `max_tokens` (clamped per model) and assumed by estimates; null = each model's default. */
  maxTokens: number | null;
  blind: boolean;
  pdfEngine: PdfEngineId;
}

export const DEFAULT_SETTINGS: Readonly<Omit<ArenaSettings, 'models'>> = {
  system: '',
  temperature: null,
  maxTokens: null,
  blind: true,
  pdfEngine: 'cloudflare-ai',
};

/** The largest Max tokens the form takes (as Chat). */
export const MAX_TOKENS_LIMIT = 10_000_000;

const isModelList = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= MIN_CONTENDERS &&
  value.length <= MAX_CONTENDERS &&
  value.every((id) => isString(id) && id.trim() !== '');

const isTemperature = (value: unknown): value is number | null =>
  value === null || (isFiniteNumber(value) && value >= 0 && value <= 2);

const isMaxTokens = (value: unknown): value is number | null =>
  value === null ||
  (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_TOKENS_LIMIT);

/**
 * `base` with every valid field of `raw` applied (saved options, a snapshot from Prompts or History). Fields that
 * are missing or invalid keep `base`'s value, so older or damaged snapshots never break the form.
 */
export function settingsFrom(raw: Record<string, unknown>, base: ArenaSettings): ArenaSettings {
  return {
    models: isModelList(raw['models']) ? [...raw['models']] : [...base.models],
    system: isString(raw['system']) ? raw['system'] : base.system,
    temperature: isTemperature(raw['temperature']) ? raw['temperature'] : base.temperature,
    maxTokens: isMaxTokens(raw['maxTokens']) ? raw['maxTokens'] : base.maxTokens,
    blind: typeof raw['blind'] === 'boolean' ? raw['blind'] : base.blind,
    pdfEngine: isPdfEngineId(raw['pdfEngine']) ? raw['pdfEngine'] : base.pdfEngine,
  };
}

/**
 * Distinct free text models for a fresh arena, `count` of them where the catalog has enough: the `preferred` ones
 * first (the user's text default, the shipped free defaults; only if free), then the newest free models of
 * providers not picked yet, then any other free model. Paid `fallback`s fill up only when too few free models
 * exist (catalog not loaded, or nothing free): a round always has at least two contenders.
 */
export function defaultContenders(
  catalog: readonly ModelInfo[],
  preferred: readonly (string | null | undefined)[],
  fallback: readonly (string | null | undefined)[],
  count = MIN_CONTENDERS,
): string[] {
  const free = catalog.filter((model) => model.isFree);
  const byId = new Map(free.map((model) => [model.id, model]));
  const picked: string[] = [];
  const authors = new Set<string>();
  const take = (id: string, author: string): void => {
    if (picked.length >= count || picked.includes(id)) return;
    picked.push(id);
    authors.add(author);
  };
  for (const id of preferred) {
    const model = id ? byId.get(id) : undefined;
    if (model) take(model.id, model.author);
  }
  const newest = [...free].sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  for (const model of newest) if (!authors.has(model.author)) take(model.id, model.author);
  for (const model of newest) take(model.id, model.author);
  for (const id of [...preferred, ...fallback]) if (id) take(id, '');
  return picked;
}

// --- rounds ---------------------------------------------------------------------------------------------------

export type EntryStatus = 'waiting' | 'streaming' | 'done' | 'stopped' | 'error';

export interface EntryUsage {
  /** From the stream's usage chunk; null when none arrived (a stopped or cut stream): unknown, not 0. */
  promptTokens: number | null;
  completionTokens: number | null;
  /** Reasoning tokens counted in `completionTokens` (`completion_tokens_details.reasoning_tokens`). */
  reasoningTokens?: number;
  costUsd: number;
  costEstimated: boolean;
  costUnknown: boolean;
  /** With an unknown cost: what budgets counted for it (the run's reservation, or more if it spent more). */
  bookedUsd?: number;
}

/** One contender's answer in a round. Times are on one monotonic clock (`performance.now()`), in ms. */
export interface Entry {
  model: string;
  /** The model OpenRouter reports, when it differs (a dated snapshot, a router). */
  servedModel?: string;
  status: EntryStatus;
  text: string;
  /** Reasoning arrived before any text (shown as "Thinking…"). */
  thinking?: boolean;
  /** Some reasoning streamed (so the time after the first token includes it). */
  reasoned?: boolean;
  /**
   * Status `error`: what to show once names are shown (`failureText(error)`, with the unknown-outcome caution) and
   * while they are hidden (`failureText(error, { blind: true })`: the same for every model).
   */
  failure?: { shown: FailureText; blind: FailureText };
  /** Request sent (`onSend`), first token and end, on one monotonic clock. */
  startedAt?: number;
  firstTokenAt?: number;
  endedAt?: number;
  usage?: EntryUsage;
  finishReason?: string | null;
  runId?: string;
}

export type Vote = { kind: 'winner'; panel: number } | { kind: 'tie' } | { kind: 'bad' };

export interface RoundAttachment {
  name: string;
  type: string;
  size: number;
}

export interface Round {
  /** Also the `groupId` of its runs. */
  id: string;
  prompt: string;
  settings: ArenaSettings;
  attachments: RoundAttachment[];
  /** Panel p shows `entries[order[p]]`. */
  order: number[];
  entries: Entry[];
  vote: Vote | null;
  /** Names and costs are shown: blind off, or after a vote or "Reveal without voting". */
  revealed: boolean;
  /** The entry a Retry is running again, from the press (planning, the budget dialog) until it settles. */
  retrying?: number;
  /** Wall clock, for the export. */
  startedAt: number;
}

/** A random permutation of 0…n-1 (Fisher–Yates). */
export function shuffle(n: number, random: () => number = Math.random): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export function newRound(input: {
  id: string;
  prompt: string;
  settings: ArenaSettings;
  attachments: readonly RoundAttachment[];
  startedAt: number;
  random?: () => number;
}): Round {
  const n = input.settings.models.length;
  const blind = input.settings.blind;
  return {
    id: input.id,
    prompt: input.prompt,
    settings: { ...input.settings, models: [...input.settings.models] },
    attachments: input.attachments.map(({ name, type, size }) => ({ name, type, size })),
    order: blind ? shuffle(n, input.random) : Array.from({ length: n }, (_, i) => i),
    entries: input.settings.models.map((model) => ({ model, status: 'waiting', text: '' })),
    vote: null,
    revealed: !blind,
    startedAt: input.startedAt,
  };
}

export const panelLetter = (panel: number): string => PANEL_LETTERS[panel] ?? String(panel + 1);
export const panelLabel = (panel: number): string => `Model ${panelLetter(panel)}`;

/** The entry shown in panel `panel`. */
export const entryAt = (round: Round, panel: number): Entry => round.entries[round.order[panel]!]!;

/** The panel that shows entry `index`. */
export const panelOf = (round: Round, index: number): number => round.order.indexOf(index);

export const isSettled = (entry: Entry): boolean =>
  entry.status === 'done' || entry.status === 'stopped' || entry.status === 'error';

/** Something to judge: an answer, finished or stopped part-way. */
export const hasAnswer = (entry: Entry): boolean =>
  (entry.status === 'done' || entry.status === 'stopped') && entry.text.trim() !== '';

export const roundSettled = (round: Round): boolean => round.entries.every(isSettled);

/** The answer ended at the length limit (Max tokens, or the model's own cap). */
export const cutOff = (entry: Entry): boolean =>
  entry.status === 'done' && entry.finishReason === 'length';

/** Every answer is in: all settled, and no Retry pending (a retried panel is about to change). */
export const allIn = (round: Round): boolean => roundSettled(round) && round.retrying === undefined;

/**
 * The round still takes a vote: none cast, and in a blind round the names are still hidden (a vote after "Reveal
 * without voting" would not be blind any more).
 */
export const openForVote = (round: Round): boolean =>
  round.vote === null && (!round.settings.blind || !round.revealed);

/** Voting opens once every answer is in and at least one answered; one vote per round. */
export const canVote = (round: Round): boolean =>
  openForVote(round) && allIn(round) && round.entries.some(hasAnswer);

/** Export once the names show and every answer is in (a half-streamed round is not a result yet). */
export const exportReady = (round: Round): boolean => round.revealed && allIn(round);

/** Records `vote` (a winner must have answered) and reveals the names. False when the vote is not allowed. */
export function castVote(round: Round, vote: Vote): boolean {
  if (!canVote(round)) return false;
  if (vote.kind === 'winner') {
    const entry = round.entries[round.order[vote.panel] ?? -1];
    if (!entry || !hasAnswer(entry)) return false;
  }
  round.vote = vote;
  round.revealed = true;
  return true;
}

/** "Reveal without voting": the names show and the round takes no vote any more. */
export function reveal(round: Round): void {
  round.revealed = true;
}

// --- metrics ----------------------------------------------------------------------------------------------------

export interface Metrics {
  /** Request sent → first token (text or reasoning). */
  ttftMs: number | null;
  /** Request sent → answer complete (or stopped, or failed). */
  totalMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Output tokens over the time after the first token; null when that time is too short to measure. */
  tokensPerSecond: number | null;
  costUsd: number | null;
  costEstimated: boolean;
  costUnknown: boolean;
  /** With an unknown cost: what budgets counted for it, said with it; null otherwise. */
  bookedUsd: number | null;
}

/** Shorter than this after the first token, a rate is noise (a reply that arrived in one piece). */
const MIN_GENERATION_MS = 50;

export function metricsOf(entry: Entry): Metrics {
  const { startedAt, firstTokenAt, endedAt, usage } = entry;
  const ttftMs =
    startedAt !== undefined && firstTokenAt !== undefined ? firstTokenAt - startedAt : null;
  const totalMs =
    startedAt !== undefined && endedAt !== undefined && isSettled(entry)
      ? endedAt - startedAt
      : null;
  const generationMs =
    firstTokenAt !== undefined && endedAt !== undefined ? endedAt - firstTokenAt : null;
  const completionTokens = usage?.completionTokens ?? null;
  // Reasoning that never streamed happened before the first token: the count includes it, the time does not.
  const hiddenReasoning = (usage?.reasoningTokens ?? 0) > 0 && entry.reasoned !== true;
  return {
    ttftMs,
    totalMs,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens,
    tokensPerSecond:
      completionTokens &&
      !hiddenReasoning &&
      generationMs !== null &&
      generationMs >= MIN_GENERATION_MS
        ? completionTokens / (generationMs / 1000)
        : null,
    costUsd: usage && !usage.costUnknown ? usage.costUsd : null,
    costEstimated: usage?.costEstimated ?? false,
    costUnknown: usage?.costUnknown ?? false,
    bookedUsd: usage?.costUnknown ? (usage.bookedUsd ?? null) : null,
  };
}

export interface SummaryRow {
  panel: number;
  entry: Entry;
  metrics: Metrics;
  fastest: boolean;
  cheapest: boolean;
}

/**
 * The lowest value's holders among `values` (null skipped), when at least two values compare and they are not
 * all the same (a full tie marks nobody: two free models are not both "cheapest").
 */
function lowest(values: readonly (number | null)[]): Set<number> {
  const known = values.filter((value): value is number => value !== null);
  if (known.length < 2) return new Set();
  const min = Math.min(...known);
  if (known.every((value) => value === min)) return new Set();
  return new Set(values.flatMap((value, index) => (value === min ? [index] : [])));
}

/**
 * The comparison table in panel order. Fastest is the lowest total time, cheapest the lowest known cost, both
 * among finished answers only and only when at least two compare (a shared lowest marks each; a full tie none).
 */
export function summary(round: Round): SummaryRow[] {
  const rows = round.order.map((index, panel) => {
    const entry = round.entries[index]!;
    return { panel, entry, metrics: metricsOf(entry) };
  });
  const finished = (row: (typeof rows)[number]): boolean => row.entry.status === 'done';
  const fastest = lowest(rows.map((row) => (finished(row) ? row.metrics.totalMs : null)));
  const cheapest = lowest(
    rows.map((row) => (finished(row) && !row.metrics.costEstimated ? row.metrics.costUsd : null)),
  );
  return rows.map((row, i) => ({ ...row, fastest: fastest.has(i), cheapest: cheapest.has(i) }));
}
