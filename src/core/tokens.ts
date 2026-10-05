/**
 * Token counts and context limits for chat-style requests: the one definition every tool uses (Chat, Bot-to-bot,
 * Model arena, Decision; core/attachments/request.ts re-exports it).
 *
 * `approxTokens` is an approximation, deliberately on the high side: it decides context trimming, `max_tokens`
 * clamps and cost estimates, never billing (the API's `usage` does). It is structure-aware: letters and spaces
 * count 4 per token (prose), but every digit counts as a token (many tokenizers split numbers into digits) and
 * three ASCII punctuation marks or symbols make two tokens, so JSON, code and tables are not under-counted (the
 * flat 4 per token gave 208 for the documented 830-character decision request, which Mercury billed as 253 and
 * Jev as 476; this gives 269). Other alphabets count 2 characters per token, CJK, Hangul, kana, Indic and Thai 1.
 * No text counts fewer tokens than under the flat rule.
 */

/** Per-message overhead (role markers) in the token approximation. */
export const MESSAGE_OVERHEAD = 4;

/** Output an estimate assumes, and the context keeps free, when Max tokens is not set. */
export const DEFAULT_OUTPUT_TOKENS = 4096;

/** Scripts where one character is about one token (or more): CJK, kana, Hangul, Indic, Thai and neighbours. */
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

/** ASCII punctuation and symbols: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~ */
const isAsciiMark = (code: number): boolean =>
  (code >= 0x21 && code <= 0x2f) ||
  (code >= 0x3a && code <= 0x40) ||
  (code >= 0x5b && code <= 0x60) ||
  (code >= 0x7b && code <= 0x7e);

export function approxTokens(text: string): number {
  let latin = 0;
  let digits = 0;
  let marks = 0;
  let other = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x30 && code <= 0x39) digits++;
    else if (isAsciiMark(code)) marks++;
    else if (code < 0x0250)
      latin++; // letters, spaces and the rest of Latin
    else if (isWide(code)) wide++;
    else other++; // other alphabets; each half of a surrogate pair (emoji, rare CJK) counts here
  }
  return Math.ceil(latin / 4 + digits + (marks * 2) / 3 + other / 2 + wide);
}

/** The model's own output cap; unlimited when the catalog does not say. */
export function outputCap(maxCompletionTokens?: number | null): number {
  return maxCompletionTokens && maxCompletionTokens > 0
    ? maxCompletionTokens
    : Number.POSITIVE_INFINITY;
}

/** The output a request makes room for: Max tokens (null = not set: the default), within the model's cap. */
export function outputTokens(
  maxTokens: number | null,
  maxCompletionTokens?: number | null,
): number {
  return Math.min(maxTokens ?? DEFAULT_OUTPUT_TOKENS, outputCap(maxCompletionTokens));
}

export interface ContextLimits {
  /** The model's context window; null, 0 or unknown: nothing is trimmed or refused. */
  context: number | null | undefined;
  /** The user's Max tokens; null or absent = not set (`max_tokens` is left out, estimates assume the default). */
  maxTokens?: number | null;
  /** The model's own output cap (`ModelInfo.maxCompletionTokens`). */
  maxCompletionTokens?: number | null;
  /** Prompt tokens that always go, whatever is trimmed (the system message, a pinned opener). */
  fixed?: number;
}

export interface ContextFit {
  /** What `promptBudget` gives: the prompt tokens besides `fixed` that may be sent. */
  budget: number;
  /** The prompt does not fit even after trimming: do not send it. */
  tooLong: boolean;
  /** Output tokens the window leaves after the prompt (at least 1); unlimited when the window is unknown. */
  room: number;
  /** The output an estimate assumes. */
  completionTokens: number;
  /** `max_tokens` to send: Max tokens within the model's cap and the room, or null when not set. */
  maxTokens: number | null;
}

/**
 * The prompt tokens (besides `fixed`) a request may send: the window less a 5% margin for the approximation, less
 * room for the answer (`outputTokens`, at most half the window), less `fixed`. Trim to it, then call `fitContext`.
 */
export function promptBudget(limits: ContextLimits): number {
  const { context } = limits;
  if (!context || context <= 0) return Number.POSITIVE_INFINITY;
  const wanted = outputTokens(limits.maxTokens ?? null, limits.maxCompletionTokens);
  return (
    Math.floor(context * 0.95) - Math.min(wanted, Math.floor(context / 2)) - (limits.fixed ?? 0)
  );
}

/**
 * Fits `prompt` tokens (what is sent besides `fixed`, after any trimming) into the model's window: whether it is too
 * long to send, and how many output tokens to ask for and to estimate. The prompt and the answer together never
 * pass the window.
 */
export function fitContext(limits: ContextLimits & { prompt: number }): ContextFit {
  const { context, prompt } = limits;
  const fixed = limits.fixed ?? 0;
  const wanted = outputTokens(limits.maxTokens ?? null, limits.maxCompletionTokens);
  const budget = promptBudget(limits);
  const room =
    context && context > 0 ? Math.max(1, context - fixed - prompt) : Number.POSITIVE_INFINITY;
  return {
    budget,
    tooLong: prompt > budget,
    room,
    completionTokens: Math.min(wanted, room),
    maxTokens: (limits.maxTokens ?? null) === null ? null : Math.min(wanted, room),
  };
}
