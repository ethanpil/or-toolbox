/**
 * Builds the chat request for a point in a thread: the system prompt, then the messages of the path (user
 * messages with their attachments as content parts, replies as text), trimmed from the oldest end when they would
 * not fit the model's context window, plus the sampling, reasoning, fallback and PDF options.
 *
 * Token counts are approximations, deliberately on the high side (4 Latin characters per token, 2 for other
 * alphabets, 1 per CJK, Hangul, kana, Indic or Thai character; fixed allowances per image, PDF and audio file):
 * they decide trimming, the `max_tokens` clamp and the cost estimate, never billing.
 */
import type { ChatMessage, ChatRequest, ContentPart } from '../../core/api/types';
import { toContentPart } from './attachments';
import type { AttachmentRef, ChatNode } from './thread';

export interface RequestOptions {
  model: string;
  /** Fallback models (`models`), tried in order after `model`. */
  fallbacks: string[];
  system: string;
  temperature: number | null;
  maxTokens: number | null;
  /** '' = the model's default. */
  reasoningEffort: string;
  /** `file-parser` engine for PDFs. */
  pdfEngine: string;
  /** The model's context window in tokens; null = unknown (nothing is trimmed). */
  contextLength: number | null;
  /** The model's own output cap: `max_tokens` never exceeds it, and the estimate assumes it when unset. */
  maxCompletionTokens?: number | null;
  /**
   * The model's input modalities, when known. Images, audio and (for the `native` PDF engine) PDFs in *earlier*
   * messages go as a short note to a model that cannot take them (after a mid-chat switch); the message being
   * answered is checked before sending (`missingInput`).
   */
  inputModalities?: readonly string[] | null;
}

export interface BuiltRequest {
  body: ChatRequest;
  /** Messages left out at the start to fit the context window. */
  trimmed: number;
  /** Approximate prompt tokens of what is sent. */
  promptTokens: number;
  /** The output tokens an estimate should assume. */
  completionTokens: number;
  /** The message being answered does not fit the context window even on its own: do not send. */
  tooLong: boolean;
}

/** Output assumed by estimates and kept free in the context when Max tokens is not set. */
export const DEFAULT_OUTPUT_TOKENS = 4096;

/** Per-message overhead (role markers) in the token approximation. */
const MESSAGE_OVERHEAD = 4;

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

export function approxTokens(text: string): number {
  let latin = 0;
  let other = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x0250) latin++;
    else if (isWide(code)) wide++;
    else other++; // other alphabets; each half of a surrogate pair (emoji, rare CJK) counts here
  }
  return Math.ceil(latin / 4 + other / 2 + wide);
}

/** Rough token cost of one attachment as the model sees it. */
export function attachmentTokens(ref: AttachmentRef): number {
  switch (ref.kind) {
    case 'text':
      return approxTokens(ref.text ?? '') + 10;
    case 'image':
      return 1500;
    case 'pdf':
      // Parsed to text: about a page of text per 50 KB of a text PDF, far less for scans.
      return ref.parsed !== undefined
        ? approxTokens(ref.parsed)
        : Math.max(1000, Math.ceil(ref.size / 50));
    case 'audio':
      // ~32 tokens per second at ~16 KB per second of MP3.
      return Math.max(200, Math.ceil(ref.size / 500));
  }
}

/** Tokens per message, counted again only when its text or a PDF's parser text changed. */
const tokenCache = new WeakMap<ChatNode, { stamp: string; tokens: number }>();

export function nodeTokens(node: ChatNode): number {
  const stamp = [node.content.length, ...(node.attachments ?? []).map((ref) => ref.parsed?.length)]
    .map(String)
    .join(',');
  const hit = tokenCache.get(node);
  if (hit?.stamp === stamp) return hit.tokens;
  const attachments = (node.attachments ?? []).reduce((sum, ref) => sum + attachmentTokens(ref), 0);
  const tokens = approxTokens(node.content) + attachments + MESSAGE_OVERHEAD;
  tokenCache.set(node, { stamp, tokens });
  return tokens;
}

/** True when a reply has something to send back as context (failed replies with no text are skipped). */
const hasContent = (node: ChatNode): boolean =>
  node.role === 'user' || node.content.trim().length > 0;

/** A PDF goes to the parser: its bytes are here and it has not been read yet. */
const needsParser = (ref: AttachmentRef, data: (id: string) => string | undefined): boolean =>
  ref.kind === 'pdf' && ref.parsed === undefined && data(ref.id) !== undefined;

/** PDFs on `path` that the request uploads for parsing (their bytes are here, no parser text yet). */
export function unparsedPdfs(
  path: readonly ChatNode[],
  data: (id: string) => string | undefined,
): AttachmentRef[] {
  return path.flatMap((node) => (node.attachments ?? []).filter((ref) => needsParser(ref, data)));
}

type Modality = 'image' | 'audio' | 'file';

/** The input a model needs for an attachment, or null when it goes as text (or as a note). */
function modalityOf(
  ref: AttachmentRef,
  pdfEngine: string,
  data: (id: string) => string | undefined,
): Modality | null {
  if (ref.kind === 'text' || data(ref.id) === undefined) return null;
  if (ref.kind === 'pdf') return ref.parsed === undefined && pdfEngine === 'native' ? 'file' : null;
  return ref.kind;
}

