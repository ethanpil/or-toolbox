import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import chatRecorded from '../../../tests/fixtures/openrouter/chat-completion.recorded.json';
import chatError200 from '../../../tests/fixtures/openrouter/chat-completion-error-200.documented.json';
import chatStreamText from '../../../tests/fixtures/openrouter/chat-stream.recorded.sse.txt?raw';
import midStream from '../../../tests/fixtures/openrouter/chat-stream-midstream-error.documented.json';
import cors from '../../../tests/fixtures/openrouter/cors-headers.json';
import credits from '../../../tests/fixtures/openrouter/credits.recorded.json';
import jev from '../../../tests/fixtures/openrouter/decisions-response-jev.recorded.json';
import jevRequest from '../../../tests/fixtures/openrouter/decisions-request.documented.json';
import authKeys from '../../../tests/fixtures/openrouter/auth-keys-response.documented.json';
import error401 from '../../../tests/fixtures/openrouter/error-401.json';
import error402Balance from '../../../tests/fixtures/openrouter/error-402-chat-image-balance.recorded.json';
import error402InFlight from '../../../tests/fixtures/openrouter/error-402-in-flight-budget.documented.json';
import error404Video from '../../../tests/fixtures/openrouter/error-404-video-job.recorded.json';
import error429 from '../../../tests/fixtures/openrouter/error-429-upstream-2.recorded.json';
import error400Model from '../../../tests/fixtures/openrouter/error-400-invalid-model.recorded.json';
import error502 from '../../../tests/fixtures/openrouter/error-502-provider.documented.json';
import imagesGenerate from '../../../tests/fixtures/openrouter/images-generate.recorded.json';
import imagesEdit from '../../../tests/fixtures/openrouter/images-edit.recorded.json';
import imagesStreamText from '../../../tests/fixtures/openrouter/images-stream.recorded.sse.txt?raw';
import imagesStreamError from '../../../tests/fixtures/openrouter/images-stream-error.documented.json';
import imagesModels from '../../../tests/fixtures/openrouter/images-models.json';
import keyRecorded from '../../../tests/fixtures/openrouter/key.documented.json';
import lyriaEndpoints from '../../../tests/fixtures/openrouter/model-endpoints.google-lyria-3-pro-preview.json';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import speechKokoro from '../../../tests/fixtures/openrouter/audio-speech-kokoro-pcm.recorded.json';
import sttVerbose from '../../../tests/fixtures/openrouter/audio-transcriptions-verbose.recorded.json';
import sttDeepgram from '../../../tests/fixtures/openrouter/audio-transcriptions-diarize-deepgram-options.recorded.json';
import sttAzure from '../../../tests/fixtures/openrouter/audio-transcriptions-diarize-azure-options.recorded.json';
import sttGrok from '../../../tests/fixtures/openrouter/audio-transcriptions-grok.recorded.json';
import videoSubmit from '../../../tests/fixtures/openrouter/videos-submit-202.recorded.json';
import videoPending from '../../../tests/fixtures/openrouter/videos-poll-pending.recorded.json';
import videoCompleted from '../../../tests/fixtures/openrouter/videos-poll-completed.recorded.json';
import videoFailed from '../../../tests/fixtures/openrouter/videos-poll-failed.documented.json';
import videosModels from '../../../tests/fixtures/openrouter/videos-models.json';
import { ApiError, NetworkError, RateLimitError, isAbortError } from '../errors';
import type { KeyInfo, KeysService, ModelsService } from '../types';
import { API_BASE, DECISIONS_URL, createApiClient, type ApiClientOptions } from './client';
import type { FreeModelThrottle } from './throttle';
import { fakeCore, fakeRun, type FakeRun } from './test-fakes';
import type { ChatRequest, ChatStreamEvent } from './types';

/** Fake test key: never matches the pre-commit hook's real-key pattern. */
const SECRET = `sk-or-v1-test${'x'.repeat(60)}`;
const SITE = 'https://ethanpil.github.io/or-toolbox/';
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';

type FetchMock = Mock<(input: string, init: RequestInit) => Promise<Response>>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function sse(text: string, headers: Record<string, string> = {}): Response {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });
}

/** The recorded fixtures truncate base64; put a decodable image back. */
function withRealBase64(text: string, b64: string): string {
  return text.replace(/"b64_json":"[^"]*"/g, `"b64_json":"${b64}"`);
}

