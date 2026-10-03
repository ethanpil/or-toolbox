/**
 * A mocked OpenRouter for Playwright tests.
 *
 * Every request a page makes to https://openrouter.ai is intercepted. A
 * request with no matching mock is aborted and fails the test, so no test can
 * ever reach the real API.
 *
 * Use it through the `mock` fixture (see ./index.ts):
 *
 * ```ts
 * test('lists models', async ({ page, mock }) => {
 *   mock.json('GET', '/api/v1/models', { data: [...] });
 *   await page.goto('models/');
 *   expect(mock.calls('/api/v1/models')).toHaveLength(1);
 * });
 * ```
 *
 * Rules:
 * - A path is matched against the URL's pathname (the query string is
 *   ignored): a string must be equal, a RegExp must match.
 * - The mock registered last wins, so a test can override the seeded
 *   defaults and its own earlier mocks.
 * - CORS behaves as on the real API (headers recorded in
 *   tests/fixtures/openrouter/cors-headers.json):
 *   - Responses carry the real `Access-Control-*` headers. `Retry-After` is
 *     sent but is NOT in `Access-Control-Expose-Headers`, so page code cannot
 *     read it, exactly as in production.
 *   - Chromium and Firefox answer CORS preflights inside Playwright, so the
 *     route never sees the OPTIONS request. The real allow-headers list is
 *     therefore enforced on the actual request: a request carrying a header
 *     the real preflight would refuse is aborted (the page sees a network
 *     error, as it would live) and fails the test. WebKit does pass OPTIONS
 *     through; it gets the real preflight answer.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { BrowserContext, Request, Route } from '@playwright/test';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

/** Binary fixtures served by `mock.file()`. */
export const MEDIA_FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'media');

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type PathMatcher = string | RegExp;

export interface ResponseOptions {
  /** HTTP status. Default 200. */
  status?: number;
  /** Extra response headers (lower-case names override the defaults). */
  headers?: Record<string, string>;
  /** Wait this long before answering. */
  delayMs?: number;
}

/** One response of a `sequence()`. */
export interface SequenceResponse extends ResponseOptions {
  /**
   * Objects are sent as JSON, strings as text, and `Uint8Array`/`Buffer` as
   * bytes (which need an explicit `content-type` header).
   */
  body?: unknown;
}

/** A request the mock answered. */
export interface RecordedCall {
  method: string;
  url: string;
  /** Pathname, e.g. `/api/v1/chat/completions`. */
  path: string;
  /** Query parameters. */
  query: Record<string, string>;
  /** Request headers, lower-case names. */
  headers: Record<string, string>;
  /** The body parsed as JSON when possible, otherwise the raw text; null if there was none. */
  body: unknown;
}

interface Handler {
  method: Method | '*';
  path: PathMatcher;
  respond: (call: RecordedCall) => SequenceResponse;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'X-Generation-Id,X-Provider-Name,request-id,cf-ray',
};

/** The real preflight's allow-list (2026-10-02). */
const ALLOWED_REQUEST_HEADERS =
  'Authorization,User-Agent,X-Api-Key,X-CSRF-Token,X-Requested-With,Accept,Accept-Version,' +
  'Content-Length,Content-MD5,Content-Type,Date,X-Api-Version,HTTP-Referer,X-Windowai-Title,' +
  'X-Openrouter-Title,X-Title,X-Openrouter-Categories,X-Openrouter-App-Visibility,X-Session-Id,' +
  'X-Stainless-Lang,X-Stainless-Package-Version,X-Stainless-OS,X-Stainless-Arch,' +
  'X-Stainless-Runtime,X-Stainless-Runtime-Version,X-Stainless-Retry-Count,X-Stainless-Timeout,' +
  'X-Stainless-Helper-Method,Protection-Key,Idempotency-Key,traceparent,tracestate,b3';

const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
  vary: 'Access-Control-Request-Headers',
};

