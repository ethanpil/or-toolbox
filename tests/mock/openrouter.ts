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
 * - Responses carry the same CORS headers as the real API (recorded in
 *   tests/fixtures/openrouter/cors-headers.json). In particular
 *   `Retry-After` is sent but is NOT in
 *   `Access-Control-Expose-Headers`, so page code cannot read it, exactly as
 *   in production.
 */
import type { BrowserContext, Request, Route } from '@playwright/test';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

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
  /** Objects are sent as JSON, strings as-is. */
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

/** What the real API answers to a CORS preflight. A request header missing here fails, as it would live. */
const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'access-control-allow-headers':
    'Authorization,User-Agent,X-Api-Key,X-CSRF-Token,X-Requested-With,Accept,Accept-Version,' +
    'Content-Length,Content-MD5,Content-Type,Date,X-Api-Version,HTTP-Referer,X-Windowai-Title,' +
    'X-Openrouter-Title,X-Title,X-Openrouter-Categories,X-Openrouter-App-Visibility,X-Session-Id,' +
    'X-Stainless-Lang,X-Stainless-Package-Version,X-Stainless-OS,X-Stainless-Arch,' +
    'X-Stainless-Runtime,X-Stainless-Runtime-Version,X-Stainless-Retry-Count,X-Stainless-Timeout,' +
    'X-Stainless-Helper-Method,Protection-Key,Idempotency-Key,traceparent,tracestate,b3',
  vary: 'Access-Control-Request-Headers',
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class OpenRouterMock {
  private readonly handlers: Handler[] = [];
  private readonly recorded: RecordedCall[] = [];

  /** Requests that had no mock, as `METHOD url`. The fixture fails the test if this is not empty. */
  readonly unmocked: string[] = [];

  /** Starts intercepting. Called by the fixture. */
  async install(context: BrowserContext): Promise<void> {
    await context.route(`${OPENROUTER_ORIGIN}/**`, (route, request) => this.handle(route, request));
  }

  /** Answers `method path` with a JSON body. */
  json(method: Method, path: PathMatcher, body: unknown, options: ResponseOptions = {}): this {
    return this.add(method, path, () => ({ ...options, body }));
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
      headers: await request.allHeaders(),
      body: parseBody(request.postData()),
    };
    this.recorded.push(call);

    const { status = 200, headers = {}, delayMs, body } = handler.respond(call);
    if (delayMs) await delay(delayMs);

    const isText = typeof body === 'string';
    try {
      await route.fulfill({
        status,
        headers: {
          'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json',
          ...CORS_HEADERS,
          ...headers,
        },
        body: body === undefined ? '' : isText ? body : JSON.stringify(body),
      });
    } catch {
      // The page navigated away or closed while we were waiting: nothing to answer.
    }
  }
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
