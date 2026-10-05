import { describe, expect, it, vi } from 'vitest';
import chatStream from '../../../tests/fixtures/openrouter/chat-stream.recorded.sse.txt?raw';
import jsonSchemaStream from '../../../tests/fixtures/openrouter/chat-stream-json-schema.recorded.sse.txt?raw';
import imagesStream from '../../../tests/fixtures/openrouter/images-stream.recorded.sse.txt?raw';
import lyriaPro from '../../../tests/fixtures/openrouter/music-lyria-pro.recorded.sse.txt?raw';
import documented from '../../../tests/fixtures/openrouter/chat-stream.documented.json';
import { isAbortError, NetworkError } from '../errors';
import { readSse, SseParser, STREAM_IDLE_MS, type SseEvent } from './sse';

const encoder = new TextEncoder();

function parseText(text: string, chunkSizes?: number[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => {
    events.push(event);
  });
  if (!chunkSizes) {
    parser.push(text);
  } else {
    let offset = 0;
    let i = 0;
    while (offset < text.length) {
      const size = chunkSizes[i++ % chunkSizes.length] ?? 1;
      parser.push(text.slice(offset, offset + size));
      offset += size;
    }
  }
  parser.end();
  return events;
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** Splits bytes into pieces of pseudo-random sizes (deterministic). */
function splitBytes(bytes: Uint8Array, seed: number, maxSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let state = seed;
  let offset = 0;
  while (offset < bytes.length) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    const size = 1 + (state % maxSize);
    chunks.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return chunks;
}

async function readAll(chunks: Uint8Array[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await readSse(streamOf(chunks), (event) => {
    events.push(event);
  });
  return events;
}

describe('SseParser', () => {
  it('parses the recorded chat stream: one event per data line, ending in [DONE]', () => {
    const events = parseText(chatStream);
    const dataLines = chatStream.split('\n').filter((line) => line.startsWith('data: ')).length;
    expect(events).toHaveLength(dataLines);
    expect(events.at(-1)?.data).toBe('[DONE]');
    for (const event of events.slice(0, -1)) {
      expect(() => JSON.parse(event.data) as unknown).not.toThrow();
    }
  });

  it('skips keep-alive comments, including bare ": " lines', () => {
    expect(parseText(documented.lines.join('\n'))[0]?.data).toMatch(/^\{"id"/);
    const images = parseText(imagesStream);
    const typeOf = (data: string): string =>
      data === '[DONE]' ? data : (JSON.parse(data) as { type: string }).type;
    expect(images.map((e) => typeOf(e.data))).toEqual([
      'image_generation.partial_image',
      'image_generation.completed',
      '[DONE]',
    ]);
    const lyria = parseText(lyriaPro);
    expect(lyria.every((e) => !e.data.startsWith(':'))).toBe(true);
    expect(lyria.at(-1)?.data).toBe('[DONE]');
  });

  it('joins multi-line data with \\n and reads event and id fields', () => {
    const events = parseText('event: update\nid: 7\ndata: {"a":\ndata: 1}\n\ndata:no-space\n\n');
    expect(events).toEqual([
      { event: 'update', id: '7', data: '{"a":\n1}' },
      { event: null, id: '7', data: 'no-space' },
    ]);
  });

  it('accepts CRLF and lone CR line endings, even when CRLF is split across chunks', () => {
    const text = 'data: one\r\n\r\ndata: two\r\rdata: three\r\n\r\n';
    const expected = ['one', 'two', 'three'];
    expect(parseText(text).map((e) => e.data)).toEqual(expected);
    expect(parseText(text, [1]).map((e) => e.data)).toEqual(expected);
    expect(parseText(text, [10, 1, 3]).map((e) => e.data)).toEqual(expected);
  });

  it('dispatches a final event that lacks its blank line', () => {
    expect(parseText('data: last').map((e) => e.data)).toEqual(['last']);
  });

  it('gives the same events for any chunking of the recorded streams', () => {
    for (const text of [chatStream, jsonSchemaStream]) {
      const whole = parseText(text);
      expect(parseText(text, [1])).toEqual(whole);
      expect(parseText(text, [7, 300, 2, 64])).toEqual(whole);
    }
  });

  it('stops dispatching after the handler returns "stop"', () => {
    const seen: string[] = [];
    const parser = new SseParser((event) => {
      seen.push(event.data);
      return event.data === '[DONE]' ? 'stop' : undefined;
    });
    parser.push('data: a\n\ndata: [DONE]\n\ndata: after\n\n');
    parser.end();
    expect(seen).toEqual(['a', '[DONE]']);
    expect(parser.done).toBe(true);
  });

  it('handles a multi-megabyte single line in linear time', () => {
    const big = 'A'.repeat(6_000_000);
    const text = `data: {"audio":"${big}"}\n\ndata: [DONE]\n\n`;
    const started = performance.now();
    const events = parseText(text, [65_536]);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(events).toHaveLength(2);
    expect(events[0]?.data.length).toBe(big.length + 12);
  });
});

describe('readSse', () => {
  it('decodes byte chunks split at arbitrary positions, including inside UTF-8 sequences', async () => {
    const text = `: OPENROUTER PROCESSING\n\ndata: {"t":"héllo 🌍 — 日本語"}\n\ndata: [DONE]\n\n`;
    const bytes = encoder.encode(text);
    const expected = parseText(text);
    for (let cut = 1; cut < bytes.length; cut++) {
      const events = await readAll([bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect(events).toEqual(expected);
    }
    expect(await readAll(splitBytes(bytes, 1, 1))).toEqual(expected);
    expect((JSON.parse(expected[0]?.data ?? '') as { t: string }).t).toBe('héllo 🌍 — 日本語');
  });

  it('reads the recorded chat stream from random byte chunks', async () => {
    const bytes = encoder.encode(jsonSchemaStream);
    const expected = parseText(jsonSchemaStream);
    for (const seed of [1, 2, 3]) {
      expect(await readAll(splitBytes(bytes, seed, 97))).toEqual(expected);
    }
  });

  it('gives up a stream that sends nothing for STREAM_IDLE_MS, but not one that keeps sending comments', async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const silent = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        },
        cancel() {
          cancelled = true;
        },
      });
      const events: string[] = [];
      const read = readSse(silent, (event) => {
        events.push(event.data);
      }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS + 1);
      const error = await read;
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as Error).message).toBe(
        'Nothing arrived for 5 minutes, so the connection was closed.',
      );
      expect(events).toEqual(['{"a":1}']);
      expect(cancelled).toBe(true);

      // Keep-alive comments every 4 minutes for 20 minutes: slow, but alive.
      let push: ((text: string) => void) | null = null;
      let close: (() => void) | null = null;
      const slow = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(encoder.encode(text));
          close = () => controller.close();
        },
      });
      const done = readSse(slow, () => undefined);
      for (let sent = 0; sent < 5; sent++) {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        push!(': OPENROUTER PROCESSING\n\n');
      }
      close!();
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the stream and stops after "stop"', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await readSse(stream, (event) => (event.data === '[DONE]' ? 'stop' : undefined));
    expect(cancelled).toBe(true);
  });

  it('rejects with AbortError and cancels the body when the signal aborts', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const seen: string[] = [];
    const reading = readSse(
      stream,
      (event) => {
        seen.push(event.data);
        controller.abort();
      },
      controller.signal,
    );
    const error: unknown = await reading.catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(seen).toEqual(['first']);
    expect(cancelled).toBe(true);
  });

  it('rejects immediately for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const error: unknown = await readSse(streamOf([]), () => undefined, controller.signal).catch(
      (e: unknown) => e,
    );
    expect(isAbortError(error)).toBe(true);
  });

  it('propagates handler errors and cancels the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: boom\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readSse(stream, () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(cancelled).toBe(true);
  });

  it('turns a dropped connection into NetworkError', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: partial\n\n'));
        controller.error(new TypeError('network'));
      },
    });
    await expect(readSse(stream, () => undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});