interface Setup {
  fetch: FetchMock;
  run: FakeRun;
  keys: { secret: Mock; get: Mock };
  models: { estimate: Mock };
  throttle: { acquire: Mock };
  client: ReturnType<typeof createApiClient>;
}

function setup(
  responses: Array<Response | Error | (() => Response)>,
  opts: { noRetention?: boolean; options?: Partial<ApiClientOptions>; tool?: FakeRun['tool'] } = {},
): Setup {
  const queue = [...responses];
  const fetch: FetchMock = vi.fn((_input: string, init: RequestInit) => {
    const next = queue.shift();
    if (!next) return Promise.reject(new Error('unexpected fetch'));
    if (next instanceof Error) return Promise.reject(next);
    if (init.signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return Promise.resolve(typeof next === 'function' ? next() : next);
  });
  const info: KeyInfo = {
    id: 'key-1',
    name: 'Main',
    colour: null,
    masked: 'sk-or-…xxxx',
    source: 'pasted',
    createdAt: 0,
    noRetention: opts.noRetention ?? false,
    isDefault: true,
  };
  const keys = { secret: vi.fn(() => Promise.resolve(SECRET)), get: vi.fn(() => info) };
  const models = { estimate: vi.fn(() => Promise.resolve(0.000176)) };
  const throttle = { acquire: vi.fn(() => Promise.resolve()) };
  const core = fakeCore({
    keys: keys as unknown as KeysService,
    models: models as unknown as ModelsService,
  });
  const client = createApiClient(core, {
    fetch,
    siteUrl: SITE,
    retry: { random: () => 0 },
    throttle: throttle as unknown as FreeModelThrottle,
    ...opts.options,
  });
  return { fetch, run: fakeRun(opts.tool ?? 'chat'), keys, models, throttle, client };
}

function call(
  s: Setup,
  index = 0,
): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const args = s.fetch.mock.calls[index];
  if (!args) throw new Error(`no fetch call ${index}`);
  const [url, init] = args;
  const raw = init.body;
  return {
    url,
    init,
    body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {},
  };
}

function headers(s: Setup, index = 0): Record<string, string> {
  return call(s, index).init.headers as Record<string, string>;
}

const chatBody: ChatRequest = {
  model: 'openai/gpt-6-luna',
  messages: [{ role: 'user', content: 'ping' }],
};

