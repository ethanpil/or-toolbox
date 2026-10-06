import { describe, expect, it } from 'vitest';
import chatStream from '../../../tests/fixtures/openrouter/chat-stream.recorded.sse.txt?raw';
import jsonSchemaStream from '../../../tests/fixtures/openrouter/chat-stream-json-schema.recorded.sse.txt?raw';
import reasoningLength from '../../../tests/fixtures/openrouter/chat-stream-reasoning-length.recorded.sse.txt?raw';
import lyriaClip from '../../../tests/fixtures/openrouter/music-lyria-clip.recorded.sse.txt?raw';
import lyriaClipImage from '../../../tests/fixtures/openrouter/music-lyria-clip-image-wav.recorded.sse.txt?raw';
import lyriaPro from '../../../tests/fixtures/openrouter/music-lyria-pro.recorded.sse.txt?raw';
import audioDocumented from '../../../tests/fixtures/openrouter/chat-stream-audio.documented.json';
import midStreamDocumented from '../../../tests/fixtures/openrouter/chat-stream-midstream-error.documented.json';
import { ApiError, RateLimitError } from '../errors';
import { ChatStreamAssembler } from './chat-stream';
import { SseParser } from './sse';
import type { ChatStreamEvent } from './types';

function chunksOf(text: string): unknown[] {
  const chunks: unknown[] = [];
  const parser = new SseParser((event) => {
    if (event.data !== '[DONE]') chunks.push(JSON.parse(event.data));
  });
  parser.push(text);
  parser.end();
  return chunks;
}

function assemble(text: string): { events: ChatStreamEvent[]; assembler: ChatStreamAssembler } {
  const events: ChatStreamEvent[] = [];
  const assembler = new ChatStreamAssembler((event) => events.push(event));
  for (const chunk of chunksOf(text)) assembler.push(chunk);
  return { events, assembler };
}

