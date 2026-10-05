/**
 * The only module that talks to openrouter.ai (CLAUDE.md, architecture rule 1). Facts it relies on are in
 * docs/openrouter-api.md; section numbers below refer to it.
 *
 * - Headers: `Authorization`, `Content-Type` (JSON bodies), and on keyed calls `HTTP-Referer` (site URL),
 *   `X-OpenRouter-Title` and, per tool, `X-OpenRouter-Categories`. Nothing outside OpenRouter's CORS allow-list
 *   (§13). Keyless catalog GETs send no custom header, so they need no preflight. The key is never logged.
 * - Retries follow `RETRY RULES` below: a retry must never make the user pay twice. At most 3 attempts, with
 *   full-jitter backoff, or exactly `error.metadata.retry_after_seconds` when given (`Retry-After` is unreadable,
 *   §12.3). Streams are never retried once their response started.
 * - `:free` models are throttled client-side to 20 requests per rolling minute (queued, not failed). A call's
 *   `onSend` fires right before each fetch, after that wait and after any retry backoff (timing starts there).
 * - Keys with `noRetention` add `provider.data_collection: "deny"` to chat, decisions, TTS and STT unless every
 *   model of the request is free: free endpoints are training-allowed, so `deny` turns a free request into a 404
 *   (§0, §2.9). `/images` and `/videos` do not accept the field.
 * - Usage: every billed response reports usage to the run. TTS bytes carry no cost, so it is estimated from the
 *   priciest endpoint (`costEstimated`). When a paid request may have reached a provider but no cost is known
 *   (connection lost, aborted, stream without a usage chunk), the usage is reported with `costUnknown`, so the
 *   run books its reservation: unknown is never recorded as free. Video cost arrives only on the completed
 *   status read, which has no run: `VideoJobStatus.costUsd` is returned for the tool to add.
 * - A paid or chat POST (not all-free) that fails where a provider may have run it (lost after sending, 408, a
 *   5xx other than 503) throws with `outcomeUnknown` set (`markOutcome`), so the UI never offers a plain Retry.
 * - JSON success bodies are shape-checked; an `error` inside a 2xx body or a missing result field is an
 *   ApiError, never a TypeError from deep inside a tool.
 *
 * Services are read from `core` at call time only, so the composition root can wire circular dependencies.
 */