/**
 * The first input the message's attachments need that `modalities` lacks ('image', 'audio', or 'file' for a PDF
 * the model reads itself), or null. Attachments whose bytes are gone go as a note and need nothing.
 */
export function missingInput(
  attachments: readonly AttachmentRef[],
  modalities: readonly string[],
  pdfEngine: string,
  has: (id: string) => boolean,
): Modality | null {
  const data = (id: string): string | undefined => (has(id) ? '' : undefined);
  for (const ref of attachments) {
    const needed = modalityOf(ref, pdfEngine, data);
    if (needed && !modalities.includes(needed)) return needed;
  }
  return null;
}

const NOTE_LABELS: Readonly<Record<Modality, string>> = {
  image: 'Image',
  audio: 'Audio',
  file: 'PDF',
};

/**
 * One user message as wire content: a plain string, or the text part first, then one part per attachment.
 * `takes(modality)` false turns an attachment that needs it into a note (the model cannot read it).
 */
export function userContent(
  node: Pick<ChatNode, 'content' | 'attachments'>,
  data: (id: string) => string | undefined,
  takes: (modality: Modality) => boolean = () => true,
  pdfEngine = '',
): string | ContentPart[] {
  const attachments = node.attachments ?? [];
  if (attachments.length === 0) return node.content;
  return [
    ...(node.content ? [{ type: 'text' as const, text: node.content }] : []),
    ...attachments.map((ref): ContentPart => {
      const needed = modalityOf(ref, pdfEngine, data);
      return needed && !takes(needed)
        ? {
            type: 'text',
            text: `[${NOTE_LABELS[needed]} "${ref.name}" not sent: this model cannot read it.]`,
          }
        : toContentPart(ref, data(ref.id));
    }),
  ];
}

/**
 * Drops messages from the start until the rest fits `budget` tokens. The last message (the one being answered)
 * is always kept, and the kept part starts with a user message. Returns how many were dropped.
 */
export function trimToBudget(
  tokens: readonly number[],
  roles: readonly string[],
  budget: number,
): number {
  let total = tokens.reduce((sum, value) => sum + value, 0);
  let dropped = 0;
  const last = tokens.length - 1;
  while (dropped < last && total > budget) total -= tokens[dropped++]!;
  // Once something was dropped, a reply whose question is gone goes too.
  while (dropped > 0 && dropped < last && roles[dropped] !== 'user') dropped++;
  return dropped;
}

/**
 * The request for answering the last message of `path` (a user message), with the active-path context before
 * it. `data` returns an attachment's data URL from the session.
 */
export function buildRequest(
  path: readonly ChatNode[],
  options: RequestOptions,
  data: (id: string) => string | undefined,
): BuiltRequest {
  const turns = path.filter(hasContent);
  const system = options.system.trim();
  const systemTokens = system ? approxTokens(system) + MESSAGE_OVERHEAD : 0;
  const tokens = turns.map(nodeTokens);
  const outputCap =
    options.maxCompletionTokens && options.maxCompletionTokens > 0
      ? options.maxCompletionTokens
      : Number.POSITIVE_INFINITY;
  let maxTokens = options.maxTokens === null ? null : Math.min(options.maxTokens, outputCap);
  const wanted = maxTokens ?? Math.min(outputCap, DEFAULT_OUTPUT_TOKENS);

  let trimmed = 0;
  let tooLong = false;
  let completionTokens = wanted;
  const context = options.contextLength;
  if (context && context > 0) {
    // Leave room for the answer and a margin for the approximation.
    const budget =
      Math.floor(context * 0.95) - Math.min(wanted, Math.floor(context / 2)) - systemTokens;
    trimmed = trimToBudget(
      tokens,
      turns.map((node) => node.role),
      budget,
    );
    const kept = tokens.slice(trimmed).reduce((sum, value) => sum + value, 0);
    tooLong = kept > budget;
    // The prompt and the answer together must fit the window.
    const room = Math.max(1, context - systemTokens - kept);
    if (maxTokens !== null) maxTokens = Math.min(maxTokens, room);
    completionTokens = Math.min(wanted, room);
  }
  const kept = turns.slice(trimmed);
  const modalities = options.inputModalities;
  const takes = (modality: string): boolean => !modalities || modalities.includes(modality);
  const messages: ChatMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...kept.map((node, index): ChatMessage =>
      node.role === 'user'
        ? {
            role: 'user',
            content: userContent(
              node,
              data,
              index === kept.length - 1 ? undefined : takes,
              options.pdfEngine,
            ),
          }
        : { role: 'assistant', content: node.content },
    ),
  ];
  const sentFiles = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'file'),
  );
  const body: ChatRequest = {
    model: options.model,
    ...(options.fallbacks.length > 0 ? { models: options.fallbacks } : {}),
    messages,
    ...(options.temperature !== null ? { temperature: options.temperature } : {}),
    ...(maxTokens !== null ? { max_tokens: maxTokens } : {}),
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    ...(sentFiles ? { plugins: [{ id: 'file-parser', pdf: { engine: options.pdfEngine } }] } : {}),
  };
  return {
    body,
    trimmed,
    promptTokens: systemTokens + tokens.slice(trimmed).reduce((sum, value) => sum + value, 0),
    completionTokens,
    tooLong,
  };
}