describe('headers', () => {
  it('sends auth and attribution headers, all inside the CORS allow-list', async () => {
    const s = setup([json(chatRecorded, 200, { 'X-Generation-Id': 'gen-h' })]);
    await s.client.chat(chatBody, { run: s.run });
    const sent = headers(s);
    expect(sent).toEqual({
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE,
      'X-OpenRouter-Title': 'ORtoolbox',
      'X-OpenRouter-Categories': 'general-chat',
    });
    const allowed = cors.preflight_POST_api_alpha_decisions.headers['Access-Control-Allow-Headers']
      .toLowerCase()
      .split(',');
    for (const name of Object.keys(sent)) expect(allowed).toContain(name.toLowerCase());
    expect(call(s).init.credentials).toBe('omit');
    expect(s.keys.secret).toHaveBeenCalledWith('key-1');
  });

  it('omits categories for tools without a recognised one, and caps them at two', async () => {
    const s = setup([json(chatRecorded)], { tool: 'ocr' });
    await s.client.chat(chatBody, { run: s.run });
    expect(headers(s)['X-OpenRouter-Categories']).toBeUndefined();
    const b = setup([json(chatRecorded)], { tool: 'bot-to-bot' });
    await b.client.chat(chatBody, { run: b.run });
    expect(headers(b)['X-OpenRouter-Categories']?.split(',').length).toBeLessThanOrEqual(2);
  });

  it('sends keyless catalog reads without any custom header (no preflight)', async () => {
    const s = setup([json(modelsFixture)]);
    const models = await s.client.catalog.models();
    expect(models).toHaveLength(modelsFixture.data.length);
    expect(call(s).url).toBe(`${API_BASE}/models?output_modalities=all`);
    expect(call(s).init.headers).toEqual({});
    expect(s.keys.secret).not.toHaveBeenCalled();
  });

  it('never puts the key into errors', async () => {
    const s = setup([json(error401, 401)]);
    const error: unknown = await s.client.chat(chatBody, { run: s.run }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(JSON.stringify(error)).not.toContain('sk-or-v1-test');
    expect((error as Error).message).not.toContain('sk-or-v1-test');
  });
});

describe('no-retention keys', () => {
  it('adds data_collection deny to paid chat, speech, transcription and decisions', async () => {
    const s = setup(
      [
        json(chatRecorded),
        new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'audio/mpeg' } }),
        json(sttGrok),
        json(jev),
      ],
      { noRetention: true },
    );
    await s.client.chat({ ...chatBody, provider: { sort: 'price' } }, { run: s.run });
    await s.client.speech(
      { model: 'hexgrad/kokoro-82m', input: 'hi', voice: 'af_alloy' },
      { run: s.run },
    );
    await s.client.transcribe(
      {
        model: 'x-ai/grok-stt-1.0',
        audio: new Blob([new Uint8Array([1, 2])], { type: 'audio/mpeg' }),
      },
      { run: s.run },
    );
    await s.client.decide(jevRequest as Parameters<typeof s.client.decide>[0], { run: s.run });
    expect(call(s, 0).body['provider']).toEqual({ sort: 'price', data_collection: 'deny' });
    for (const i of [1, 2, 3])
      expect(call(s, i).body['provider']).toEqual({ data_collection: 'deny' });
  });

  it('never adds it for free models, which it would break (404 data policy)', async () => {
    const s = setup([json(chatRecorded), json(chatRecorded)], { noRetention: true });
    await s.client.chat({ ...chatBody, model: 'liquid/lfm-2.5-2.6b:free' }, { run: s.run });
    await s.client.chat({ ...chatBody, model: 'openrouter/free' }, { run: s.run });
    expect(call(s, 0).body['provider']).toBeUndefined();
    expect(call(s, 1).body['provider']).toBeUndefined();
  });

  it('keeps an explicit caller choice and skips /images and /videos', async () => {
    const s = setup(
      [
        json(chatRecorded),
        json(JSON.parse(withRealBase64(JSON.stringify(imagesGenerate.response), JPEG_B64))),
        json(videoSubmit, 202),
      ],
      { noRetention: true },
    );
    await s.client.chat({ ...chatBody, provider: { data_collection: 'allow' } }, { run: s.run });
    await s.client.images(
      { model: 'black-forest-labs/flux.2-klein-4b', prompt: 'x' },
      { run: s.run },
    );
    await s.client.videos.submit({ model: 'x-ai/grok-imagine-video', prompt: 'x' }, { run: s.run });
    expect(call(s, 0).body['provider']).toEqual({ data_collection: 'allow' });
    expect(call(s, 1).body['provider']).toBeUndefined();
    expect(call(s, 2).body['provider']).toBeUndefined();
  });

  it('leaves requests alone for ordinary keys', async () => {
    const s = setup([json(chatRecorded)]);
    await s.client.chat(chatBody, { run: s.run });
    expect(call(s).body['provider']).toBeUndefined();
  });
});

