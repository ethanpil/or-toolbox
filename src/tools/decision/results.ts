/**
 * What a decisions response means, with no DOM: each answer read defensively (the spec marks `confidence` and
 * `usage.cost` optional, Mercury answers in long unrounded floats and in another key order than Jev, and unknown
 * keys may appear), the confidence of each, and whether it is clear against its threshold.
 *
 * The response is read against the questions that were asked, never the other way round: an answer for an id
 * nobody asked about is ignored, a question without a usable answer becomes a `none` result the page can show,
 * and nothing here throws on a strange body. docs/openrouter-api.md §8.2 has the shapes.
 *
 * Confidence: Yes/No has none on the wire (`noul` is P(yes)), so it is the stronger side, max(p, 1 − p); Choice
 * and Score use the API's `confidence` when it is a number, else the highest probability, else none.
 */
import type { DecisionRequest, DecisionResponse } from '../../core/api/types';
import { isFiniteNumber, isRecord, isString } from '../../core/util';
import { type QuestionDef, wireId } from './schema';

export type Verdict = 'clear' | 'review';

/** Where a result's confidence came from, for the card's small print. */
export type ConfidenceBasis = 'sides' | 'reported' | 'top-probability';

export interface OptionBar {
  name: string;
  /** null when the model sent no probabilities at all. */
  probability: number | null;
  chosen: boolean;
}

export interface LevelBar {
  index: number;
  text: string;
  probability: number | null;
}

interface Confidence {
  confidence: number | null;
  basis: ConfidenceBasis | null;
}

export type QuestionResult = { id: string; name: string } & (
  | ({ kind: 'noul'; yes: number } & Confidence)
  | ({ kind: 'choice'; choice: string; bars: OptionBar[] } & Confidence)
  | ({
      kind: 'score';
      /** The answer as sent: a 0-based float (1.99 sits on level 2). */
      score: number;
      /** `score` held inside the scale. */
      position: number;
      /** The level the score is closest to. */
      nearest: number;
      levels: LevelBar[];
    } & Confidence)
  | { kind: 'none'; reason: string }
);

export interface DecisionResult {
  results: QuestionResult[];
  /** The dated snapshot that answered, e.g. `typesafe/jev-1.13-20260917`. */
  model: string | null;
  provider: string | null;
  /** `usage.cost`, null when the response did not carry one. */
  costUsd: number | null;
  inputTokens: number | null;
}

/** A probability: a finite number held inside 0..1; anything else is not one. */
function unit(value: unknown): number | null {
  return isFiniteNumber(value) ? Math.min(1, Math.max(0, value)) : null;
}

/** Own entries of a record whose values are probabilities, in the order sent. */
function probabilities(value: unknown): [string, number][] | null {
  if (!isRecord(value)) return null;
  return Object.entries(value).flatMap(([key, entry]): [string, number][] => {
    const p = unit(entry);
    return p === null ? [] : [[key, p]];
  });
}

const top = (entries: readonly [string, number][] | null): number | null =>
  entries && entries.length > 0 ? Math.max(...entries.map(([, p]) => p)) : null;

function confidenceOf(
  answer: Record<string, unknown>,
  entries: readonly [string, number][] | null,
): Confidence {
  const reported = unit(answer['confidence']);
  if (reported !== null) return { confidence: reported, basis: 'reported' };
  const highest = top(entries);
  return highest === null
    ? { confidence: null, basis: null }
    : { confidence: highest, basis: 'top-probability' };
}

const unreadable = (question: QuestionDef): QuestionResult => ({
  kind: 'none',
  id: wireId(question),
  name: question.name,
  reason: 'The answer for this question could not be read.',
});

function readChoice(question: QuestionDef, answer: Record<string, unknown>): QuestionResult {
  const entries = probabilities(answer['probabilities']);
  const chosen = isString(answer['choice']) && answer['choice'] ? answer['choice'] : null;
  const leader = entries?.reduce<[string, number] | null>(
    (best, entry) => (best === null || entry[1] > best[1] ? entry : best),
    null,
  );
  const choice = chosen ?? leader?.[0] ?? null;
  if (choice === null) return unreadable(question);
  const named = question.options.map((option) => option.name.trim()).filter(Boolean);
  let bars: OptionBar[];
  if (entries) {
    // The options as asked first (one the model left out has no probability: 0), then any it added.
    const known = new Map(entries);
    const names = [...named, ...entries.map(([name]) => name).filter((n) => !named.includes(n))];
    bars = names.map((name) => ({
      name,
      probability: known.get(name) ?? 0,
      chosen: name === choice,
    }));
    if (!names.includes(choice)) bars.push({ name: choice, probability: 0, chosen: true });
    // Highest first; the sort is stable, so ties keep the order they were asked in.
    bars.sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
  } else {
    bars = [{ name: choice, probability: null, chosen: true }];
  }
  return {
    kind: 'choice',
    id: wireId(question),
    name: question.name,
    choice,
    bars,
    ...confidenceOf(answer, entries),
  };
}

