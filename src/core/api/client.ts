/**
 * The only module that talks to openrouter.ai (CLAUDE.md, architecture rule 1). Facts it relies on are in
 * docs/openrouter-api.md; section numbers below refer to it.
 *
 * - Headers: `Authorization`, `Content-Type` (JSON bodies), and on keyed calls `HTTP-Referer` (site URL),
 *   `X-OpenRouter-Title` and, per tool, `X-OpenRouter-Categories`. Nothing outside OpenRouter's CORS allow-list
 *   (§13). Keyless catalog GETs send no custom header, so they need no preflight. The key is never logged.
 * - Retries (408, 429, 5xx, the in-flight-budget 402, network failures): at most 3 attempts with full-jitter
 *   backoff, or exactly `error.metadata.retry_after_seconds` when given (`Retry-After` is unreadable, §12.3).
 *   A stream is never retried once its response has started.
 * - `:free` models are throttled client-side to 20 requests per rolling minute (queued, not failed).
 * - Keys with `noRetention` add `provider.data_collection: "deny"` to chat, decisions, TTS and STT, except for
 *   free models: free endpoints are training-allowed, so `deny` turns every free request into a 404 (§0, §2.9).
 *   `/images` and `/videos` do not accept the field.
 * - Every billed response reports usage to the run. TTS bytes carry no cost, so it is estimated from the
 *   highest endpoint price and marked `costEstimated`. Video cost arrives on the completed status read, which
 *   has no run: `VideoJobStatus.costUsd` is returned for the tool to add.
 *
 * Services are read from `core` at call time only, so the composition root can wire circular dependencies.
 */

import { ApiError, NetworkError, isAbortError } from '../errors';
import { isFreeModelId } from '../models/free';
import { url as sitePath } from '../paths';
import type { ApiClient, CallOptions, CoreServices, RunHandle, ToolId, Usage } from '../types';
import { ChatStreamAssembler } from './chat-stream';
import { audioFormat, base64ToBlob, blobToBase64, parseContentType } from './encoding';
import { apiErrorFromBody, bodyError, statusFromCode } from './error-map';
import { DEFAULT_RETRY_POLICY, abortError, retryDelay, sleep, type RetryPolicy } from './retry';
import { readSse } from './sse';
import { FreeModelThrottle } from './throttle';
import type {
  ChatResponse,
  ChatStreamResult,
  CreditsResponse,
  DecisionResponse,
  GeneratedImage,
  ImageResult,
  KeyStatusResponse,
  ProviderPreferences,
  RawImageModel,
  RawModel,
  RawModelEndpoint,
  RawVideoModel,
  SpeechResult,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionWord,
  VideoJobState,
  VideoJobStatus,
  VideoRequest,
  WireUsage,
} from './types';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const API_BASE = `${OPENROUTER_ORIGIN}/api/v1`;
/** Not under /api/v1 (§0). */
export const DECISIONS_URL = `${OPENROUTER_ORIGIN}/api/alpha/decisions`;
export const APP_TITLE = 'ORtoolbox';

/**
 * `X-OpenRouter-Categories` per tool: recognised values only, at most 2 (§1). Tools without a fitting category
 * (OCR, extractors, STT, decisions) send none.
 */
export const TOOL_CATEGORIES: Partial<Record<ToolId, string>> = {
  chat: 'general-chat',
  'bot-to-bot': 'general-chat,creative-writing',
  'model-arena': 'general-chat',
  'image-generation': 'image-gen',
  'image-editor': 'image-gen',
  'isolated-image': 'image-gen',
  'video-studio': 'video-gen',
  'text-to-speech': 'audio-gen',
  'music-generation': 'audio-gen',
};

/**
 * Speaker labels go through `provider.options` (top-level `diarize` was rejected by every model tried, §0, §5.4).
 * Returns the options for the model's provider, or null when no working route is known.
 */
