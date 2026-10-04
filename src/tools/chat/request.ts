/**
 * Builds the chat request for a point in a thread: the system prompt, then the messages of the path (user
 * messages with their attachments as content parts, replies as text), trimmed from the oldest end when they would
 * not fit the model's context window, plus the sampling, reasoning, fallback and PDF options.
 *
 * Token counts come from the shared approximation (src/core/attachments/request.ts): deliberately high, they
 * decide trimming, the `max_tokens` clamp and the cost estimate, never billing.
 */
import type { ChatMessage, ChatRequest, ContentPart } from '../../core/api/types';
import { type AttachmentRef, toContentPart } from '../../core/attachments/attachments';
import {
  approxTokens,
  attachmentTokens,
  MESSAGE_OVERHEAD,
  type Modality,
  neededInput,
  needsParser,
} from '../../core/attachments/request';
import type { ChatNode } from './thread';

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

/** PDFs on `path` that the request uploads for parsing (their bytes are here, no parser text yet). */
export function unparsedPdfs(
  path: readonly ChatNode[],
  data: (id: string) => string | undefined,
): AttachmentRef[] {
  return path.flatMap((node) => (node.attachments ?? []).filter((ref) => needsParser(ref, data)));
}

const NOTE_LABELS: Readonly<Record<Modality, string>> = {
  image: 'Image',
  audio: 'Audio',
  file: 'PDF',
};

/** A note in place of an attachment whose bytes are gone (the thread was reloaded). */
export function missingNote(ref: AttachmentRef): string {
  return `[Attachment "${ref.name}" (${ref.kind === 'pdf' ? 'PDF' : ref.kind}) is no longer available.]`;
}

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
      const needed = neededInput(ref, pdfEngine, data);
      return needed && !takes(needed)
        ? {
            type: 'text',
            text: `[${NOTE_LABELS[needed]} "${ref.name}" not sent: this model cannot read it.]`,
          }
        : (toContentPart(ref, data(ref.id)) ?? { type: 'text', text: missingNote(ref) });
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