describe('retries', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('backs off with full jitter between attempts', async () => {
    const s = setup([json(error502, 502), json(error502, 502), json(chatRecorded)], {
      options: { retry: { random: () => 0.5 } },
    });
    const done = s.client.chat(chatBody, { run: s.run });
    await vi.advanceTimersByTimeAsync(0);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.fetch).toHaveBeenCalledTimes(3);
    await expect(done).resolves.toMatchObject({ id: chatRecorded.id });
  });

  it('waits exactly retry_after_seconds from the 429 body', async () => {
    const s = setup([json(error429, 429), json(chatRecorded)]);
    const done = s.client.chat(chatBody, { run: s.run });
    await vi.advanceTimersByTimeAsync(999);
    expect(s.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.fetch).toHaveBeenCalledTimes(2);
    await done;
  });

  it('gives up after three attempts', async () => {
    const s = setup([json(error502, 502), json(error502, 502), json(error502, 502)]);
    const done = s.client.chat(chatBody, { run: s.run }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await done;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect(s.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries network failures and the in-flight-budget 402, then surfaces NetworkError', async () => {
    const s = setup([
      json(error402InFlight, 402),
      new TypeError('fetch failed'),
      new TypeError('x'),
    ]);
    const done = s.client.chat(chatBody, { run: s.run }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await done).toBeInstanceOf(NetworkError);
    expect(s.fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry client errors or other 402s', async () => {
    for (const [body, status] of [
      [error400Model, 400],
      [error402Balance, 402],
      [error401, 401],
    ] as const) {
      const s = setup([json(body, status), json(chatRecorded)]);
      await expect(s.client.chat(chatBody, { run: s.run })).rejects.toMatchObject({ status });
      expect(s.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a 200 whose body is an error', async () => {
    const s = setup([json(chatError200), json(chatRecorded)]);
    const done = s.client.chat(chatBody, { run: s.run });
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toMatchObject({ id: chatRecorded.id });
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it('respects retry: false', async () => {
    const s = setup([json(error429, 429), json(chatRecorded)]);
    await expect(s.client.chat(chatBody, { run: s.run, retry: false })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops waiting as soon as the run aborts', async () => {
    const s = setup([json(error502, 502), json(chatRecorded)], {
      options: { retry: { random: () => 0.99 } },
    });
    const done = s.client.chat(chatBody, { run: s.run }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100);
    s.run.abort('user');
    expect(isAbortError(await done)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts on the run signal even when the call has its own signal', async () => {
    const s = setup([json(error502, 502), json(chatRecorded)]);
    const own = new AbortController();
    const done = s.client
      .chat(chatBody, { run: s.run, signal: own.signal })
      .catch((e: unknown) => e);
    s.run.abort();
    expect(isAbortError(await done)).toBe(true);
  });
});

describe('free-model throttle', () => {
  it('throttles requests that may hit a :free model, once per attempt', async () => {
    const s = setup([json(chatRecorded), json(chatRecorded), json(chatRecorded)]);
    await s.client.chat({ ...chatBody, model: 'liquid/lfm-2.5-2.6b:free' }, { run: s.run });
    await s.client.chat({ ...chatBody, models: ['qwen/qwen3.8-27b:free'] }, { run: s.run });
    await s.client.chat(chatBody, { run: s.run });
    expect(s.throttle.acquire).toHaveBeenCalledTimes(2);
  });
});

describe('usage capture', () => {
  it('reports chat usage with both token names, cost, latency and generation id', async () => {
    const s = setup([json(chatRecorded, 200, { 'X-Generation-Id': 'gen-header' })]);
    await s.client.chat(chatBody, { run: s.run });
    expect(s.run.usages).toEqual([
      {
        model: 'openai/gpt-6-luna',
        promptTokens: chatRecorded.usage.prompt_tokens,
        completionTokens: chatRecorded.usage.completion_tokens,
        reasoningTokens: chatRecorded.usage.completion_tokens_details.reasoning_tokens,
        costUsd: 0,
        costEstimated: false,
        latencyMs: expect.any(Number) as number,
        generationId: 'gen-header',
      },
    ]);
  });

  it('attributes routed requests to the served model', async () => {
    const s = setup([json({ ...chatRecorded, model: 'openai/gpt-6-luna' })]);
    await s.client.chat({ ...chatBody, model: 'openrouter/auto' }, { run: s.run });
    expect(s.run.usages[0]?.model).toBe('openai/gpt-6-luna');
  });

  it('estimates when a response carries no cost', async () => {
    const s = setup([json({ ...jev, usage: { input_tokens: 10, output_tokens: 1 } })]);
    await s.client.decide(jevRequest as Parameters<typeof s.client.decide>[0], { run: s.run });
    expect(s.models.estimate).toHaveBeenCalledWith({
      kind: 'tokens',
      model: 'typesafe/jev-1.13',
      promptTokens: 10,
      completionTokens: 1,
    });
    expect(s.run.usages[0]).toMatchObject({ costUsd: 0.000176, costEstimated: true });
  });

  it('reports usage carried by an error body', async () => {
    const s = setup([json({ ...error400Model, usage: { prompt_tokens: 3, cost: 0.001 } }, 400)]);
    await expect(s.client.chat(chatBody, { run: s.run })).rejects.toBeInstanceOf(ApiError);
    expect(s.run.usages[0]).toMatchObject({ promptTokens: 3, costUsd: 0.001 });
  });
});

describe('chatStream', () => {
  it('streams the recorded SSE into events and a result, reporting usage once', async () => {
    const s = setup([
      sse(chatStreamText, { 'X-Generation-Id': 'gen-1790981416-f0MwbDBlx1LOFOgfDoxv' }),
    ]);
    const events: ChatStreamEvent[] = [];
    const result = await s.client.chatStream(
      { ...chatBody, model: 'liquid/lfm-2.5-2.6b:free' },
      { run: s.run, onEvent: (e) => events.push(e) },
    );
    expect(call(s).body['stream']).toBe(true);
    expect(events[0]?.type).toBe('meta');
    expect(result.finishReason).toBe('stop');
    expect(result.text.length).toBeGreaterThan(0);
    expect(s.run.usages).toHaveLength(1);
    expect(s.run.usages[0]).toMatchObject({
      model: 'liquid/lfm-2.5-2.6b:free',
      promptTokens: 16,
      completionTokens: 60,
      reasoningTokens: 52,
      costUsd: 0,
      generationId: 'gen-1790981416-f0MwbDBlx1LOFOgfDoxv',
    });
  });

  it('throws a mid-stream error and never retries once the stream started', async () => {
    const s = setup([sse(midStream.lines.join('\n')), sse(chatStreamText)]);
    const events: ChatStreamEvent[] = [];
    const error: unknown = await s.client
      .chatStream(chatBody, { run: s.run, onEvent: (e) => events.push(e) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as ApiError).detail.midStream).toBe(true);
    expect(events).toContainEqual({ type: 'text', text: 'Partial ' });
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an error that arrives before the stream starts', async () => {
    const s = setup([json(error502, 502), sse(chatStreamText)]);
    const result = await s.client.chatStream(chatBody, { run: s.run, onEvent: () => undefined });
    expect(result.finishReason).toBe('stop');
    expect(s.fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts cleanly mid-stream', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"g","model":"m","choices":[{"delta":{"content":"Hi"}}]}\n\n'),
        );
      },
    });
    const s = setup([new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })]);
    const error: unknown = await s.client
      .chatStream(chatBody, {
        run: s.run,
        onEvent: (e) => {
          if (e.type === 'text') s.run.abort();
        },
      })
      .catch((e: unknown) => e);
    expect(isAbortError(error)).toBe(true);
    expect(s.run.usages).toHaveLength(0);
  });

  it('replays a JSON answer from a provider that cannot stream', async () => {
    const s = setup([json(chatRecorded)]);
    const events: ChatStreamEvent[] = [];
    const result = await s.client.chatStream(chatBody, {
      run: s.run,
      onEvent: (e) => events.push(e),
    });
    expect(result.text).toBe('pong');
    expect(events.map((e) => e.type)).toEqual(['meta', 'reasoning', 'text', 'finish', 'usage']);
  });
});

describe('images', () => {
  it('decodes b64_json into Blobs and reports usage (recorded generation)', async () => {
    const body = JSON.parse(
      withRealBase64(JSON.stringify(imagesGenerate.response), JPEG_B64),
    ) as unknown;
    const s = setup([json(body, 200, imagesGenerate.headers.headers)], {
      tool: 'image-generation',
    });
    const result = await s.client.images(imagesGenerate.request, { run: s.run });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.mediaType).toBe('image/jpeg');
    expect(result.images[0]?.blob.type).toBe('image/jpeg');
    expect(result.images[0]?.blob.size).toBe(atob(JPEG_B64).length);
    expect(result.generationId).toBe('gen-img-1790983552-TOdyb7qrp6185EBMwzAV');
    expect(s.run.usages[0]).toMatchObject({ costUsd: 0.014, completionTokens: 4096 });
    expect(headers(s)['X-OpenRouter-Categories']).toBe('image-gen');
  });

  it('passes data-URL references through unchanged (recorded edit)', async () => {
    const reference = `data:image/png;base64,${PNG_B64}`;
    const request = {
      ...imagesEdit.request,
      input_references: [{ type: 'image_url' as const, image_url: { url: reference } }],
    };
    const body = JSON.parse(
      withRealBase64(JSON.stringify(imagesEdit.response), JPEG_B64),
    ) as unknown;
    const s = setup([json(body)]);
    const result = await s.client.images(request, { run: s.run });
    expect(call(s).body['input_references']).toEqual(request.input_references);
    expect(s.run.usages[0]?.costUsd).toBe(0.015);
    expect(result.images).toHaveLength(1);
  });

  it('sniffs the type when media_type is missing', async () => {
    const s = setup([json({ created: 0, data: [{ b64_json: PNG_B64 }], usage: { cost: 0.01 } })]);
    const result = await s.client.images({ model: 'm', prompt: 'x' }, { run: s.run });
    expect(result.images[0]?.mediaType).toBe('image/png');
  });

  it('delivers OpenAI streaming partials and the final image (recorded stream)', async () => {
    const s = setup([
      sse(withRealBase64(imagesStreamText, PNG_B64), { 'X-Generation-Id': 'gen-img-s' }),
    ]);
    const partials: string[] = [];
    const result = await s.client.images(
      { model: 'openai/gpt-image-1-mini', prompt: 'x', stream: true, quality: 'low' },
      { run: s.run, onPartial: (image) => partials.push(image.mediaType) },
    );
    expect(partials).toEqual(['image/png']);
    expect(result.images).toHaveLength(1);
    expect(result.created).toBe(1790983963);
    expect(s.run.usages[0]).toMatchObject({ costUsd: 0.003006, generationId: 'gen-img-s' });
  });

  it('turns a stream error event into an ApiError', async () => {
    const s = setup([sse(imagesStreamError.lines.join('\n'))]);
    const error: unknown = await s.client
      .images({ model: 'openai/gpt-image-2', prompt: 'x', stream: true }, { run: s.run })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).detail.midStream).toBe(true);
    expect((error as ApiError).status).toBe(500);
  });
});