/** Headers a page may send without a preflight allowing them. */
const NEVER_PREFLIGHTED = new Set([
  ...ALLOWED_REQUEST_HEADERS.toLowerCase().split(','),
  // CORS-safelisted request headers.
  'accept',
  'accept-language',
  'content-language',
  'content-type',
  'range',
  // Set by the browser itself, never by page code.
  'accept-charset',
  'accept-encoding',
  'cache-control',
  'connection',
  'cookie',
  'date',
  'dnt',
  'host',
  'keep-alive',
  'origin',
  'pragma',
  'priority',
  'referer',
  'te',
  'upgrade-insecure-requests',
]);

function needsPreflightApproval(name: string): boolean {
  return !(
    NEVER_PREFLIGHTED.has(name) ||
    name.startsWith(':') ||
    name.startsWith('sec-') ||
    name.startsWith('proxy-')
  );
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRouterMock {
  private readonly handlers: Handler[] = [];
  private readonly recorded: RecordedCall[] = [];

  /** Requests that had no mock, as `METHOD url`. The fixture fails the test if this is not empty. */
  readonly unmocked: string[] = [];

  /** Requests the real CORS preflight would refuse, as `METHOD url: header`. Also fails the test. */
  readonly refusedByCors: string[] = [];

  /** Starts intercepting. Called by the fixture. */
  async install(context: BrowserContext): Promise<void> {
    await context.route(`${OPENROUTER_ORIGIN}/**`, (route, request) => this.handle(route, request));
  }

  /** Answers `method path` with a JSON body. */
  json(method: Method, path: PathMatcher, body: unknown, options: ResponseOptions = {}): this {
    return this.add(method, path, () => ({ ...options, body }));
  }

  /**
   * Answers `method path` with the bytes of a file in tests/fixtures/media/,
   * e.g. TTS audio or a video job's content:
   *
   * ```ts
   * mock.file('GET', '/api/v1/videos/job-1/content', 'video-1s.mp4');
   * mock.file('POST', '/api/v1/audio/speech', 'speech.mp3');
   * ```
   *
   * The content type comes from the extension unless `headers` sets one.
   */
  file(method: Method, path: PathMatcher, fileName: string, options: ResponseOptions = {}): this {
    const bytes = readFileSync(join(MEDIA_FIXTURES_DIR, fileName));
    const contentType = CONTENT_TYPES[extname(fileName).toLowerCase()];
    if (!contentType && !options.headers?.['content-type']) {
      throw new Error(
        `mock.file(): no content type known for ${fileName}; pass headers['content-type']`,
      );
    }
    return this.add(method, path, () => ({
      ...options,
      body: bytes,
      headers: { ...(contentType ? { 'content-type': contentType } : {}), ...options.headers },
    }));
  }

  /**
   * Answers `POST path` with a server-sent event stream, as streamed chat
   * completions use.
   *
   * Each chunk becomes one event: objects are sent as `data: <json>`, strings
   * verbatim (for comments such as `': OPENROUTER PROCESSING'`). A final
   * `data: [DONE]` is appended unless `done` is false.
   *
   * Limitation: Playwright delivers a mocked body in one piece, so the page
   * receives all events at once (after `delayMs`). Parsing is exercised;
   * pacing between events is not.
   */
  sse(
    path: PathMatcher,
    chunks: readonly unknown[],
    options: ResponseOptions & { done?: boolean } = {},
  ): this {
    const events = chunks.map((chunk) =>
      typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}`,
    );
    if (options.done !== false) events.push('data: [DONE]');
    const body = events.map((event) => `${event}\n\n`).join('');
    return this.add('POST', path, () => ({
      ...options,
      body,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        ...options.headers,
      },
    }));
  }

  /**
   * Answers successive requests to `path` with successive responses; the last
   * one repeats. For polling endpoints such as slow video jobs:
   *
   * ```ts
   * mock.sequence('/api/v1/videos/job-1', [
   *   { body: { status: 'pending' } },
   *   { body: { status: 'in_progress' } },
   *   { body: { status: 'completed' } },
   * ]);
   * ```
   */
  sequence(
    path: PathMatcher,
    responses: readonly SequenceResponse[],
    options: { method?: Method } = {},
  ): this {
    if (responses.length === 0) throw new Error('mock.sequence() needs at least one response');
    let next = 0;
    return this.add(options.method ?? 'GET', path, () => {
      const response = responses[Math.min(next, responses.length - 1)]!;
      next += 1;
      return response;
    });
  }

  /**
   * Answers any method on `path` with an error status. Without a body, the
   * API's usual error shape is sent. `retryAfter` (seconds) adds a
   * `Retry-After` header, for 429 and 503.
   */
  error(
    path: PathMatcher,
    status: number,
    body?: unknown,
    options: Omit<ResponseOptions, 'status'> & { retryAfter?: number; method?: Method } = {},
  ): this {
    return this.add(options.method ?? '*', path, () => ({
      delayMs: options.delayMs,
      status,
      body: body ?? { error: { code: status, message: `Mocked error ${status}` } },
      headers: {
        ...(options.retryAfter !== undefined ? { 'retry-after': String(options.retryAfter) } : {}),
        ...options.headers,
      },
    }));
  }

  /** The requests answered so far, oldest first, optionally filtered by path and method. */
  calls(path?: PathMatcher, method?: Method): RecordedCall[] {
    return this.recorded.filter(
      (call) =>
        (path === undefined || matches(path, call.path)) &&
        (method === undefined || call.method === method),
    );
  }

  private add(method: Method | '*', path: PathMatcher, respond: Handler['respond']): this {
    this.handlers.push({ method, path, respond });
    return this;
  }

  private async handle(route: Route, request: Request): Promise<void> {
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: PREFLIGHT_HEADERS });
      return;
    }

    const headers = await request.allHeaders();
    const refused = Object.keys(headers).filter(needsPreflightApproval);
    if (refused.length > 0) {
      this.refusedByCors.push(`${method} ${request.url()}: ${refused.join(', ')}`);
      await route.abort('failed');
      return;
    }

    const url = new URL(request.url());
    const handler = this.handlers.findLast(
      (candidate) =>
        (candidate.method === '*' || candidate.method === method) &&
        matches(candidate.path, url.pathname),
    );
    if (!handler) {
      this.unmocked.push(`${method} ${request.url()}`);
      await route.abort('failed');
      return;
    }

    const call: RecordedCall = {
      method,
      url: request.url(),
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body: parseBody(request.postData()),
    };
    this.recorded.push(call);

    const response = handler.respond(call);
    if (response.delayMs) await delay(response.delayMs);

    try {
      await route.fulfill({
        status: response.status ?? 200,
        ...encodeBody(response),
      });
    } catch {
      // The page navigated away or closed while we were waiting: nothing to answer.
    }
  }
}

/** Turns a mocked body into what route.fulfill() takes, with the CORS headers added. */
function encodeBody({ body, headers = {} }: SequenceResponse): {
  body: string | Buffer;
  headers: Record<string, string>;
} {
  const withCors = (contentType: string): Record<string, string> => ({
    'content-type': contentType,
    ...CORS_HEADERS,
    ...headers,
  });
  if (body instanceof Uint8Array) {
    if (!headers['content-type']) throw new Error('A binary mock body needs a content-type header');
    return { body: Buffer.from(body), headers: withCors(headers['content-type']) };
  }
  if (typeof body === 'string') return { body, headers: withCors('text/plain; charset=utf-8') };
  return {
    body: body === undefined ? '' : JSON.stringify(body),
    headers: withCors('application/json'),
  };
}

function matches(matcher: PathMatcher, path: string): boolean {
  return typeof matcher === 'string' ? matcher === path : matcher.test(path);
}

function parseBody(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