describe('ChatStreamAssembler', () => {
  it('assembles the recorded reasoning + text stream', () => {
    const { events, assembler } = assemble(chatStream);
    const result = assembler.result();
    expect(events[0]).toEqual({
      type: 'meta',
      id: 'gen-1790981416-f0MwbDBlx1LOFOgfDoxv',
      model: 'liquid/lfm-2.5-2.6b:free',
      provider: 'Liquid',
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toBe(
      events
        .filter((e) => e.type === 'text')
        .map((e) => e.text)
        .join(''),
    );
    expect(result.reasoning.length).toBeGreaterThan(0);
    // Reasoning streams before any visible content.
    expect(events.findIndex((e) => e.type === 'reasoning')).toBeLessThan(
      events.findIndex((e) => e.type === 'text'),
    );
    // The terminal finish_reason arrives twice but is reported once.
    expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'stop' }]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.cost).toBe(0);
    expect(result.usage?.completion_tokens_details?.reasoning_tokens).toBe(52);
    expect(events.at(-1)?.type).toBe('usage');
  });

  it('assembles valid JSON from a structured-output stream', () => {
    const result = assemble(jsonSchemaStream).assembler.result();
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['conditions', 'location', 'temperature']);
  });

  it('reports a length stop with empty content when reasoning used the budget', () => {
    const result = assemble(reasoningLength).assembler.result();
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('length');
    expect(result.reasoning.length).toBeGreaterThan(1000);
    expect(result.usage?.completion_tokens).toBe(600);
  });

  it('keeps Lyria timed lyrics as text and the single audio chunk as one fragment', () => {
    const { events, assembler } = assemble(lyriaClip);
    const result = assembler.result();
    expect(result.text.startsWith('[0.0:3.7] HELLO WORLD, HELLO DAY')).toBe(true);
    expect(result.audioChunks).toHaveLength(1);
    expect(result.audioChunks[0]?.startsWith('SUQzAw')).toBe(true);
    expect(events.filter((e) => e.type === 'audio')).toHaveLength(1);
    expect(result.audioTranscript).toBe('');
    expect(result.usage?.cost).toBe(0.04);

    const pro = assemble(lyriaPro).assembler.result();
    expect(pro.text.startsWith('[[A0]]')).toBe(true);
    expect(pro.audioChunks).toHaveLength(1);
    expect(pro.usage?.cost).toBe(0.08);

    expect(assemble(lyriaClipImage).assembler.result().text).toBe('<instrumental>');
  });

  it('collects multi-fragment audio with transcripts (speech-chat models)', () => {
    const result = assemble(audioDocumented.lines.join('\n')).assembler.result();
    expect(result.audioChunks).toEqual([
      'UklGRiQAAABXQVZF',
      'Zm10IBAAAAABAAEA',
      'QB8AAIA+AAACABAA',
    ]);
    expect(result.audioTranscript).toBe('Hello there');
    expect(result.usage?.cost).toBe(0.00025);
  });

  it('turns a mid-stream error chunk into an ApiError after the partial text', () => {
    const events: ChatStreamEvent[] = [];
    const assembler = new ChatStreamAssembler((e) => events.push(e), 'gen-header-id');
    const [first, second] = chunksOf(midStreamDocumented.lines.join('\n'));
    assembler.push(first);
    expect(assembler.result().text).toBe('Partial ');
    let error: unknown;
    try {
      assembler.push(second);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RateLimitError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(429);
    expect(apiError.detail.midStream).toBe(true);
    expect(apiError.detail.errorType).toBe('rate_limit_exceeded');
    expect(apiError.detail.generationId).toBe('gen-header-id');
    expect(apiError.detail.providerName).toBe('OpenAI');
  });

  it('treats an error as the first and only chunk as a failure', () => {
    const assembler = new ChatStreamAssembler(() => undefined);
    expect(() =>
      assembler.push({ id: 'x', error: { code: 'server_error', message: 'boom' }, choices: [] }),
    ).toThrow(ApiError);
  });

  it('emits chat-route image deltas', () => {
    const events: ChatStreamEvent[] = [];
    const assembler = new ChatStreamAssembler((e) => events.push(e));
    assembler.push({
      id: 'g',
      model: 'm',
      choices: [{ delta: { images: [{ image_url: { url: 'data:image/png;base64,AA==' } }] } }],
    });
    expect(assembler.result().images).toEqual(['data:image/png;base64,AA==']);
    expect(events).toContainEqual({ type: 'image', url: 'data:image/png;base64,AA==' });
  });

  it('keeps the annotations of streamed deltas (the PDF parser’s text), in order', () => {
    const assembler = new ChatStreamAssembler(() => undefined);
    const file = { type: 'file', file: { hash: 'h', name: 'a.pdf', content: [] } };
    const cite = { type: 'url_citation', url_citation: { url: 'https://example.com' } };
    assembler.push({ id: 'g', model: 'm', choices: [{ delta: { content: 'Hi' } }] });
    expect(assembler.result().annotations).toBeUndefined();
    assembler.push({ choices: [{ delta: { annotations: [file, 'junk'] } }] });
    assembler.push({ choices: [{ delta: { annotations: [cite] } }] });
    expect(assembler.result().annotations).toEqual([file, cite]);
  });

  it('shows a streamed refusal as the reply text and names it', () => {
    const events: ChatStreamEvent[] = [];
    const assembler = new ChatStreamAssembler((e) => events.push(e));
    assembler.push({
      id: 'g',
      model: 'm',
      choices: [{ delta: { content: '', refusal: 'I can' } }],
    });
    assembler.push({
      choices: [{ delta: { refusal: '’t help with that.' }, finish_reason: 'stop' }],
    });
    const result = assembler.result();
    expect(result.text).toBe('I can’t help with that.');
    expect(result.refusal).toBe('I can’t help with that.');
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual([
      'I can',
      '’t help with that.',
    ]);
  });

  it.each([
    ['content_filter', /content filter/],
    ['error', /stopped with an error/],
  ])('explains a reply that ended with %s and no content', (reason, message) => {
    const assembler = new ChatStreamAssembler(() => undefined);
    assembler.push({ id: 'g', model: 'm', choices: [{ delta: { content: '' } }] });
    assembler.push({ choices: [{ delta: {}, finish_reason: reason }] });
    const result = assembler.result();
    expect(result.text).toBe('');
    expect(result.refusal).toMatch(message);
  });

  it('names no refusal for a normal reply, or a filtered one that still has content', () => {
    const assembler = new ChatStreamAssembler(() => undefined);
    assembler.push({ id: 'g', model: 'm', choices: [{ delta: { content: 'Hi' } }] });
    expect(assembler.result().refusal).toBeUndefined();
    assembler.push({ choices: [{ delta: {}, finish_reason: 'content_filter' }] });
    expect(assembler.result().refusal).toBeUndefined();
    expect(assembler.result().finishReason).toBe('content_filter');
  });
});
