/**
 * Builds the chat request for a point in a thread: the system prompt, then the messages of the path (user
 * messages with their attachments as content parts, replies as text), trimmed from the oldest end when they would
 * not fit the model's context window, plus the sampling, reasoning, fallback and PDF options.
 *
 * Token counts are approximations (4 characters per token; fixed allowances per image, PDF and audio file),
 * deliberately on the high side: they decide trimming and the cost estimate, never billing.
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
  /** The model's own output cap, for the estimate when Max tokens is not set. */
  maxCompletionTokens?: number | null;
  /**
   * The model's input modalities, when known. Images and audio in *earlier* messages go as a short note to a
   * model that cannot take them (after a mid-chat switch); the message being answered is sent as it is.
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
}

/** Output assumed by estimates and kept free in the context when Max tokens is not set. */
export const DEFAULT_OUTPUT_TOKENS = 4096;

/** Per-message overhead (role markers) in the token approximation. */
const MESSAGE_OVERHEAD = 4;

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/** Rough token cost of one attachment as the model sees it. */
export function attachmentTokens(ref: AttachmentRef): number {
  switch (ref.kind) {
    case 'text':
      return approxTokens(ref.text ?? '') + 10;
    case 'image':
      return 1500;
    case 'pdf':
      // Parsed to text: about a page of text per 50 KB of a text PDF, far less for scans.
      return Math.max(1000, Math.ceil(ref.size / 50));
    case 'audio':
      // ~32 tokens per second at ~16 KB per second of MP3.
      return Math.max(200, Math.ceil(ref.size / 500));
  }
}

export function nodeTokens(node: ChatNode): number {
  const attachments = (node.attachments ?? []).reduce((sum, ref) => sum + attachmentTokens(ref), 0);
  return approxTokens(node.content) + attachments + MESSAGE_OVERHEAD;
}

/** True when a reply has something to send back as context (failed replies with no text are skipped). */
const hasContent = (node: ChatNode): boolean =>
  node.role === 'user' || node.content.trim().length > 0;

/**
 * One user message as wire content: a plain string, or the text part first, then one part per attachment.
 * `takes(kind)` false turns an image or audio attachment into a note (the model cannot read it).
 */
export function userContent(
  node: Pick<ChatNode, 'content' | 'attachments'>,
  data: (id: string) => string | undefined,
  takes: (modality: 'image' | 'audio') => boolean = () => true,
): string | ContentPart[] {
  const attachments = node.attachments ?? [];
  if (attachments.length === 0) return node.content;
  return [
    ...(node.content ? [{ type: 'text' as const, text: node.content }] : []),
    ...attachments.map((ref) =>
      (ref.kind === 'image' || ref.kind === 'audio') && !takes(ref.kind)
        ? {
            type: 'text' as const,
            text: `[${ref.kind === 'image' ? 'Image' : 'Audio'} "${ref.name}" not sent: this model cannot read it.]`,
          }
        : toContentPart(ref, data(ref.id)),
    ),
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
  const completionTokens =
    options.maxTokens ??
    Math.min(options.maxCompletionTokens ?? DEFAULT_OUTPUT_TOKENS, DEFAULT_OUTPUT_TOKENS);

  let trimmed = 0;
  if (options.contextLength && options.contextLength > 0) {
    // Leave room for the answer and a margin for the approximation.
    const budget =
      Math.floor(options.contextLength * 0.95) -
      Math.min(completionTokens, Math.floor(options.contextLength / 2)) -
      systemTokens;
    trimmed = trimToBudget(
      tokens,
      turns.map((node) => node.role),
      budget,
    );
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
            content: userContent(node, data, index === kept.length - 1 ? undefined : takes),
          }
        : { role: 'assistant', content: node.content },
    ),
  ];
  const hasPdf = kept.some((node) =>
    (node.attachments ?? []).some((ref) => ref.kind === 'pdf' && data(ref.id) !== undefined),
  );
  const body: ChatRequest = {
    model: options.model,
    ...(options.fallbacks.length > 0 ? { models: options.fallbacks } : {}),
    messages,
    ...(options.temperature !== null ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== null ? { max_tokens: options.maxTokens } : {}),
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    ...(hasPdf ? { plugins: [{ id: 'file-parser', pdf: { engine: options.pdfEngine } }] } : {}),
  };
  return {
    body,
    trimmed,
    promptTokens: systemTokens + tokens.slice(trimmed).reduce((sum, value) => sum + value, 0),
    completionTokens,
  };
}