function readScore(question: QuestionDef, answer: Record<string, unknown>): QuestionResult {
  const score = answer['score'];
  if (!isFiniteNumber(score)) return unreadable(question);
  const entries = probabilities(answer['probabilities']);
  const known = entries ? new Map(entries) : null;
  const count = question.levels.length;
  const levels = question.levels.map((text, index): LevelBar => ({
    index,
    text: text.trim(),
    probability: known ? (known.get(String(index)) ?? 0) : null,
  }));
  const position = Math.min(Math.max(0, count - 1), Math.max(0, score));
  // The levels asked about are the ones that count, so the top probability is read among them.
  const scale = entries?.filter(([key]) => /^\d+$/.test(key) && Number(key) < count) ?? null;
  return {
    kind: 'score',
    id: wireId(question),
    name: question.name,
    score,
    position,
    nearest: Math.round(position),
    levels,
    ...confidenceOf(answer, scale),
  };
}

function readNoul(question: QuestionDef, answer: Record<string, unknown>): QuestionResult {
  const yes = unit(answer['noul']);
  if (yes === null) return unreadable(question);
  return {
    kind: 'noul',
    id: wireId(question),
    name: question.name,
    yes,
    confidence: Math.max(yes, 1 - yes),
    basis: 'sides',
  };
}

/** One answer against the question it belongs to. */
export function readAnswer(question: QuestionDef, raw: unknown): QuestionResult {
  if (!isRecord(raw)) return unreadable(question);
  if (isString(raw['type']) && raw['type'] !== question.type) return unreadable(question);
  if (question.type === 'noul') return readNoul(question, raw);
  return question.type === 'choice' ? readChoice(question, raw) : readScore(question, raw);
}

export function parseDecision(
  response: unknown,
  questions: readonly QuestionDef[],
): DecisionResult {
  const body = isRecord(response) ? response : {};
  const answers = isRecord(body['answers']) ? body['answers'] : {};
  const usage = isRecord(body['usage']) ? body['usage'] : {};
  const cost = usage['cost'];
  const inputTokens = usage['input_tokens'];
  return {
    results: questions.map((question) =>
      Object.hasOwn(answers, wireId(question))
        ? readAnswer(question, answers[wireId(question)])
        : ({
            kind: 'none',
            id: wireId(question),
            name: question.name,
            reason: 'The model sent no answer for this question.',
          } satisfies QuestionResult),
    ),
    model: isString(body['model']) && body['model'] ? body['model'] : null,
    provider: isString(body['provider']) && body['provider'] ? body['provider'] : null,
    costUsd: isFiniteNumber(cost) && cost >= 0 ? cost : null,
    inputTokens: isFiniteNumber(inputTokens) && inputTokens >= 0 ? inputTokens : null,
  };
}

// --- thresholds ------------------------------------------------------------------------------------------

/**
 * Float noise in `p * 1000` (0.57 * 1000 is 569.9999999999999, 1 - 0.07 is 0.9299999999999999) is about 1e-13; a
 * product within this of a whole number is that number.
 */
const NOISE = 1e-9;

/** A probability in whole tenths of a percent, cut not rounded: 0.8390 is 839, 0.9999999995 is 999. */
function tenthsOf(p: number): number {
  return Math.floor(p * 1000 + NOISE);
}

/**
 * Clear when the confidence reaches the threshold (a percentage), else it needs review. No confidence at all is
 * never clear: nothing says the answer can be trusted.
 *
 * It is compared in the tenths of a percent `formatPercent` shows, so the number on a card and its badge cannot
 * disagree (an exact comparison missed 93% with a Yes/No confidence of `1 - 0.07`, which is 0.9299999999999999).
 */
export function verdictOf(confidence: number | null, thresholdPercent: number): Verdict {
  if (confidence === null) return 'review';
  return tenthsOf(confidence) >= Math.ceil(thresholdPercent * 10 - NOISE) ? 'clear' : 'review';
}

export function resultVerdict(result: QuestionResult, thresholdPercent: number): Verdict {
  return result.kind === 'none' ? 'review' : verdictOf(result.confidence, thresholdPercent);
}

/**
 * A probability as a percentage, cut (not rounded) to a tenth, so the text can never claim more than the number
 * says: 0.8390 is `83.9%` and stays below an 84% threshold, 0.9999 is `99.9%`, never `100%`. Under a tenth it is
 * `<0.1%`.
 */
export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return '—';
  const tenths = tenthsOf(p);
  if (tenths <= 0) return p > 0 ? '<0.1%' : '0%';
  const value = tenths / 10;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/** A score for display: `1.99`, `0`, `2` (at most two decimals, none when whole). */
export function formatScore(score: number): string {
  return String(Math.round(score * 100) / 100);
}

// --- export ----------------------------------------------------------------------------------------------

/** The Export JSON file: the request's state and questions with the answers, as sent and received. */
export function exportDocument(
  request: DecisionRequest,
  response: DecisionResponse,
): Record<string, unknown> {
  return {
    model: request.model,
    answeredBy: response.model ?? null,
    state: request.state,
    questions: request.questions,
    answers: response.answers,
    usage: response.usage ?? null,
  };
}
