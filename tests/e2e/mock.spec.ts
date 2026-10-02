/**
 * The mocked OpenRouter itself: every helper later stages rely on, exercised
 * from a real page (so CORS and, in the production build, the CSP apply).
 */
import type { Page } from '@playwright/test';
import { expect, OPENROUTER_ORIGIN, OpenRouterMock, test, TEST_API_KEY } from '../mock/index.ts';

interface PageResponse {
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  text: string;
}

/** fetch() from inside the page, returning plain data. */
function pageFetch(
  page: Page,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<PageResponse> {
  return page.evaluate(
    async ({ url, init }) => {
      const response = await fetch(url, init);
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        retryAfter: response.headers.get('retry-after'),
        text: await response.text(),
      };
    },
    { url: OPENROUTER_ORIGIN + path, init },
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('');
});

test('seeds the model catalog and key status', async ({ page, mock }) => {
  const models = await pageFetch(page, '/api/v1/models?output_modalities=text');
  expect(models.status).toBe(200);
  expect((JSON.parse(models.text) as { data: { id: string }[] }).data.map((m) => m.id)).toContain(
    'test/text-model:free',
  );

  const key = await pageFetch(page, '/api/v1/key', {
    headers: { Authorization: `Bearer ${TEST_API_KEY}` },
  });
  expect(key.status).toBe(200);

  // Recorded for assertions: query, headers, method.
  expect(mock.calls('/api/v1/models')[0]?.query).toEqual({ output_modalities: 'text' });
  expect(mock.calls('/api/v1/key')[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
});

test('json() answers with a body, status and headers, and records the parsed request', async ({
  page,
  mock,
}) => {
  mock.json(
    'POST',
    '/api/v1/chat/completions',
    { id: 'gen-1', choices: [{ message: { role: 'assistant', content: 'Hi' } }] },
    { status: 201, headers: { 'x-generation-id': 'gen-1' } },
  );

  const response = await pageFetch(page, '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_API_KEY}` },
    body: JSON.stringify({
      model: 'test/text-model',
      messages: [{ role: 'user', content: 'Hello' }],
    }),
  });

  expect(response.status).toBe(201);
  expect(response.contentType).toContain('application/json');
  expect(JSON.parse(response.text)).toMatchObject({ id: 'gen-1' });

  const [call] = mock.calls('/api/v1/chat/completions', 'POST');
  expect(call?.body).toEqual({
    model: 'test/text-model',
    messages: [{ role: 'user', content: 'Hello' }],
  });
  expect(mock.calls('/api/v1/chat/completions', 'GET')).toHaveLength(0);
});

test('the mock registered last wins', async ({ page, mock }) => {
  mock.json('GET', '/api/v1/models', { data: [] });
  const response = await pageFetch(page, '/api/v1/models');
  expect(JSON.parse(response.text)).toEqual({ data: [] });
});

test('sse() streams chat completion chunks ending in [DONE]', async ({ page, mock }) => {
  mock.sse('/api/v1/chat/completions', [
    ': OPENROUTER PROCESSING',
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.00001 } },
  ]);

  const response = await pageFetch(page, '/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'test/text-model', stream: true, messages: [] }),
  });

  expect(response.contentType).toContain('text/event-stream');
  const events = response.text.trim().split('\n\n');
  expect(events).toHaveLength(5);
  expect(events[0]).toBe(': OPENROUTER PROCESSING');
  expect(JSON.parse(events[1]!.replace(/^data: /, ''))).toEqual({
    choices: [{ delta: { content: 'Hel' } }],
  });
  expect(events.at(-1)).toBe('data: [DONE]');
});

test('sequence() steps through responses and repeats the last', async ({ page, mock }) => {
  mock.sequence('/api/v1/videos/job-1', [
    { body: { status: 'pending' } },
    { body: { status: 'in_progress' } },
    { body: { status: 'completed' } },
  ]);

  const statuses: string[] = [];
  for (let poll = 0; poll < 4; poll++) {
    const response = await pageFetch(page, '/api/v1/videos/job-1');
    statuses.push((JSON.parse(response.text) as { status: string }).status);
  }

  expect(statuses).toEqual(['pending', 'in_progress', 'completed', 'completed']);
  expect(mock.calls('/api/v1/videos/job-1')).toHaveLength(4);
});

test('error() answers with a status; Retry-After is sent but hidden by CORS, as on the real API', async ({
  page,
  mock,
}) => {
  mock.error('/api/v1/chat/completions', 429, undefined, { retryAfter: 7 });
  mock.error(/^\/api\/v1\/videos\//, 503, { error: { code: 503, message: 'Busy' } });

  const limited = await pageFetch(page, '/api/v1/chat/completions', { method: 'POST', body: '{}' });
  expect(limited.status).toBe(429);
  expect(JSON.parse(limited.text)).toEqual({ error: { code: 429, message: 'Mocked error 429' } });
  // openrouter.ai does not list Retry-After in Access-Control-Expose-Headers,
  // so a browser cannot read it. The API client must not depend on it.
  expect(limited.retryAfter).toBeNull();

  const busy = await pageFetch(page, '/api/v1/videos/job-9');
  expect(busy.status).toBe(503);
  expect(JSON.parse(busy.text)).toEqual({ error: { code: 503, message: 'Busy' } });
});

test('delayMs delays the answer', async ({ page, mock }) => {
  mock.json('GET', '/api/v1/models', { data: [] }, { delayMs: 400 });
  const started = Date.now();
  await pageFetch(page, '/api/v1/models');
  expect(Date.now() - started).toBeGreaterThanOrEqual(400);
});

test('a request with no mock is blocked and reported', async ({ browser, baseURL }) => {
  // A private context and mock, so this deliberate failure does not fail the
  // test through the shared fixture.
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block' });
  const mock = new OpenRouterMock();
  await mock.install(context);
  const page = await context.newPage();
  await page.goto('');

  const failure = await page.evaluate(
    (url) =>
      fetch(url).then(
        () => 'fetched',
        () => 'blocked',
      ),
    `${OPENROUTER_ORIGIN}/api/v1/credits`,
  );

  expect(failure).toBe('blocked');
  expect(mock.unmocked).toEqual([`GET ${OPENROUTER_ORIGIN}/api/v1/credits`]);
  await context.close();
});
