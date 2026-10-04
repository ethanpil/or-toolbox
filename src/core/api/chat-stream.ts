/**
 * Turns parsed chat-completion chunks into normalised ChatStreamEvents and assembles the ChatStreamResult
 * (docs/openrouter-api.md §2.3, §6.2).
 *
 * - `delta.content: ""` arrives on every chunk and means nothing; reasoning models stream `delta.reasoning` first.
 * - The terminal `finish_reason` appears twice (the second chunk carries `usage`); `finish` is emitted once.
 * - Audio arrives as base64 fragments in `delta.audio.data`; Lyria sends the whole MP3 as one fragment. Fragments
 *   are kept as-is (never concatenated here) so a 6 MB chunk is not copied.
 * - An `error` object on a chunk is a mid-stream failure: `push` throws an ApiError with `detail.midStream`.
 * - `delta.annotations` (the PDF parser's text, citations) are collected for the result, not emitted as events.
 */

import type { ApiError } from '../errors';
import { isRecord, isString } from '../util';
import { apiErrorFromBody, bodyError, statusFromCode } from './error-map';
import type { ChatStreamEvent, ChatStreamResult, WireUsage } from './types';

/** What each failed stream had delivered, keyed by the error it failed with. */
const partials = new WeakMap<object, ChatStreamResult>();

/**
 * Records what a stream delivered before it failed on the error it failed with, and returns the error. Used by
 * `chatStream`; test fakes call it too.
 */
export function withPartialResult<E>(error: E, result: ChatStreamResult): E {
  if (typeof error === 'object' && error !== null) partials.set(error, result);
  return error;
}

/**
 * What a `chatStream` call had assembled when it failed (a dropped connection, a mid-stream error chunk, Stop),
 * or null for any other error. The error is still the outcome: this is for keeping work that arrived complete
 * before it, such as a song whose audio came in one piece before the connection broke.
 */
export function partialStreamResult(error: unknown): ChatStreamResult | null {
  return typeof error === 'object' && error !== null ? (partials.get(error) ?? null) : null;
}

export class ChatStreamAssembler {
  private id = '';
  private model = '';
  private provider: string | undefined;
  private metaSent = false;
  private text: string[] = [];
  private reasoning: string[] = [];
  private images: string[] = [];
  private audioChunks: string[] = [];
  private transcript: string[] = [];
  private annotations: Record<string, unknown>[] = [];
  private finishReason: string | null = null;
  private usage: WireUsage | null = null;
  private readonly onEvent: (event: ChatStreamEvent) => void;
  private readonly generationId: string | null;

  constructor(onEvent: (event: ChatStreamEvent) => void, generationId: string | null = null) {
    this.onEvent = onEvent;
    this.generationId = generationId;
  }

  /** Usage seen so far (also after a mid-stream error, if the error chunk carried it). */
  get lastUsage(): WireUsage | null {
    return this.usage;
  }

  /** True once a terminal `finish_reason` arrived. */
  get finished(): boolean {
    return this.finishReason !== null;
  }

  push(chunk: unknown): void {
    if (!isRecord(chunk)) return;
    const id = chunk['id'];
    const model = chunk['model'];
    const provider = chunk['provider'];

    if (!this.metaSent && ((isString(id) && id) || (isString(model) && model))) {
      this.id = isString(id) ? id : '';
      this.model = isString(model) ? model : '';
      this.provider = isString(provider) ? provider : undefined;
      this.metaSent = true;
      this.onEvent({
        type: 'meta',
        id: this.id,
        model: this.model,
        ...(this.provider ? { provider: this.provider } : {}),
      });
    }

    const usage = chunk['usage'];
    if (isRecord(usage)) this.usage = usage;

    const error = bodyError(chunk);
    if (error) {
      throw apiErrorFromBody(
        statusFromCode(error['code']),
        { error },
        {
          midStream: true,
          generationId: this.generationId ?? (isString(id) ? id : null),
          providerName: isString(provider) ? provider : null,
        },
      ) satisfies ApiError;
    }

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    const choice: unknown = choices[0];
    if (isRecord(choice)) {
      const delta = choice['delta'];
      if (isRecord(delta)) this.delta(delta);
      const reason = choice['finish_reason'];
      if (isString(reason) && reason && this.finishReason === null) {
        this.finishReason = reason;
        this.onEvent({ type: 'finish', reason });
      }
    }

    if (isRecord(usage)) this.onEvent({ type: 'usage', usage });
  }

  result(): ChatStreamResult {
    return {
      id: this.id,
      model: this.model,
      ...(this.provider ? { provider: this.provider } : {}),
      text: this.text.join(''),
      reasoning: this.reasoning.join(''),
      images: [...this.images],
      audioChunks: [...this.audioChunks],
      audioTranscript: this.transcript.join(''),
      finishReason: this.finishReason,
      usage: this.usage,
      ...(this.annotations.length > 0 ? { annotations: [...this.annotations] } : {}),
    };
  }

  private delta(delta: Record<string, unknown>): void {
    const reasoning = delta['reasoning'];
    if (isString(reasoning) && reasoning) {
      this.reasoning.push(reasoning);
      this.onEvent({ type: 'reasoning', text: reasoning });
    }
    const content = delta['content'];
    if (isString(content) && content) {
      this.text.push(content);
      this.onEvent({ type: 'text', text: content });
    }
    const images = delta['images'];
    if (Array.isArray(images)) {
      for (const image of images) {
        const url =
          isRecord(image) && isRecord(image['image_url']) ? image['image_url']['url'] : '';
        if (isString(url) && url) {
          this.images.push(url);
          this.onEvent({ type: 'image', url });
        }
      }
    }
    const annotations = delta['annotations'];
    if (Array.isArray(annotations)) this.annotations.push(...annotations.filter(isRecord));
    const audio = delta['audio'];
    if (isRecord(audio)) {
      const data = isString(audio['data']) ? audio['data'] : '';
      const transcript = isString(audio['transcript']) ? audio['transcript'] : '';
      if (data) this.audioChunks.push(data);
      if (transcript) this.transcript.push(transcript);
      if (data || transcript) {
        this.onEvent({ type: 'audio', data, ...(transcript ? { transcript } : {}) });
      }
    }
  }
}