describe('speech', () => {
  it('parses PCM rate and channels and estimates the cost', async () => {
    const recorded = speechKokoro.response.headers;
    const s = setup([new Response(new Uint8Array(1000), { headers: { ...recorded } })], {
      tool: 'text-to-speech',
    });
    const result = await s.client.speech(
      { ...speechKokoro.request, response_format: 'pcm' },
      { run: s.run },
    );
    expect(result).toMatchObject({
      mimeType: 'audio/pcm',
      sampleRate: 24000,
      channels: 1,
      generationId: recorded['X-Generation-Id'],
    });
    expect(result.blob.size).toBe(1000);
    expect(s.models.estimate).toHaveBeenCalledWith({
      kind: 'speech',
      model: 'hexgrad/kokoro-82m',
      characters: speechKokoro.request.input.length,
    });
    expect(s.run.usages[0]).toMatchObject({ costUsd: 0.000176, costEstimated: true });
  });

  it('picks mp3, or pcm for Gemini TTS, when the caller does not choose', async () => {
    const mp3 = () =>
      new Response(new Uint8Array([0xff, 0xfb]), { headers: { 'Content-Type': 'audio/mpeg' } });
    const s = setup([mp3(), mp3()]);
    const kokoro = await s.client.speech(
      { model: 'hexgrad/kokoro-82m', input: 'a' },
      { run: s.run },
    );
    await s.client.speech({ model: 'google/gemini-3.8-flash-tts', input: 'a' }, { run: s.run });
    expect(call(s, 0).body['response_format']).toBe('mp3');
    expect(call(s, 1).body['response_format']).toBe('pcm');
    expect(kokoro).toMatchObject({ mimeType: 'audio/mpeg', sampleRate: null, channels: null });
  });
});

