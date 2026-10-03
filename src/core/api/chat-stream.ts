/**
 * Turns parsed chat-completion chunks into normalised ChatStreamEvents and assembles the ChatStreamResult
 * (docs/openrouter-api.md §2.3, §6.2).
 *
 * - `delta.content: ""` arrives on every chunk and means nothing; reasoning models stream `delta.reasoning` first.
 * - The terminal `finish_reason` appears twice (the second chunk carries `usage`); `finish` is emitted once.
 * - Audio arrives as base64 fragments in `delta.audio.data`; Lyria sends the whole MP3 as one fragment. Fragments
 *   are kept as-is (never concatenated here) so a 6 MB chunk is not copied.
 * - An `error` object on a chunk is a mid-stream failure: `push` throws an ApiError with `detail.midStream`.
 */

import type { ApiError } from '../errors';
import { apiErrorFromBody, bodyError, statusFromCode } from './error-map';
import type { ChatStreamEvent, ChatStreamResult, WireUsage } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

  push(chunk: unknown): void {
    if (!isRecord(chunk)) return;

    if (!this.metaSent && (str(chunk['id']) || str(chunk['model']))) {
      this.id = str(chunk['id']) ?? '';
      this.model = str(chunk['model']) ?? '';
      this.provider = str(chunk['provider']);
      this.metaSent = true;
      this.onEvent({
        type: 'meta',
        id: this.id,
        model: this.model,
        ...(this.provider ? { provider: this.provider } : {}),
      });
    }

    if (isRecord(chunk['usage'])) this.usage = chunk['usage'];

    const error = bodyError(chunk);
    if (error) throw this.midStreamError(chunk, error);

    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] : [];
    const choice: unknown = choices[0];
    if (isRecord(choice)) {
      const delta = choice['delta'];
      if (isRecord(delta)) this.delta(delta);
      const reason = str(choice['finish_reason']);
      if (reason && this.finishReason === null) {
        this.finishReason = reason;
        this.onEvent({ type: 'finish', reason });
      }
    }

    if (isRecord(chunk['usage'])) this.onEvent({ type: 'usage', usage: this.usage as WireUsage });
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
    };
  }

  private delta(delta: Record<string, unknown>): void {
    const reasoning = str(delta['reasoning']);
    if (reasoning) {
      this.reasoning.push(reasoning);
      this.onEvent({ type: 'reasoning', text: reasoning });
    }
    const content = str(delta['content']);
    if (content) {
      this.text.push(content);
      this.onEvent({ type: 'text', text: content });
    }
    const images = delta['images'];
    if (Array.isArray(images)) {
      for (const image of images) {
        const url =
          isRecord(image) && isRecord(image['image_url']) ? image['image_url']['url'] : '';
        if (typeof url === 'string' && url) {
          this.images.push(url);
          this.onEvent({ type: 'image', url });
        }
      }
    }
    const audio = delta['audio'];
    if (isRecord(audio)) {
      const data = str(audio['data']) ?? '';
      const transcript = str(audio['transcript']);
      if (data) this.audioChunks.push(data);
      if (transcript) this.transcript.push(transcript);
      if (data || transcript) {
        this.onEvent({ type: 'audio', data, ...(transcript ? { transcript } : {}) });
      }
    }
  }

  private midStreamError(chunk: Record<string, unknown>, error: Record<string, unknown>): ApiError {
    return apiErrorFromBody(
      statusFromCode(error['code']),
      { error },
      {
        midStream: true,
        generationId: this.generationId ?? str(chunk['id']) ?? null,
        providerName: str(chunk['provider']) ?? null,
      },
    );
  }
}
