/**
 * How many input tokens a decision request will be, roughly. Two numbers, for two jobs:
 *
 * - `estimateInputTokens` is for the **price**. It is deliberately high, the way every estimate in this app errs,
 *   because a decision request is JSON and the models count more tokens than prose for it: Jev billed 476 input
 *   tokens for the 830 characters of the tutorial request, where the structure-aware count of src/core/tokens.ts
 *   gives 269; Mercury billed 253 (docs/openrouter-api.md §8.2). The whole body is inflated by `JSON_FACTOR`.
 * - `contextInputTokens` is for **refusing** a request that cannot fit the model's context before anything is
 *   sent. A refusal must not lean one way: it counts the situation's prose as prose (`approxTokens`,
 *   src/core/tokens.ts) and inflates only the structure around it (the questions, the field names), so a long
 *   text of about 120,000 characters is not turned away at a 32,000 token context.
 */
import type { DecisionRequest } from '../../core/api/types';
import { approxTokens } from '../../core/tokens';
import { isRecord, isString } from '../../core/util';
import { formatInt } from '../../ui/format';

/** Jev's context window, the one the docs state (§8.1); used when the catalog does not say. */
export const DEFAULT_CONTEXT_TOKENS = 32_000;

/** 269 × 1.8 + 32 = 517, above Jev's 476 for the tutorial request. */
const JSON_FACTOR = 1.8;
/** The framing the service adds around state and questions. */
const OVERHEAD_TOKENS = 32;

type Body = Pick<DecisionRequest, 'state' | 'questions'>;

/** Input tokens of the request for the price: the whole body at the heavier JSON rate. */
export function estimateInputTokens(request: Body): number {
  const body = JSON.stringify({ state: request.state, questions: request.questions });
  return Math.ceil(approxTokens(body) * JSON_FACTOR) + OVERHEAD_TOKENS;
}

/** The situation's prose, and everything else the request says (field names, questions) as JSON. */
function split(request: Body): { prose: string; structure: string } {
  const { state, questions } = request;
  if (isString(state)) return { prose: state, structure: JSON.stringify({ questions }) };
  if (isRecord(state)) {
    const entries = Object.entries(state);
    return {
      prose: entries.flatMap(([, value]) => (isString(value) ? [value] : [])).join('\n'),
      structure: JSON.stringify({
        state: entries.map(([key, value]) => (isString(value) ? key : [key, value])),
        questions,
      }),
    };
  }
  return { prose: '', structure: JSON.stringify({ state, questions }) };
}

/** Input tokens of the request as the context sees them, for deciding whether it fits. */
export function contextInputTokens(request: Body): number {
  const { prose, structure } = split(request);
  return approxTokens(prose) + Math.ceil(approxTokens(structure) * JSON_FACTOR) + OVERHEAD_TOKENS;
}

/** A refusal message when the request cannot fit `limit` tokens, else null. */
export function contextProblem(tokens: number, limit: number): string | null {
  if (tokens <= limit) return null;
  return `The situation and questions are about ${formatInt(tokens)} tokens, and this model reads ${formatInt(limit)}. Shorten the situation or remove questions, or choose a model with a larger context.`;
}