export function diarizationRoute(model: string): Record<string, Record<string, unknown>> | null {
  if (model.startsWith('deepgram/')) return { deepgram: { diarize: true } };
  if (model.startsWith('microsoft/mai-transcribe'))
    return { azure: { diarization: { enabled: true } } };
  return null;
}

/** TTS output format when the caller does not choose: Gemini TTS rejects mp3 (§0); mp3 elsewhere (smaller, playable). */
export function defaultSpeechFormat(model: string): 'mp3' | 'pcm' {
  return /^google\/gemini-.*tts/.test(model) ? 'pcm' : 'mp3';
}

export interface ApiClientOptions {
  /** Defaults to the global fetch, looked up at call time. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** `HTTP-Referer`; defaults to the site root (origin + base path). */
  siteUrl?: string;
  retry?: Partial<RetryPolicy>;
  throttle?: FreeModelThrottle;
}

type Auth = { secret: string } | { keyId: string } | null;

interface Spec {
  method: 'GET' | 'POST';
  url: string;
  auth: Auth;
  json?: unknown;
  /** Adds attribution headers, and the tool's categories when `run` is set. */
  attribution: boolean;
  run?: RunHandle;
  signal?: AbortSignal;
  retry: boolean;
  /** Throttle as a `:free` request. */
  free: boolean;
}

interface Delivered<T> {
  value: T;
  res: Response;
  startedAt: number;
}

const VIDEO_STATES: readonly VideoJobState[] = [
  'pending',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
  'expired',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `/models/{author}/{slug}` style path with each segment encoded. */
function modelPath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!a || a === b) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

