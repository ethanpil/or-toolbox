/**
 * The request each contender gets: the same system prompt, prompt and files for every model (the files as
 * content parts, PDFs through the `file-parser` plugin), the temperature when set. Only the model differs, and
 * with it the limits: the estimate assumes the model's output cap (at most DEFAULT_OUTPUT_TOKENS), and a prompt
 * that does not fit a model's context window is refused before the round.
 */
import type { ChatMessage, ChatRequest, ContentPart } from '../../core/api/types';
import { type AttachmentRef, toContentPart } from '../../core/attachments/attachments';
import {
  approxTokens,
  attachmentTokens,
  MESSAGE_OVERHEAD,
  needsParser,
} from '../../core/attachments/request';
import type { PdfEngineId } from '../../core/models/pdf-engines';
import type { ModelInfo } from '../../core/types';

/** Output an estimate assumes, and keeps free in the context window, when the model's own cap is larger. */
export const DEFAULT_OUTPUT_TOKENS = 4096;

export interface ArenaInput {
  prompt: string;
  system: string;
  temperature: number | null;
  pdfEngine: PdfEngineId;
  attachments: readonly AttachmentRef[];
  /** An attachment's data URL (images, PDFs, audio), from memory. */
  data: (id: string) => string | undefined;
}

export interface ContenderRequest {
  body: ChatRequest;
  /** Approximate prompt tokens of what is sent. */
  promptTokens: number;
  /** The output tokens an estimate assumes. */
  completionTokens: number;
  /** The prompt alone does not fit the model's context window: do not send. */
  tooLong: boolean;
  /** PDFs this request sends to the parser (their parser text comes back in the stream's annotations). */
  parses: AttachmentRef[];
}

/** The user message: the prompt alone, or the prompt first and one part per file. */
export function userContent(input: ArenaInput): string | ContentPart[] {
  if (input.attachments.length === 0) return input.prompt;
  const parts = input.attachments
    .map((ref) => toContentPart(ref, input.data(ref.id)))
    .filter((part): part is ContentPart => part !== null);
  return [...(input.prompt ? [{ type: 'text' as const, text: input.prompt }] : []), ...parts];
}

/** Approximate prompt tokens of the round's input (the same for every contender). */
export function inputTokens(input: Omit<ArenaInput, 'data' | 'pdfEngine'>): number {
  const system = input.system.trim();
  return (
    (system ? approxTokens(system) + MESSAGE_OVERHEAD : 0) +
    approxTokens(input.prompt) +
    input.attachments.reduce((sum, ref) => sum + attachmentTokens(ref), 0) +
    MESSAGE_OVERHEAD
  );
}

export function contenderRequest(
  model: string,
  info: ModelInfo | undefined,
  input: ArenaInput,
): ContenderRequest {
  const system = input.system.trim();
  const promptTokens = inputTokens(input);
  const cap =
    info?.maxCompletionTokens && info.maxCompletionTokens > 0
      ? info.maxCompletionTokens
      : Number.POSITIVE_INFINITY;
  const wanted = Math.min(cap, DEFAULT_OUTPUT_TOKENS);
  let completionTokens = wanted;
  let tooLong = false;
  const context = info?.contextLength;
  if (context && context > 0) {
    // As in Chat: room for an answer and a margin for the approximation.
    tooLong = promptTokens > Math.floor(context * 0.95) - Math.min(wanted, Math.floor(context / 2));
    completionTokens = Math.max(1, Math.min(wanted, context - promptTokens));
  }
  const messages: ChatMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    { role: 'user', content: userContent(input) },
  ];
  const sendsFile = messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'file'),
  );
  return {
    body: {
      model,
      messages,
      ...(input.temperature !== null ? { temperature: input.temperature } : {}),
      ...(sendsFile ? { plugins: [{ id: 'file-parser', pdf: { engine: input.pdfEngine } }] } : {}),
    },
    promptTokens,
    completionTokens,
    tooLong,
    parses:
      input.pdfEngine === 'native'
        ? []
        : input.attachments.filter((ref) => needsParser(ref, input.data)),
  };
}