import {
  ApiError,
  InvalidInputError,
  NetworkError,
  OrError,
  isAbortError,
  type ApiErrorDetail,
} from '../errors';
import { readAsBase64 } from '../files';
import { isFreeModelId } from '../models/free';
import { url as sitePath } from '../paths';
import type { ApiClient, CallOptions, CoreServices, RunHandle, ToolId, Usage } from '../types';
import {
  abortError,
  isFiniteNumber,
  isRecord,
  isString,
  parseJsonSafe,
  sleep,
  throwIfAborted,
} from '../util';
import { ChatStreamAssembler, withPartialResult } from './chat-stream';
import { audioFormat, base64ToBlob, parseContentType } from './encoding';
import { apiErrorFromBody, bodyError, statusFromCode } from './error-map';
import { DEFAULT_RETRY_POLICY, retryDelay, type RetryPolicy } from './retry';
import { readSse } from './sse';
import { FreeModelThrottle } from './throttle';
import type {
  ChatResponse,
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
 * RETRY RULES. Which failures may be sent again, per kind of request:
 *
 * - `read`: idempotent GETs (catalog, key, credits, video status and content). 408, 429, 5xx, the in-flight
 *   402, and network failures (fetch rejected, or the body could not be read).
 * - `paid`: POSTs that start billable work (images, speech, transcription, decisions, video submit). Only when
 *   OpenRouter certainly did not start the work: 429 and the in-flight-budget 402 (refusals before routing) and
 *   503 (no provider could be routed to). A network failure after sending, 408, 500, 502, 524 and 529 can come
 *   after a provider started, and billed, so they are surfaced instead (OpenRouter documents no guarantee that
 *   a 408 means the provider never ran).
 * - `chat`: chat completions, 429 and the in-flight 402 only: OpenRouter has already tried other providers and
 *   `models` fallbacks before it answers 503 or another 5xx.
 * - `never`: the single-use auth-code exchange.
 */
export type RetryRule = 'read' | 'paid' | 'chat' | 'never';

/**
 * Marks `failure` as `outcomeUnknown` when it ends a non-idempotent POST (`paid`, `chat`) that is not all-free and
 * that a provider may have run without an answer saying so: lost after it was `sent`, or answered 408 or a 5xx
 * other than 503 (no provider was routed to). An error event inside a stream is an answer, so it is not marked.
 */
function markOutcome(spec: Spec, failure: unknown, sent: boolean): void {
  if ((spec.rule !== 'paid' && spec.rule !== 'chat') || !spec.bill || spec.bill.allFree) return;
  if (!(failure instanceof OrError)) return;
  const unknown =
    failure instanceof ApiError
      ? !failure.detail.midStream &&
        (failure.status === 408 || (failure.status >= 500 && failure.status !== 503))
      : failure instanceof NetworkError && sent;
  if (unknown) failure.outcomeUnknown = true;
}

export function mayRetry(error: unknown, rule: RetryRule): boolean {
  if (rule === 'never') return false;
  if (error instanceof NetworkError) return rule === 'read';
  if (!(error instanceof ApiError) || error.detail.midStream) return false;
  const inFlightBudget = error.status === 402 && error.retryable;
  if (error.status === 429 || inFlightBudget) return true;
  if (rule === 'read') return error.retryable;
  if (rule === 'paid') return error.status === 503;
  return false;
}

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
  signal?: AbortSignal | undefined;
  rule: RetryRule;
  /** False when the caller turned retries off. */
  retry: boolean;
  /** Throttle as a `:free` request (some model of the request is free). */
  free: boolean;
  /** For runs: the model usage is booked to, and whether every model is free (then nothing can cost). */
  bill?: { model: string; allFree: boolean };
  /** `CallOptions.onSend`: right before each fetch. */
  onSend?: ((attempt: number) => void) | undefined;
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

/** JSON of a body or SSE payload (prototype-safe), or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return parseJsonSafe(text);
  } catch {
    return undefined;
  }
}

function isEventStream(res: Response): boolean {
  return parseContentType(res.headers.get('Content-Type')).type.includes('event-stream');
}

function detailFor(res: Response): ApiErrorDetail {
  const detail: ApiErrorDetail = {};
  const generationId = res.headers.get('X-Generation-Id');
  if (generationId) detail.generationId = generationId;
  return detail;
}

/** Abort stays an abort; OrErrors pass through; anything else (a body read failing) is a NetworkError. */
function asFailure(error: unknown, signal: AbortSignal | undefined, message: string): Error {
  if (isAbortError(error) || signal?.aborted) return abortError();
  if (error instanceof OrError) return error;
  return new NetworkError(message, { cause: error });
}

/**
 * Parses a 2xx JSON body. A body that fails `isValid` becomes an ApiError: from its `error` when it carries one
 * (a provider that failed after the headers, §2.2), else "unexpected response". (`error` is checked only for
 * invalid bodies: a failed video job's status legitimately carries an `error` string.) Read failures propagate
 * as they are (callers map them with `asFailure`).
 */
async function readJson<T>(
  res: Response,
  isValid: (body: Record<string, unknown>) => boolean,
): Promise<T> {
  const body = parseJson(await res.text());
  if (isRecord(body) && isValid(body)) return body as T;
  const error = bodyError(body);
  if (error) {
    throw apiErrorFromBody(
      statusFromCode(error['code']),
      { error },
      {
        generationId: res.headers.get('X-Generation-Id'),
        providerName: res.headers.get('X-Provider-Name'),
      },
    );
  }
  throw new ApiError('OpenRouter returned an unexpected response.', 502, detailFor(res));
}

const hasChoices = (body: Record<string, unknown>): boolean => {
  const choices = body['choices'];
  return Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0]['message']);
};
const hasData = (body: Record<string, unknown>): boolean => Array.isArray(body['data']);
const hasDataObject = (body: Record<string, unknown>): boolean => isRecord(body['data']);
const isVideoBody = (body: Record<string, unknown>): boolean =>
  isString(body['id']) && isString(body['status']);

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
   * Sends with throttling and the retry rules. For non-streaming calls `read` runs inside the loop, so a body
   * that fails to download is a NetworkError like a failed fetch. For streams (`read` null) the caller reads the
   * body after this resolves, and nothing is retried once the response started. When a paid request may have
   * reached a provider and fails without an answer (network, abort), its usage is booked as unknown.
   */
  async function send<T>(
    spec: Spec,
    read: ((res: Response) => Promise<T>) | null,
  ): Promise<Delivered<T | null>> {
    const headers = await headersFor(spec);
    for (let attempt = 1; ; attempt++) {
      throwIfAborted(spec.signal);
      if (spec.free) await throttle.acquire(spec.signal);
      throwIfAborted(spec.signal);
      try {
        spec.onSend?.(attempt);
      } catch (error) {
        console.error(error); // a caller's timing hook must never stop the request
      }
      const startedAt = Date.now();
      /** True while OpenRouter may have accepted the request without answering it. */
      let reached = false;
      let failure: unknown;
      try {
        let res: Response;
        try {
          reached = true;
          res = await doFetch(spec.url, {
            method: spec.method,
            headers,
            body: spec.json === undefined ? undefined : JSON.stringify(spec.json),
            signal: spec.signal ?? null,
            credentials: 'omit',
          });
        } catch (error) {
          throw asFailure(error, spec.signal, 'Could not reach OpenRouter. Check your connection.');
        }
        if (!res.ok) {
          // An error answer: nothing was billed unless the body says so.
          reached = false;
          const body = parseJson(await res.text().catch(() => ''));
          if (spec.run && spec.bill && isRecord(body) && isRecord(body['usage'])) {
            await reportUsage(spec.run, {
              model: spec.bill.model,
              usage: body['usage'],
              latencyMs: Date.now() - startedAt,
              generationId: res.headers.get('X-Generation-Id'),
              allFree: spec.bill.allFree,
            });
          }
          throw apiErrorFromBody(res.status, body, {
            generationId: res.headers.get('X-Generation-Id'),
            providerName: res.headers.get('X-Provider-Name'),
          });
        }
        if (!read) return { value: null, res, startedAt };
        try {
          const value = await read(res);
          return { value, res, startedAt };
        } catch (error) {
          if (error instanceof ApiError) reached = false; // an answer, even if a failed one
          throw asFailure(
            error,
            spec.signal,
            'The connection dropped while the response was downloading.',
          );
        }
      } catch (error) {
        failure = error;
      }
      if (isAbortError(failure) || spec.signal?.aborted) {
        if (reached) bookUnknown(spec, startedAt);
        throw abortError();
      }
      const delay =
        spec.retry && mayRetry(failure, spec.rule)
          ? retryDelay(
              attempt,
              policy,
              failure instanceof ApiError ? failure.detail.retryAfterMs : undefined,
            )
          : null;
      if (delay === null) {
        if (reached && failure instanceof NetworkError) bookUnknown(spec, startedAt);
        markOutcome(spec, failure, reached);
        throw failure;
      }
      await sleep(delay, spec.signal);
    }
  }

  function bookUnknown(spec: Spec, startedAt: number): void {
    if (spec.run && spec.bill) {
      reportUnknown(spec.run, {
        model: spec.bill.model,
        allFree: spec.bill.allFree,
        latencyMs: Date.now() - startedAt,
        generationId: null,
      });
    }
  }

  function reportUnknown(
    run: RunHandle,
    input: { model: string; allFree: boolean; latencyMs: number; generationId: string | null },
  ): void {
    const entry: Usage = {
      model: input.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      costEstimated: false,
      latencyMs: input.latencyMs,
    };
    // Free models never cost anything, so for them zero is a known cost.
    if (!input.allFree) entry.costUnknown = true;
    if (input.generationId) entry.generationId = input.generationId;
    run.addUsage(entry);
  }

  async function reportUsage(
    run: RunHandle,
    input: {
      model: string;
      usage: WireUsage | null | undefined;
      latencyMs: number;
      generationId: string | null | undefined;
      allFree: boolean;
    },
  ): Promise<void> {
    const usage = input.usage;
    if (!usage) {
      reportUnknown(run, { ...input, generationId: input.generationId ?? null });
      return;
    }
    const tokens = (a: unknown, b: unknown): number =>
      isFiniteNumber(a) ? a : isFiniteNumber(b) ? b : 0;
    const promptTokens = tokens(usage.prompt_tokens, usage.input_tokens);
    const completionTokens = tokens(usage.completion_tokens, usage.output_tokens);
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    let costUsd = isFiniteNumber(usage.cost) ? usage.cost : null;
    let costEstimated = false;
    if (costUsd === null && input.allFree) costUsd = 0;
    if (costUsd === null && (promptTokens > 0 || completionTokens > 0)) {
      // Rare (the spec marks cost optional on decisions): estimate from catalog token prices.
      costUsd = await core.models
        .estimate({ kind: 'tokens', model: input.model, promptTokens, completionTokens })
        .catch(() => null);
      costEstimated = costUsd !== null;
    }
    const entry: Usage = {
      model: input.model,
      promptTokens,
      completionTokens,
      costUsd: costUsd ?? 0,
      costEstimated,
      latencyMs: input.latencyMs,
    };
    if (costUsd === null) entry.costUnknown = true;
    if (isFiniteNumber(reasoningTokens)) entry.reasoningTokens = reasoningTokens;
    if (input.generationId) entry.generationId = input.generationId;
    run.addUsage(entry);
  }

  /** The model to attribute usage to: the served model when routing chose it, else the requested id. */
  function usageModel(body: { model: string; models?: string[] }, served?: string): string {
    const routed = (body.models?.length ?? 0) > 0 || body.model.startsWith('openrouter/');
    return routed && served ? served : body.model;
  }

  /** Adds `data_collection: "deny"` for no-retention keys unless every model is free (§0). */
  function withNoRetention<T extends { model: string; provider?: ProviderPreferences }>(
    body: T,
    keyId: string,
    models: string[],
  ): T {
    if (!core.keys.get(keyId)?.noRetention) return body;
    if (models.every(isFreeModelId)) return body;
    if (body.provider?.data_collection) return body;
    return { ...body, provider: { ...body.provider, data_collection: 'deny' } };
  }

  function callSpec(
    opts: CallOptions,
    url: string,
    json: unknown,
    rule: RetryRule,
    models: string[],
  ): Spec & { run: RunHandle; bill: NonNullable<Spec['bill']> } {
    return {
      method: 'POST',
      url,
      auth: { keyId: opts.run.keyId },
      json,
      attribution: true,
      run: opts.run,
      signal: combineSignals(opts.signal, opts.run.signal),
      rule,
      retry: opts.retry !== false,
      free: models.some(isFreeModelId),
      bill: { model: models[0] ?? '', allFree: models.every(isFreeModelId) },
      onSend: opts.onSend,
    };
  }

  function decodeImages(items: unknown): GeneratedImage[] {
    const images: GeneratedImage[] = [];
    if (!Array.isArray(items)) return images;
    for (const item of items) {
      if (!isRecord(item)) continue;
      const b64 = item['b64_json'];
      const url = item['url'];
      const source =
        isString(b64) && b64 ? b64 : isString(url) && url.startsWith('data:') ? url : '';
      if (!source) continue;
      const type = item['media_type'];
      const decoded = base64ToBlob(source, isString(type) && type ? type : undefined);
      images.push({ blob: decoded.blob, mediaType: decoded.mediaType });
    }
    return images;
  }

  function normalizeVideo(body: Record<string, unknown>): VideoJobStatus {
    const raw = isString(body['status']) ? body['status'] : 'pending';
    const status: VideoJobState = (VIDEO_STATES as readonly string[]).includes(raw)
      ? (raw as VideoJobState)
      : 'pending';
    const usage = isRecord(body['usage']) ? body['usage'] : {};
    const error = body['error'];
    const generationId = body['generation_id'];
    return {
      id: isString(body['id']) ? body['id'] : '',
      status,
      done: status !== 'pending' && status !== 'in_progress',
      generationId: isString(generationId) ? generationId : null,
      outputs: Array.isArray(body['unsigned_urls']) ? body['unsigned_urls'].length : 0,
      costUsd: isFiniteNumber(usage['cost']) ? usage['cost'] : null,
      error: isString(error)
        ? error
        : isRecord(error) && isString(error['message'])
          ? error['message']
          : null,
    };
  }

  function getSpec(url: string, auth: Auth, signal: AbortSignal | undefined, retry = true): Spec {
    return {
      method: 'GET',
      url,
      auth,
      attribution: auth !== null && 'keyId' in auth,
      signal,
      rule: 'read',
      retry,
      free: false,
    };
  }

  async function getJson<T>(
    spec: Spec,
    isValid: (body: Record<string, unknown>) => boolean,
  ): Promise<T> {
    const { value } = await send(spec, (res) => readJson<T>(res, isValid));
    return value as T;
  }

  async function postJson<T>(
    spec: Spec,
    isValid: (body: Record<string, unknown>) => boolean,
  ): Promise<Delivered<T>> {
    return (await send(spec, (res) => readJson<T>(res, isValid))) as Delivered<T>;
  }

  return {
    async chat(body, opts) {
      const models = [body.model, ...(body.models ?? [])];
      const wire = withNoRetention({ ...body, stream: false }, opts.run.keyId, models);
      const spec = callSpec(opts, `${API_BASE}/chat/completions`, wire, 'chat', models);
      const { value, res, startedAt } = await postJson<ChatResponse>(spec, hasChoices);
      await reportUsage(opts.run, {
        model: usageModel(body, value.model),
        usage: value.usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id') ?? value.id,
        allFree: spec.bill.allFree,
      });
      return value;
    },

    async chatStream(body, opts) {
      const models = [body.model, ...(body.models ?? [])];
      const wire = withNoRetention({ ...body, stream: true }, opts.run.keyId, models);
      const spec = callSpec(opts, `${API_BASE}/chat/completions`, wire, 'chat', models);
      const { res, startedAt } = await send(spec, null);
      const generationId = res.headers.get('X-Generation-Id');
      const assembler = new ChatStreamAssembler(opts.onEvent, generationId);
      let done = false;
      let failure: Error | null = null;
      try {
        if (!isEventStream(res)) {
          // A provider that cannot stream may answer with one JSON body; replay it as events.
          const json = await readJson<ChatResponse>(res, hasChoices);
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
                  annotations: choice?.message.annotations,
                },
                finish_reason: choice?.finish_reason ?? null,
              },
            ],
            usage: json.usage,
          });
          done = true;
        } else if (res.body) {
          await readSse(
            res.body,
            (event) => {
              if (event.data === '[DONE]') {
                done = true;
                return 'stop';
              }
              const chunk = parseJson(event.data);
              if (chunk !== undefined) assembler.push(chunk);
              return undefined;
            },
            spec.signal,
          );
        }
        // Ended without [DONE] and without the terminal usage chunk: the connection was cut.
        if (!done && !(assembler.finished && assembler.lastUsage)) {
          throw new NetworkError('The connection dropped before the answer was complete.');
        }
      } catch (error) {
        failure = asFailure(
          error,
          spec.signal,
          'The connection dropped while the answer streamed.',
        );
        markOutcome(spec, failure, true);
      }
      const result = assembler.result();
      // Once the response started the provider may bill, so usage is reported in every outcome.
      await reportUsage(opts.run, {
        model: usageModel(body, result.model || undefined),
        usage: assembler.lastUsage,
        latencyMs: Date.now() - startedAt,
        generationId: generationId ?? (result.id || null),
        allFree: spec.bill.allFree,
      });
      // The error is the outcome; what arrived before it stays readable through `partialStreamResult`.
      if (failure) throw withPartialResult(failure, result);
      return result;
    },

    async images(body, opts) {
      const spec = callSpec(opts, `${API_BASE}/images`, body, 'paid', [body.model]);
      const { res, startedAt } = await send(spec, null);
      const generationId = res.headers.get('X-Generation-Id');
      const images: GeneratedImage[] = [];
      const usages: WireUsage[] = [];
      let created = 0;
      let done = false;
      let failure: Error | null = null;

      try {
        if (isEventStream(res)) {
          if (res.body) {
            await readSse(
              res.body,
              (event) => {
                if (event.data === '[DONE]') {
                  done = true;
                  return 'stop';
                }
                const data = parseJson(event.data);
                if (!isRecord(data)) return undefined;
                const error = bodyError(data);
                if (data['type'] === 'error' || error) {
                  throw apiErrorFromBody(
                    statusFromCode(error?.['code']),
                    { error },
                    { midStream: true, generationId },
                  );
                }
                const b64 = data['b64_json'];
                const type = data['media_type'];
                if (data['type'] === 'image_generation.partial_image' && isString(b64) && b64) {
                  const decoded = base64ToBlob(b64, isString(type) && type ? type : undefined);
                  opts.onPartial?.({ blob: decoded.blob, mediaType: decoded.mediaType });
                } else if (data['type'] === 'image_generation.completed') {
                  images.push(...decodeImages([data]));
                  if (isFiniteNumber(data['created'])) created = data['created'];
                  if (isRecord(data['usage'])) usages.push(data['usage']);
                }
                return undefined;
              },
              spec.signal,
            );
          }
          if (!done && images.length === 0) {
            throw new NetworkError('The connection dropped before the image was ready.');
          }
        } else {
          const json = await readJson<Record<string, unknown>>(res, hasData);
          images.push(...decodeImages(json['data']));
          if (isFiniteNumber(json['created'])) created = json['created'];
          if (isRecord(json['usage'])) usages.push(json['usage']);
        }
      } catch (error) {
        failure = asFailure(error, spec.signal, 'The connection dropped while the image streamed.');
        markOutcome(spec, failure, true);
      }

      const usage = mergeUsage(usages);
      // Completed images are billed and reported even if a later event failed. A generation that failed
      // (an error answer) is not billed (§3.4); anything else without usage (dropped, aborted) is unknown.
      if (usage || !(failure instanceof ApiError)) {
        await reportUsage(opts.run, {
          model: body.model,
          usage,
          latencyMs: Date.now() - startedAt,
          generationId,
          allFree: spec.bill.allFree,
        });
      }
      if (failure && (isAbortError(failure) || images.length === 0)) throw failure;
      if (images.length === 0) {
        throw new ApiError('The model returned no image.', 502, detailFor(res));
      }
      const result: ImageResult = { created, images, usage, generationId };
      if (failure instanceof OrError) result.error = failure;
      return result;
    },

    async speech(body, opts) {
      const format = body.response_format ?? defaultSpeechFormat(body.model);
      const wire = withNoRetention({ ...body, response_format: format }, opts.run.keyId, [
        body.model,
      ]);
      const spec = callSpec(opts, `${API_BASE}/audio/speech`, wire, 'paid', [body.model]);
      const {
        value: bytes,
        res,
        startedAt,
      } = (await send(spec, (r) => r.arrayBuffer())) as Delivered<ArrayBuffer>;
      const contentType = parseContentType(res.headers.get('Content-Type'));
      const mimeType = contentType.type || (format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
      const rate = Number(contentType.params['rate']);
      const channels = Number(contentType.params['channels']);
      const generationId = res.headers.get('X-Generation-Id');

      // Raw bytes carry no cost (§4.3): estimate from the most expensive endpoint, or book it as unknown.
      const estimate = spec.bill.allFree
        ? 0
        : await core.models
            .estimate({
              kind: 'speech',
              model: body.model,
              characters: [...body.input].length,
              bytes: new TextEncoder().encode(body.input).length,
            })
            .catch(() => null);
      const usage: Usage = {
        model: body.model,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: estimate ?? 0,
        costEstimated: estimate !== null && !spec.bill.allFree,
        latencyMs: Date.now() - startedAt,
      };
      if (estimate === null) usage.costUnknown = true;
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
        throw new InvalidInputError(
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
            data: await readAsBase64(body.audio),
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
        [body.model],
      );
      const spec = callSpec(opts, `${API_BASE}/audio/transcriptions`, wire, 'paid', [body.model]);
      const { value, res, startedAt } = await postJson<Record<string, unknown>>(spec, (b) =>
        isString(b['text']),
      );
      const usage = isRecord(value['usage']) ? (value['usage'] as WireUsage) : null;
      await reportUsage(opts.run, {
        model: body.model,
        usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id'),
        allFree: spec.bill.allFree,
      });
      return normalizeTranscription(value, usage);
    },

    async decide(body, opts) {
      const wire = withNoRetention(body, opts.run.keyId, [body.model]);
      const spec = callSpec(opts, DECISIONS_URL, wire, 'paid', [body.model]);
      const { value, res, startedAt } = await postJson<DecisionResponse>(spec, (b) =>
        isRecord(b['answers']),
      );
      await reportUsage(opts.run, {
        model: body.model,
        usage: value.usage,
        latencyMs: Date.now() - startedAt,
        generationId: res.headers.get('X-Generation-Id') ?? value.id,
        allFree: spec.bill.allFree,
      });
      return value;
    },

    videos: {
      async submit(body: VideoRequest, opts) {
        for (const ref of body.input_references ?? []) {
          const target =
            ref.type === 'audio_url'
              ? ref.audio_url.url
              : ref.type === 'video_url'
                ? ref.video_url.url
                : '';
          if (target && !target.startsWith('https://')) {
            throw new InvalidInputError(
              'Video and audio references must be public https:// links (uploads are not accepted).',
            );
          }
        }
        // No usage yet: the cost arrives with the completed status (VideoJobStatus.costUsd).
        const spec = callSpec(opts, `${API_BASE}/videos`, body, 'paid', [body.model]);
        const { value } = await postJson<Record<string, unknown>>(spec, isVideoBody);
        return normalizeVideo(value);
      },

      async status(jobId, opts) {
        const value = await getJson<Record<string, unknown>>(
          getSpec(
            `${API_BASE}/videos/${encodeURIComponent(jobId)}`,
            { keyId: opts.keyId },
            opts.signal,
          ),
          isVideoBody,
        );
        return normalizeVideo(value);
      },

      async content(jobId, opts) {
        const index = opts.index ?? 0;
        // Constructed rather than taken from unsigned_urls so the request stays on openrouter.ai (CSP).
        const spec = getSpec(
          `${API_BASE}/videos/${encodeURIComponent(jobId)}/content?index=${index}`,
          { keyId: opts.keyId },
          opts.signal,
        );
        const { value } = (await send(spec, async (res) => {
          const type = parseContentType(res.headers.get('Content-Type')).type || 'video/mp4';
          return new Blob([await res.arrayBuffer()], { type });
        })) as Delivered<Blob>;
        return value;
      },
    },

    catalog: {
      async models(params, opts) {
        const query = new URLSearchParams({ output_modalities: 'all', ...params });
        const spec = getSpec(`${API_BASE}/models?${query}`, null, undefined, opts?.retry !== false);
        return (await getJson<{ data: RawModel[] }>(spec, hasData)).data;
      },
      async modelEndpoints(modelId, opts) {
        const spec = getSpec(
          `${API_BASE}/models/${modelPath(modelId)}/endpoints`,
          null,
          undefined,
          opts?.retry !== false,
        );
        const value = await getJson<{ data: { endpoints?: unknown } }>(spec, hasDataObject);
        const endpoints = value.data.endpoints;
        return Array.isArray(endpoints) ? (endpoints as RawModelEndpoint[]) : [];
      },
      async imageModels(opts) {
        const spec = getSpec(`${API_BASE}/images/models`, null, undefined, opts?.retry !== false);
        return (await getJson<{ data: RawImageModel[] }>(spec, hasData)).data;
      },
      async videoModels(opts) {
        const spec = getSpec(`${API_BASE}/videos/models`, null, undefined, opts?.retry !== false);
        return (await getJson<{ data: RawVideoModel[] }>(spec, hasData)).data;
      },
    },

    account: {
      async key(secret, signal) {
        const value = await getJson<KeyStatusResponse>(
          getSpec(`${API_BASE}/key`, { secret }, signal),
          hasDataObject,
        );
        // Identifiers of the account are never kept.
        const data = { ...value.data };
        delete data['creator_user_id'];
        delete data['workspace_id'];
        delete data['organization_id'];
        return { data };
      },

      async credits(secret, signal) {
        try {
          const value = await getJson<CreditsResponse>(
            getSpec(`${API_BASE}/credits`, { secret }, signal),
            hasDataObject,
          );
          return { data: value.data };
        } catch (error) {
          // Documented as management-key only; works for ordinary keys today (§10). Treat refusal as unknown.
          if (error instanceof ApiError && (error.status === 401 || error.status === 403))
            return null;
          throw error;
        }
      },

      async exchangeAuthCode(input) {
        const { value } = await postJson<{ key: string }>(
          {
            method: 'POST',
            url: `${API_BASE}/auth/keys`,
            auth: null,
            json: {
              code: input.code,
              code_verifier: input.codeVerifier,
              code_challenge_method: input.codeChallengeMethod,
            },
            attribution: false,
            rule: 'never',
            retry: false,
            free: false,
          },
          (b) => isString(b['key']) && b['key'] !== '',
        );
        // Only the key: the body's user_id is never kept.
        return { key: value.key };
      },
    },
  };
}