/** JSON of one SSE `data` payload, or undefined when it is not JSON (skipped like a comment). */
function parseEventData(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses a 2xx JSON body; a body carrying `error` instead of a result becomes an ApiError (§2.2). */
async function readJson<T>(res: Response): Promise<T> {
  const body = await readBody(res);
  const error = bodyError(body);
  if (error) {
    throw apiErrorFromBody(statusFromCode(error['code']), body, {
      generationId: res.headers.get('X-Generation-Id'),
    });
  }
  if (body === undefined) throw new ApiError('OpenRouter returned an unreadable response.', 502);
  return body as T;
}

function siteRoot(): string {
  try {
    return new URL(sitePath(), globalThis.location.origin).href;
  } catch {
    return sitePath();
  }
}

export function createApiClient(core: CoreServices, options: ApiClientOptions = {}): ApiClient {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const throttle = options.throttle ?? new FreeModelThrottle();
  const doFetch = (input: string, init: RequestInit): Promise<Response> =>
    (options.fetch ?? globalThis.fetch)(input, init);

  async function headersFor(spec: Spec): Promise<Record<string, string>> {
    const headers: Record<string, string> = {};
    if (spec.auth) {
      const secret =
        'secret' in spec.auth ? spec.auth.secret : await core.keys.secret(spec.auth.keyId);
      headers['Authorization'] = `Bearer ${secret}`;
    }
    if (spec.json !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.attribution) {
      headers['HTTP-Referer'] = options.siteUrl ?? siteRoot();
      headers['X-OpenRouter-Title'] = APP_TITLE;
      const categories = spec.run ? TOOL_CATEGORIES[spec.run.tool] : undefined;
      if (categories) headers['X-OpenRouter-Categories'] = categories;
    }
    return headers;
  }

  /**
   * Sends with throttling and retries. For non-streaming calls `read` runs inside the retry loop (so a 200
   * carrying an error can be retried); for streams the caller reads the body after this resolves, and nothing
   * is retried once the response has started.
   */
  async function send<T>(
    spec: Spec,
    read: ((res: Response) => Promise<T>) | null,
  ): Promise<Delivered<T | null>> {
    const headers = await headersFor(spec);
    for (let attempt = 1; ; attempt++) {
      if (spec.signal?.aborted) throw abortError();
      if (spec.free) await throttle.acquire(spec.signal);
      const startedAt = Date.now();
      let failure: unknown;
      try {
        let res: Response;
        try {
          res = await doFetch(spec.url, {
            method: spec.method,
            headers,
            body: spec.json === undefined ? undefined : JSON.stringify(spec.json),
            signal: spec.signal,
            credentials: 'omit',
          });
        } catch (error) {
          if (isAbortError(error) || spec.signal?.aborted) throw abortError();
          throw new NetworkError('Could not reach OpenRouter. Check your connection.', {
            cause: error,
          });
        }
        if (!res.ok) {
          const body = await readBody(res).catch(() => undefined);
          if (spec.run && isRecord(body) && isRecord(body['usage'])) {
            await reportUsage(spec.run, {
              model: spec.json && isRecord(spec.json) ? (str(spec.json['model']) ?? '') : '',
              usage: body['usage'],
              latencyMs: Date.now() - startedAt,
              generationId: res.headers.get('X-Generation-Id'),
            });
          }
          throw apiErrorFromBody(res.status, body, {
            generationId: res.headers.get('X-Generation-Id'),
            providerName: res.headers.get('X-Provider-Name'),
          });
        }
        if (!read) return { value: null, res, startedAt };
        return { value: await read(res), res, startedAt };
      } catch (error) {
        failure = error;
      }
      if (isAbortError(failure) || spec.signal?.aborted) throw abortError();
      const retryable =
        failure instanceof NetworkError || (failure instanceof ApiError && failure.retryable);
      const delay =
        spec.retry && retryable
          ? retryDelay(
              attempt,
              policy,
              failure instanceof ApiError ? failure.detail.retryAfterMs : undefined,
            )
          : null;
      if (delay === null) throw failure;
      await sleep(delay, spec.signal);
    }
  }

  async function sendJson<T>(spec: Spec): Promise<Delivered<T>> {
    const delivered = await send(spec, (res) => readJson<T>(res));
    return delivered as Delivered<T>;
  }

  async function reportUsage(
    run: RunHandle,
    input: {
      model: string;
      usage: WireUsage | null | undefined;
      latencyMs: number;
      generationId: string | null | undefined;
    },
  ): Promise<void> {
    const usage = input.usage ?? {};
    const promptTokens = num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0;
    const completionTokens = num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0;
    const reasoningTokens = num(usage.completion_tokens_details?.reasoning_tokens);
    let costUsd = num(usage.cost);
    let costEstimated = false;
    if (costUsd === undefined) {
      // Rare (the spec marks cost optional on decisions): estimate from catalog token prices.
      costEstimated = true;
      costUsd =
        (await core.models
          .estimate({ kind: 'tokens', model: input.model, promptTokens, completionTokens })
          .catch(() => null)) ?? 0;
    }
    const entry: Usage = {
      model: input.model,
      promptTokens,
      completionTokens,
      costUsd,
      costEstimated,
      latencyMs: input.latencyMs,
    };
    if (reasoningTokens !== undefined) entry.reasoningTokens = reasoningTokens;
    if (input.generationId) entry.generationId = input.generationId;
    run.addUsage(entry);
  }

  /** The model to attribute usage to: the served model when routing chose it, else the requested id. */
  function usageModel(body: { model: string; models?: string[] }, served?: string): string {
    const routed = (body.models?.length ?? 0) > 0 || body.model.startsWith('openrouter/');
    return routed && served ? served : body.model;
  }

  function withNoRetention<T extends { model: string; provider?: ProviderPreferences }>(
    body: T,
    keyId: string,
  ): T {
    if (!core.keys.get(keyId)?.noRetention) return body;
    if (isFreeModelId(body.model)) return body;
    if (body.provider?.data_collection) return body;
    return { ...body, provider: { ...body.provider, data_collection: 'deny' } };
  }

  function callSpec(
    opts: CallOptions,
    url: string,
    json: unknown,
    models: string[],
  ): Spec & { run: RunHandle } {
    return {
      method: 'POST',
      url,
      auth: { keyId: opts.run.keyId },
      json,
      attribution: true,
      run: opts.run,
      signal: combineSignals(opts.signal, opts.run.signal),
      retry: opts.retry !== false,
      free: models.some(isFreeModelId),
    };
  }

  function decodeImages(items: unknown): GeneratedImage[] {
    const images: GeneratedImage[] = [];
    if (!Array.isArray(items)) return images;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const b64 =
        str(item['b64_json']) ??
        (str(item['url'])?.startsWith('data:') ? str(item['url']) : undefined);
      if (!b64) continue;
      const decoded = base64ToBlob(b64, str(item['media_type']));
      images.push({ blob: decoded.blob, mediaType: decoded.mediaType });
    }
    return images;
  }

  function normalizeVideo(body: unknown): VideoJobStatus {
    const record = isRecord(body) ? body : {};
    const raw = str(record['status']) ?? 'pending';
    const status: VideoJobState = (VIDEO_STATES as readonly string[]).includes(raw)
      ? (raw as VideoJobState)
      : 'pending';
    const usage: Record<string, unknown> = isRecord(record['usage']) ? record['usage'] : {};
    const error = record['error'];
    return {
      id: str(record['id']) ?? '',
      status,
      done: status !== 'pending' && status !== 'in_progress',
      generationId: str(record['generation_id']) ?? null,
      outputs: Array.isArray(record['unsigned_urls']) ? record['unsigned_urls'].length : 0,
      costUsd: num(usage['cost']) ?? null,
      error:
        typeof error === 'string'
          ? error
          : isRecord(error) && typeof error['message'] === 'string'
            ? error['message']
            : null,
    };
  }

  function keyless(url: string): Spec {
    return { method: 'GET', url, auth: null, attribution: false, retry: true, free: false };
  }

  return {
    async chat(body, opts) {
      const wire = withNoRetention({ ...body, stream: false }, opts.run.keyId);
      const spec = callSpec(opts, `${API_BASE}/chat/completions`, wire, [
        body.model,
        ...(body.models ?? []),
      ]);
      const { value, res, startedAt } = await sendJson<ChatResponse>(spec);
      await reportUsage(opts.run, {
        model: usageModel(body, value.model),
        usage: value.usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id') ?? value.id,
      });
      return value;
    },

    async chatStream(body, opts) {
      const wire = withNoRetention({ ...body, stream: true }, opts.run.keyId);
      const spec = callSpec(opts, `${API_BASE}/chat/completions`, wire, [
        body.model,
        ...(body.models ?? []),
      ]);
      const { res, startedAt } = await send(spec, null);
      const generationId = res.headers.get('X-Generation-Id');
      const assembler = new ChatStreamAssembler(opts.onEvent, generationId);
      const finish = async (): Promise<void> => {
        const result = assembler.result();
        if (assembler.lastUsage || result.id) {
          await reportUsage(opts.run, {
            model: usageModel(body, result.model),
            usage: assembler.lastUsage,
            latencyMs: Date.now() - startedAt,
            generationId: generationId ?? result.id,
          });
        }
      };
      try {
        if (!parseContentType(res.headers.get('Content-Type')).type.includes('event-stream')) {
          // A provider that cannot stream may answer with one JSON body; replay it as events.
          const json = await readJson<ChatResponse>(res);
          const choice = json.choices[0];
          assembler.push({
            id: json.id,
            model: json.model,
            provider: json.provider,
            choices: [
              {
                index: 0,
                delta: {
                  content: choice?.message.content ?? '',
                  reasoning: choice?.message.reasoning ?? undefined,
                  images: choice?.message.images,
                  audio: choice?.message.audio,
                },
                finish_reason: choice?.finish_reason ?? null,
              },
            ],
            usage: json.usage,
          });
        } else if (res.body) {
          await readSse(
            res.body,
            (event) => {
              if (event.data === '[DONE]') return 'stop';
              const chunk = parseEventData(event.data);
              if (chunk !== undefined) assembler.push(chunk);
              return undefined;
            },
            spec.signal,
          );
        }
      } catch (error) {
        if (!isAbortError(error) && assembler.lastUsage) await finish();
        throw error;
      }
      await finish();
      return assembler.result() satisfies ChatStreamResult;
    },

    async images(body, opts) {
      const spec = callSpec(opts, `${API_BASE}/images`, body, [body.model]);
      const { res, startedAt } = await send(spec, null);
      const generationId = res.headers.get('X-Generation-Id');
      const images: GeneratedImage[] = [];
      const usages: WireUsage[] = [];
      let created = 0;

      if (parseContentType(res.headers.get('Content-Type')).type.includes('event-stream')) {
        if (res.body) {
          await readSse(
            res.body,
            (event) => {
              if (event.data === '[DONE]') return 'stop';
              const data = parseEventData(event.data);
              if (!isRecord(data)) return undefined;
              const error = bodyError(data);
              if (data['type'] === 'error' || error) {
                throw apiErrorFromBody(
                  statusFromCode(error?.['code']),
                  { error },
                  {
                    midStream: true,
                    generationId,
                  },
                );
              }
              const b64 = str(data['b64_json']);
              if (data['type'] === 'image_generation.partial_image' && b64) {
                const decoded = base64ToBlob(b64, str(data['media_type']));
                opts.onPartial?.({ blob: decoded.blob, mediaType: decoded.mediaType });
              } else if (data['type'] === 'image_generation.completed') {
                images.push(...decodeImages([data]));
                created = num(data['created']) ?? created;
                if (isRecord(data['usage'])) usages.push(data['usage']);
              }
              return undefined;
            },
            spec.signal,
          );
        }
      } else {
        const json = await readJson<Record<string, unknown>>(res);
        images.push(...decodeImages(json['data']));
        created = num(json['created']) ?? 0;
        if (isRecord(json['usage'])) usages.push(json['usage']);
      }

      const usage = mergeUsage(usages);
      await reportUsage(opts.run, {
        model: body.model,
        usage,
        latencyMs: Date.now() - startedAt,
        generationId,
      });
      if (images.length === 0) {
        throw new ApiError(
          'The model returned no image.',
          502,
          generationId ? { generationId } : {},
        );
      }
      const result: ImageResult = { created, images, usage, generationId };
      return result;
    },

    async speech(body, opts) {
      const wire = withNoRetention(
        { ...body, response_format: body.response_format ?? defaultSpeechFormat(body.model) },
        opts.run.keyId,
      );
      const spec = callSpec(opts, `${API_BASE}/audio/speech`, wire, [body.model]);
      const {
        value: bytes,
        res,
        startedAt,
      } = (await send(spec, (r) => r.arrayBuffer())) as Delivered<ArrayBuffer>;
      const { type, params } = parseContentType(res.headers.get('Content-Type'));
      const mimeType = type || (wire.response_format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
      const rate = Number(params['rate']);
      const channels = Number(params['channels']);
      const generationId = res.headers.get('X-Generation-Id');

      // Raw bytes carry no cost (§4.3): estimate from the most expensive endpoint, flagged as estimated.
      const estimate = await core.models
        .estimate({ kind: 'speech', model: body.model, characters: [...body.input].length })
        .catch(() => null);
      const usage: Usage = {
        model: body.model,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimate ?? 0,
        costEstimated: true,
        latencyMs: Date.now() - startedAt,
      };
      if (generationId) usage.generationId = generationId;
      opts.run.addUsage(usage);

      const result: SpeechResult = {
        blob: new Blob([bytes], { type: mimeType }),
        mimeType,
        sampleRate: Number.isFinite(rate) && rate > 0 ? rate : null,
        channels: Number.isFinite(channels) && channels > 0 ? channels : null,
        generationId,
      };
      return result;
    },

    async transcribe(body, opts) {
      const route = body.diarize ? diarizationRoute(body.model) : null;
      if (body.diarize && !route) {
        throw new Error(
          `Speaker labels are not available for ${body.model}. Choose a Deepgram or MAI-Transcribe model.`,
        );
      }
      const verbose = body.timestamps === true || body.diarize === true;
      let provider: ProviderPreferences | undefined = body.provider;
      if (route) provider = { ...provider, options: { ...provider?.options, ...route } };
      const wire = withNoRetention(
        {
          model: body.model,
          input_audio: {
            data: await blobToBase64(body.audio),
            format: body.format ?? audioFormat(body.audio, body.filename),
          },
          ...(body.language ? { language: body.language } : {}),
          ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
          response_format: verbose ? 'verbose_json' : 'json',
          ...(verbose ? { timestamp_granularities: ['segment', 'word'] } : {}),
          ...(body.keyterms?.length ? { keyterms: body.keyterms } : {}),
          ...(provider ? { provider } : {}),
        },
        opts.run.keyId,
      );
      const spec = callSpec(opts, `${API_BASE}/audio/transcriptions`, wire, [body.model]);
      const { value, res, startedAt } = await sendJson<Record<string, unknown>>(spec);
      const usage = isRecord(value['usage']) ? (value['usage'] as WireUsage) : null;
      await reportUsage(opts.run, {
        model: body.model,
        usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id'),
      });
      return normalizeTranscription(value, usage);
    },

    async decide(body, opts) {
      const wire = withNoRetention(body, opts.run.keyId);
      const spec = callSpec(opts, DECISIONS_URL, wire, [body.model]);
      const { value, res, startedAt } = await sendJson<DecisionResponse>(spec);
      await reportUsage(opts.run, {
        model: body.model,
        usage: value.usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id') ?? value.id,
      });
      return value;
    },

    videos: {
      async submit(body: VideoRequest, opts) {
        const refs = body.input_references ?? [];
        for (const ref of refs) {
          const target =
            ref.type === 'audio_url'
              ? ref.audio_url.url
              : ref.type === 'video_url'
                ? ref.video_url.url
                : '';
          if (target && !target.startsWith('https://')) {
            throw new Error(
              'Video and audio references must be public https:// links (uploads are not accepted).',
            );
          }
        }
        // No usage yet: the cost arrives with the completed status (VideoJobStatus.costUsd).
        const spec = callSpec(opts, `${API_BASE}/videos`, body, [body.model]);
        const { value } = await sendJson<unknown>(spec);
        return normalizeVideo(value);
      },

      async status(jobId, opts) {
        const { value } = await sendJson<unknown>({
          method: 'GET',
          url: `${API_BASE}/videos/${encodeURIComponent(jobId)}`,
          auth: { keyId: opts.keyId },
          attribution: true,
          signal: opts.signal,
          retry: true,
          free: false,
        });
        return normalizeVideo(value);
      },

      async content(jobId, opts) {
        const index = opts.index ?? 0;
        const { value } = (await send(
          {
            method: 'GET',
            // Constructed rather than taken from unsigned_urls so the request stays on openrouter.ai (CSP).
            url: `${API_BASE}/videos/${encodeURIComponent(jobId)}/content?index=${index}`,
            auth: { keyId: opts.keyId },
            attribution: true,
            signal: opts.signal,
            retry: true,
            free: false,
          },
          async (res) => {
            const type = parseContentType(res.headers.get('Content-Type')).type || 'video/mp4';
            return new Blob([await res.arrayBuffer()], { type });
          },
        )) as Delivered<Blob>;
        return value;
      },
    },

    catalog: {
      async models(params) {
        const query = new URLSearchParams({ output_modalities: 'all', ...params });
        const { value } = await sendJson<{ data: RawModel[] }>(
          keyless(`${API_BASE}/models?${query}`),
        );
        return value.data;
      },
      async modelEndpoints(modelId) {
        const { value } = await sendJson<{ data: { endpoints?: RawModelEndpoint[] } }>(
          keyless(`${API_BASE}/models/${modelPath(modelId)}/endpoints`),
        );
        return value.data.endpoints ?? [];
      },
      async imageModels() {
        const { value } = await sendJson<{ data: RawImageModel[] }>(
          keyless(`${API_BASE}/images/models`),
        );
        return value.data;
      },
      async videoModels() {
        const { value } = await sendJson<{ data: RawVideoModel[] }>(
          keyless(`${API_BASE}/videos/models`),
        );
        return value.data;
      },
    },

    account: {
      async key(secret, signal) {
        const { value } = await sendJson<KeyStatusResponse>({
          method: 'GET',
          url: `${API_BASE}/key`,
          auth: { secret },
          attribution: false,
          signal,
          retry: true,
          free: false,
        });
        // Identifiers of the account are never kept.
        const data = { ...value.data };
        delete data['creator_user_id'];
        delete data['workspace_id'];
        delete data['organization_id'];
        return { data };
      },

      async credits(secret, signal) {
        try {
          const { value } = await sendJson<CreditsResponse>({
            method: 'GET',
            url: `${API_BASE}/credits`,
            auth: { secret },
            attribution: false,
            signal,
            retry: true,
            free: false,
          });
          return { data: value.data };
        } catch (error) {
          // Documented as management-key only; works for ordinary keys today (§10). Treat refusal as unknown.
          if (error instanceof ApiError && (error.status === 401 || error.status === 403))
            return null;
          throw error;
        }
      },

      async exchangeAuthCode(input) {
        // Never retried: the code is single-use.
        const { value } = await sendJson<{ key?: unknown }>({
          method: 'POST',
          url: `${API_BASE}/auth/keys`,
          auth: null,
          json: {
            code: input.code,
            code_verifier: input.codeVerifier,
            code_challenge_method: input.codeChallengeMethod,
          },
          attribution: false,
          retry: false,
          free: false,
        });
        if (typeof value.key !== 'string' || !value.key) {
          throw new ApiError('OpenRouter did not return a key.', 502);
        }
        return { key: value.key };
      },
    },
  };
}

function mergeUsage(usages: WireUsage[]): WireUsage | null {
  if (usages.length === 0) return null;
  if (usages.length === 1) return usages[0] ?? null;
  const sum = (key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost'): number =>
    usages.reduce((total, u) => total + (num(u[key]) ?? 0), 0);
  return {
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    total_tokens: sum('total_tokens'),
    cost: sum('cost'),
  };
}

function speakerOf(item: Record<string, unknown>): string | undefined {
  const label = item['speaker_label'];
  if (typeof label === 'string' && label) return label;
  const speaker = item['speaker'];
  if (typeof speaker === 'number' || (typeof speaker === 'string' && speaker))
    return String(speaker);
  return undefined;
}

/** Normalises `json` and `verbose_json` bodies from every provider shape seen (§5.3, §5.4). */
export function normalizeTranscription(
  body: Record<string, unknown>,
  usage: WireUsage | null,
): TranscriptionResult {
  const segments: TranscriptionSegment[] = [];
  for (const item of Array.isArray(body['segments']) ? body['segments'] : []) {
    if (!isRecord(item)) continue;
    const start = num(item['start']);
    const end = num(item['end']);
    if (start === undefined || end === undefined) continue;
    const segment: TranscriptionSegment = { start, end, text: (str(item['text']) ?? '').trim() };
    const speaker = speakerOf(item);
    if (speaker !== undefined) segment.speaker = speaker;
    segments.push(segment);
  }
  const words: TranscriptionWord[] = [];
  for (const item of Array.isArray(body['words']) ? body['words'] : []) {
    if (!isRecord(item)) continue;
    const start = num(item['start']);
    const end = num(item['end']);
    if (start === undefined || end === undefined) continue;
    if (item['type'] === 'audio_event') continue;
    const word: TranscriptionWord = { start, end, word: (str(item['word']) ?? '').trim() };
    const speaker = speakerOf(item);
    if (speaker !== undefined) word.speaker = speaker;
    words.push(word);
  }
  return {
    text: (str(body['text']) ?? '').trim(),
    language: str(body['language']) ?? null,
    duration: num(body['duration']) ?? num(usage?.seconds) ?? null,
    segments,
    words,
    usage,
  };
}
