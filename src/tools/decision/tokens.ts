/**
 * How many input tokens a decision request will be, roughly, so the form can refuse one that cannot fit the
 * model's context before anything is sent, and the header can estimate the (input-only) price.
 *
 * `approxTokens` is the same approximation Chat uses (a tool folder may not import another's): Latin text about
 * four characters per token, other alphabets two, CJK, kana, Hangul, Indic and Thai one. It is multiplied by
 * `JSON_FACTOR`, because a decision request is JSON and the models count more tokens than that for it: Jev billed
 * 476 input tokens for the 830 characters of the tutorial request (about 0.57 per character; four characters per
 * token would give 208), Mercury 253 (docs/openrouter-api.md §8.2). The factor puts the estimate above both, the
 * way every estimate in this app errs high.
 */
import type { DecisionRequest } from '../../core/api/types';
import { formatInt } from '../../ui/format';

/** Jev's context window, the one the docs state (§8.1); used when the catalog does not say. */
export const DEFAULT_CONTEXT_TOKENS = 32_000;

const JSON_FACTOR = 2.5;
/** The framing the service adds around state and questions. */
const OVERHEAD_TOKENS = 32;

/** Scripts where one character is about one token (or more). */
function isWide(code: number): boolean {
  return (
    (code >= 0x0900 && code <= 0x0dff) || // Devanagari … Sinhala
    (code >= 0x0e00 && code <= 0x0eff) || // Thai, Lao
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x1780 && code <= 0x17ff) || // Khmer
    (code >= 0x2e80 && code <= 0x9fff) || // CJK radicals, kana, CJK ideographs
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility
    (code >= 0xff00 && code <= 0xffef) // full-width forms
  );
}

export function approxTokens(value: string): number {
  let latin = 0;
  let other = 0;
  let wide = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x0250) latin++;
    else if (isWide(code)) wide++;
    else other++;
  }
  return Math.ceil(latin / 4 + other / 2 + wide);
}

/** Input tokens of the request: its state and questions (the model id is not part of what is read). */
export function estimateInputTokens(request: Pick<DecisionRequest, 'state' | 'questions'>): number {
  const body = JSON.stringify({ state: request.state, questions: request.questions });
  return Math.ceil(approxTokens(body) * JSON_FACTOR) + OVERHEAD_TOKENS;
}

/** A refusal message when the request cannot fit `limit` tokens, else null. */
export function contextProblem(tokens: number, limit: number): string | null {
  if (tokens <= limit) return null;
  return `The situation and questions are about ${formatInt(tokens)} tokens, and this model reads ${formatInt(limit)}. Shorten the situation or remove questions, or choose a model with a larger context.`;
}