describe('transcribe', () => {
  const audio = new Blob([new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3])], { type: 'audio/mpeg' });

  it('sends base64 JSON and normalises verbose segments and words (recorded)', async () => {
    const s = setup([json(sttVerbose.response, 200, { 'X-Generation-Id': 'gen-stt-1' })], {
      tool: 'speech-to-text',
    });
    const result = await s.client.transcribe(
      { model: 'openai/whisper-large-v3-turbo', audio, language: 'en', timestamps: true },
      { run: s.run },
    );
    expect(call(s).body).toEqual({
      model: 'openai/whisper-large-v3-turbo',
      input_audio: { data: btoa('ID3\x01\x02\x03'), format: 'mp3' },
      language: 'en',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
    });
    expect(result.text).toBe('The quick brown fox jumps over the lazy dog.');
    expect(result.language).toBe('en');
    expect(result.duration).toBe(3.17);
    expect(result.segments).toEqual([
      { start: 0, end: 2.7600000000000002, text: 'The quick brown fox jumps over the lazy dog.' },
    ]);
    expect(result.words).toHaveLength(9);
    expect(result.words[0]).toEqual({ start: 0, end: 0.11999999731779099, word: 'The' });
    expect(s.run.usages[0]).toMatchObject({ costUsd: 0.0000105561, generationId: 'gen-stt-1' });
  });

  it('asks for plain json without timestamps', async () => {
    const s = setup([json(sttGrok)]);
    const result = await s.client.transcribe({ model: 'x-ai/grok-stt-1.0', audio }, { run: s.run });
    expect(call(s).body['response_format']).toBe('json');
    expect(call(s).body['timestamp_granularities']).toBeUndefined();
    expect(result.segments).toEqual([]);
    expect(result.duration).toBe(3.24);
  });

  it('routes diarization through provider options (Deepgram and Azure)', async () => {
    const s = setup([json(sttDeepgram.response), json(sttAzure.response)]);
    const deepgram = await s.client.transcribe(
      { model: 'deepgram/nova-3', audio, diarize: true },
      { run: s.run },
    );
    const azure = await s.client.transcribe(
      { model: 'microsoft/mai-transcribe-2', audio, diarize: true },
      { run: s.run },
    );
    expect(call(s, 0).body['provider']).toEqual(sttDeepgram.request_provider);
    expect(call(s, 0).body['response_format']).toBe('verbose_json');
    expect(call(s, 0).body['diarize']).toBeUndefined();
    expect(call(s, 1).body['provider']).toEqual(sttAzure.request_provider);
    expect(deepgram.segments[0]?.speaker).toBe('0');
    expect(azure.words.every((w) => w.speaker === '0')).toBe(true);
  });

  it('refuses diarization for models without a known route, before sending', async () => {
    const s = setup([json(sttGrok)]);
    await expect(
      s.client.transcribe({ model: 'x-ai/grok-stt-1.0', audio, diarize: true }, { run: s.run }),
    ).rejects.toThrow(/Speaker labels are not available/);
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('derives the format from the file name when the type is unknown', async () => {
    const s = setup([json(sttGrok)]);
    await s.client.transcribe(
      { model: 'x-ai/grok-stt-1.0', audio: new Blob([new Uint8Array([1])]), filename: 'talk.WAV' },
      { run: s.run },
    );
    expect((call(s).body['input_audio'] as { format: string }).format).toBe('wav');
  });
});

