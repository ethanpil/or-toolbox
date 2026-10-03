/**
 * Server-sent events reader for OpenRouter streams (chat, music, image partials).
 *
 * Follows the SSE line grammar: lines end in LF, CRLF or CR; `:` starts a comment (`: OPENROUTER PROCESSING`
 * keep-alives and the bare `: ` lines image streams send); several `data:` lines join with "\n"; a blank line
 * dispatches. Bytes are decoded with a streaming TextDecoder, so chunks may split anywhere, including inside a
 * multi-byte character. Only the newly arrived text is scanned for line breaks, so a single multi-megabyte line
 * (Lyria sends the whole MP3 as one `data:` line, docs/openrouter-api.md §6.2) costs linear time.
 */

import { NetworkError } from '../errors';
import { abortError } from './retry';

export interface SseEvent {
  /** `event:` field, or null for the default `message` type. */
  event: string | null;
  data: string;
  /** Last `id:` seen, or null. */
  id: string | null;
}

/** Return `'stop'` from the handler to stop reading (e.g. after `data: [DONE]`). */
export type SseHandler = (event: SseEvent) => void | 'stop';

const LINE_BREAK = /[\r\n]/g;

/** Incremental parser: feed decoded text with `push`, then call `end` once. */
export class SseParser {
  /** Pieces of the current, not yet terminated line. */
  private pending: string[] = [];
  /** The previous chunk ended with CR, so a leading LF in the next chunk belongs to it. */
  private afterCr = false;
  private data: string[] = [];
  private eventName: string | null = null;
  private lastId: string | null = null;
  private stopped = false;
  private readonly handler: SseHandler;

  constructor(handler: SseHandler) {
    this.handler = handler;
  }

  /** True once the handler returned `'stop'`. */
  get done(): boolean {
    return this.stopped;
  }

  push(text: string): void {
    let start = 0;
    if (this.afterCr) {
      this.afterCr = false;
      if (text.startsWith('\n')) start = 1;
    }
    LINE_BREAK.lastIndex = start;
    while (!this.stopped) {
      const match = LINE_BREAK.exec(text);
      if (!match) break;
      const index = match.index;
      const piece = text.slice(start, index);
      const line = this.pending.length > 0 ? this.pending.join('') + piece : piece;
      this.pending = [];
      if (text[index] === '\r') {
        if (index + 1 === text.length) {
          this.afterCr = true;
          start = index + 1;
        } else {
          start = text[index + 1] === '\n' ? index + 2 : index + 1;
        }
      } else {
        start = index + 1;
      }
      LINE_BREAK.lastIndex = start;
      this.line(line);
    }
    if (!this.stopped && start < text.length) this.pending.push(text.slice(start));
  }

  /** Flushes a final unterminated line and dispatches a final event that lacks its blank line (lenient). */
  end(): void {
    if (this.stopped) return;
    if (this.pending.length > 0) {
      const line = this.pending.join('');
      this.pending = [];
      this.line(line);
    }
    this.dispatch();
  }

  private line(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventName = value;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0) {
      this.eventName = null;
      return;
    }
    const event: SseEvent = { event: this.eventName, data: this.data.join('\n'), id: this.lastId };
    this.data = [];
    this.eventName = null;
    if (this.handler(event) === 'stop') this.stopped = true;
  }
}

/**
 * Reads an SSE body to the end (or until the handler returns `'stop'`). Rejects with an AbortError when `signal`
 * aborts, with NetworkError when the connection drops, and with whatever the handler throws (the stream is then
 * cancelled).
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  handler: SseHandler,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SseParser(handler);
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  if (signal?.aborted) {
    onAbort();
    throw abortError();
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw new NetworkError('The connection dropped while the response was streaming.', {
          cause: error,
        });
      }
      if (signal?.aborted) throw abortError();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
      if (parser.done) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    parser.push(decoder.decode());
    parser.end();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancel() in some engines.
    }
  }
}