function mergeUsage(usages: WireUsage[]): WireUsage | null {
  if (usages.length === 0) return null;
  if (usages.length === 1) return usages[0] ?? null;
  const sum = (key: 'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'cost'): number =>
    usages.reduce((total, u) => total + (isFiniteNumber(u[key]) ? u[key] : 0), 0);
  return {
    prompt_tokens: sum('prompt_tokens'),
    completion_tokens: sum('completion_tokens'),
    total_tokens: sum('total_tokens'),
    cost: sum('cost'),
  };
}

function speakerOf(item: Record<string, unknown>): string | undefined {
  const label = item['speaker_label'];
  if (isString(label) && label) return label;
  const speaker = item['speaker'];
  if (isFiniteNumber(speaker) || (isString(speaker) && speaker)) return String(speaker);
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
    const { start, end, text } = item;
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
    const segment: TranscriptionSegment = { start, end, text: isString(text) ? text.trim() : '' };
    const speaker = speakerOf(item);
    if (speaker !== undefined) segment.speaker = speaker;
    segments.push(segment);
  }
  const words: TranscriptionWord[] = [];
  for (const item of Array.isArray(body['words']) ? body['words'] : []) {
    if (!isRecord(item) || item['type'] === 'audio_event') continue;
    const { start, end, word: text } = item;
    if (!isFiniteNumber(start) || !isFiniteNumber(end)) continue;
    const word: TranscriptionWord = { start, end, word: isString(text) ? text.trim() : '' };
    const speaker = speakerOf(item);
    if (speaker !== undefined) word.speaker = speaker;
    words.push(word);
  }
  const text = body['text'];
  const language = body['language'];
  const duration = body['duration'];
  return {
    text: isString(text) ? text.trim() : '',
    language: isString(language) ? language : null,
    duration: isFiniteNumber(duration)
      ? duration
      : isFiniteNumber(usage?.seconds)
        ? usage.seconds
        : null,
    segments,
    words,
    usage,
  };
}