describe('decide', () => {
  it('posts to the alpha URL and reports input/output token usage (recorded Jev)', async () => {
    const s = setup([json(jev, 200, { 'X-Generation-Id': jev.id })], { tool: 'decision' });
    const result = await s.client.decide(jevRequest as Parameters<typeof s.client.decide>[0], {
      run: s.run,
    });
    expect(call(s).url).toBe(DECISIONS_URL);
    expect(result.answers['is_bug']).toEqual({ type: 'noul', noul: 0.96 });
    expect(s.run.usages[0]).toMatchObject({
      model: 'typesafe/jev-1.13',
      promptTokens: 476,
      completionTokens: 70,
      costUsd: 0.000019992,
      generationId: jev.id,
    });
  });
});

describe('videos', () => {
  it('submits and normalises the 202 without adding usage', async () => {
    const s = setup([json(videoSubmit, 202)], { tool: 'video-studio' });
    const status = await s.client.videos.submit(
      {
        model: 'x-ai/grok-imagine-video',
        prompt: 'p',
        duration: 1,
        resolution: '480p',
        aspect_ratio: '1:1',
        frame_images: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG_B64}` },
            frame_type: 'first_frame',
          },
        ],
      },
      { run: s.run },
    );
    expect(call(s).url).toBe(`${API_BASE}/videos`);
    expect(status).toEqual({
      id: videoSubmit.id,
      status: 'pending',
      done: false,
      generationId: null,
      outputs: 0,
      costUsd: null,
      error: null,
    });
    expect(s.run.usages).toEqual([]);
    expect(headers(s)['X-OpenRouter-Categories']).toBe('video-gen');
  });

  it('rejects data: URLs for video and audio references before sending', async () => {
    const s = setup([json(videoSubmit, 202)]);
    await expect(
      s.client.videos.submit(
        {
          model: 'bytedance/seedance-2.0-mini',
          prompt: 'p',
          input_references: [
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
          ],
        },
        { run: s.run },
      ),
    ).rejects.toThrow(/https/);
    expect(s.fetch).not.toHaveBeenCalled();
  });

  it('reads pending, completed (with cost) and failed statuses by key id', async () => {
    const s = setup([json(videoPending), json(videoCompleted), json(videoFailed)]);
    const pending = await s.client.videos.status(videoPending.id, { keyId: 'key-2' });
    const completed = await s.client.videos.status(videoCompleted.id, { keyId: 'key-2' });
    const failed = await s.client.videos.status(videoFailed.id, { keyId: 'key-2' });
    expect(call(s).url).toBe(`${API_BASE}/videos/${videoPending.id}`);
    expect(s.keys.secret).toHaveBeenCalledWith('key-2');
    expect(pending).toMatchObject({ status: 'pending', done: false, costUsd: null });
    expect(completed).toMatchObject({
      status: 'completed',
      done: true,
      costUsd: 0.052,
      outputs: 1,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      done: true,
      error: 'Content policy violation',
    });
  });

  it('downloads content with Authorization into a Blob', async () => {
    const bytes = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);
    const s = setup([new Response(bytes, { headers: { 'Content-Type': 'video/mp4' } })]);
    const blob = await s.client.videos.content(videoCompleted.id, { keyId: 'key-1', index: 0 });
    expect(call(s).url).toBe(`${API_BASE}/videos/${videoCompleted.id}/content?index=0`);
    expect(headers(s)['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(blob.type).toBe('video/mp4');
    expect(blob.size).toBe(bytes.length);
  });

  it('maps an unknown job to a 404 ApiError', async () => {
    const s = setup([json(error404Video, 404)]);
    await expect(s.client.videos.status('gen-vid-x', { keyId: 'key-1' })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('catalog and account', () => {
  it('reads endpoints, image models and video models keylessly', async () => {
    const s = setup([json(lyriaEndpoints), json(imagesModels), json(videosModels)]);
    const endpoints = await s.client.catalog.modelEndpoints('google/lyria-3-pro-preview');
    const images = await s.client.catalog.imageModels();
    const videos = await s.client.catalog.videoModels();
    expect(call(s, 0).url).toBe(`${API_BASE}/models/google/lyria-3-pro-preview/endpoints`);
    expect(endpoints[0]?.provider_name).toBe('Google AI Studio');
    expect(images).toHaveLength(imagesModels.data.length);
    expect(videos).toHaveLength(30);
    expect(call(s, 1).url).toBe(`${API_BASE}/images/models`);
    expect(call(s, 2).url).toBe(`${API_BASE}/videos/models`);
  });

  it('reads key status with the given secret and drops account identifiers', async () => {
    const s = setup([json(keyRecorded)]);
    const status = await s.client.account.key('sk-or-v1-testother');
    expect(headers(s)).toEqual({ Authorization: 'Bearer sk-or-v1-testother' });
    expect(status.data.limit_remaining).toBe(74.5);
    expect(JSON.stringify(status)).not.toMatch(/creator_user_id|workspace_id/);
  });

  it('treats a refused credits read as unknown', async () => {
    const s = setup([
      json(credits),
      json(error401, 401),
      json({ error: { code: 403, message: 'no' } }, 403),
    ]);
    expect(await s.client.account.credits(SECRET)).toEqual(credits);
    expect(await s.client.account.credits(SECRET)).toBeNull();
    expect(await s.client.account.credits(SECRET)).toBeNull();
  });

  it('exchanges an auth code once, without a key, returning only the key', async () => {
    const s = setup([json(authKeys)]);
    const result = await s.client.account.exchangeAuthCode({
      code: 'abc',
      codeVerifier: 'verifier',
      codeChallengeMethod: 'S256',
    });
    expect(result).toEqual({ key: authKeys.key });
    expect(call(s).url).toBe(`${API_BASE}/auth/keys`);
    expect(call(s).body).toEqual({
      code: 'abc',
      code_verifier: 'verifier',
      code_challenge_method: 'S256',
    });
    expect(headers(s)).toEqual({ 'Content-Type': 'application/json' });
  });

  it('never retries the exchange', async () => {
    const s = setup([json(error502, 502), json(authKeys)]);
    await expect(
      s.client.account.exchangeAuthCode({
        code: 'c',
        codeVerifier: 'v',
        codeChallengeMethod: 'S256',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(s.fetch).toHaveBeenCalledTimes(1);
  });
});
