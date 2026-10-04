/**
 * Chat against the mocked OpenRouter: streaming, Stop, branches, the mid-chat model switch, image and PDF
 * attachments (asserted on the request body), threads across a reload, export, History, free-only mode and axe.
 *
 * The mock serves an SSE body in one piece, so Stop cannot happen half-way through a mocked stream. The Stop spec
 * therefore holds the stream open from inside the page (a `fetch` wrapper that sends the first event and then
 * waits for the abort); no request leaves the page.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, MEDIA_FIXTURES_DIR, type RecordedCall, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { makeRun, seedDb } from './seed.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const CHAT = '/api/v1/chat/completions';
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'openrouter');
const RECORDED_STREAM = readFileSync(join(FIXTURES, 'chat-stream.recorded.sse.txt'), 'utf8');
/** The parser's annotations of a recorded answer about tests/fixtures/media/invoice.pdf. */
const PDF_ANNOTATIONS = (
  JSON.parse(readFileSync(join(FIXTURES, 'chat-completion-pdf.recorded.json'), 'utf8')) as {
    response: { choices: { message: { annotations: unknown[] } }[] };
  }
).response.choices[0]!.message.annotations;

/** A streamed reply: one content chunk, the finish chunk and the usage chunk (the shape in docs §2.3). */
function reply(text: string, model = 'test/text-model', cost = 0.00042): unknown[] {
  const base = {
    id: 'gen-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model,
    provider: 'Test',
  };
  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    { ...base, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }] },
    {
      ...base,
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost },
    },
  ];
}

/** A streamed reply that also brings the PDF parser's annotations (in a delta, before the finish). */
function replyWithAnnotations(text: string): unknown[] {
  const [first, ...rest] = reply(text);
  const chunk = {
    id: 'gen-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test/text-model',
    choices: [{ index: 0, delta: { annotations: PDF_ANNOTATIONS }, finish_reason: null }],
  };
  return [first, chunk, ...rest];
}

const body = (call: RecordedCall | undefined): Record<string, unknown> =>
  (call?.body ?? {}) as Record<string, unknown>;
const messagesOf = (call: RecordedCall | undefined): { role: string; content: unknown }[] =>
  body(call)['messages'] as { role: string; content: unknown }[];

const composer = (page: Page) => page.getByTestId('tool-prompt');
const messages = (page: Page) => page.getByTestId('chat-message');
const content = (page: Page, index: number) =>
  messages(page).nth(index).getByTestId('message-content');

async function openChat(page: Page, path = 'tools/chat/'): Promise<void> {
  await page.goto(path);
  // The composer's model chip shows the catalog name once the catalog is in.
  await expect(page.getByTestId('composer-model')).toContainText('Test: Text Model');
}

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

/**
 * Waits until the stored threads hold `count` finished replies. A reply's text shows while it streams, before the
 * run ends and the thread's last (queued) write lands; a reload before that finds the reply unfinished ("Stopped
 * before any text arrived").
 */
async function repliesStored(page: Page, count: number): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(async () => {
        type Row = {
          key: string;
          value: { nodes: Record<string, { role: string; status?: string }> };
        };
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ortoolbox');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('open failed'));
        });
        const rows = await new Promise<Row[]>((resolve, reject) => {
          const request = db.transaction('kv').objectStore('kv').getAll();
          request.onsuccess = () => resolve(request.result as Row[]);
          request.onerror = () => reject(request.error ?? new Error('read failed'));
        });
        db.close();
        return rows
          .filter((row) => row.key.startsWith('tool:chat:thread:'))
          .flatMap((row) => Object.values(row.value.nodes))
          .filter((node) => node.role === 'assistant' && node.status === 'done').length;
      }),
    )
    .toBe(count);
}

test.beforeEach(async ({ context }) => {
  await seedApp(context, {
    key: true,
    settings: { tools: { chat: { model: 'test/text-model' } } },
  });
});

test('sends a message and streams the reply, with reasoning, usage and the request', async ({
  page,
  mock,
}) => {
  // The API client cancels the stream once it has read `[DONE]`; Chromium may report that as an aborted request.
  const problems = await watchForProblems(page, { allowAborted: [CHAT] });
  mock.sse(CHAT, RECORDED_STREAM.trim().split('\n\n'), { done: false });
  await openChat(page);
  await send(page, 'Say hi in exactly three words.');

  await expect(messages(page)).toHaveCount(2);
  await expect(content(page, 0)).toHaveText('Say hi in exactly three words.');
  await expect(content(page, 1)).toHaveText('Hello there, friend.');
  // Focus stays in the cleared composer, ready for the next message.
  await expect(composer(page)).toHaveValue('');
  await expect(composer(page)).toBeFocused();
  const reasoning = page.getByTestId('message-reasoning');
  await expect(reasoning).toBeVisible();
  await reasoning.locator('summary').click();
  await expect(reasoning).toContainText('The user wants me to say "hi" in exactly three words.');
  // The recorded stream came from a free model: tokens from its usage chunk, no cost.
  await expect(page.getByTestId('message-usage')).toContainText('16 in · 60 out · free');
  await expect(page.getByTestId('message-served')).toContainText('via liquid/lfm-2.5-2.6b:free');
  await expect(page.getByTestId('chat-title')).toHaveText('Say hi in exactly three words.');
  await expect(page.getByTestId('chat-totals')).toContainText('1 reply');
  // A labelled region, not a live region; the start and the end are announced as status instead.
  await expect(page.getByTestId('chat-log')).toHaveAttribute('role', 'region');
  await expect(page.getByTestId('chat-log')).not.toHaveAttribute('aria-live', /.*/);
  await expect(page.getByTestId('chat-log')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('tool-status')).toHaveText('Reply complete.');

  const [call] = mock.calls(CHAT, 'POST');
  expect(body(call)).toMatchObject({
    model: 'test/text-model',
    stream: true,
    messages: [{ role: 'user', content: 'Say hi in exactly three words.' }],
  });
  expect(problems).toEqual([]);
});

test('Stop keeps the partial reply, silently', async ({ page }) => {
  // Holds the chat stream open after its first event until the request is aborted.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/v1/chat/completions')) return original(input, init);
      const encoder = new TextEncoder();
      const chunk = {
        id: 'gen-held',
        model: 'test/text-model',
        choices: [
          { index: 0, delta: { content: 'The first half of a long story' }, finish_reason: null },
        ],
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    };
  });
  await openChat(page);
  await send(page, 'Tell me a long story');
  await expect(content(page, 1)).toHaveText('The first half of a long story');
  await expect(page.getByTestId('stop-button')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('message-stopped')).toBeVisible();
  await expect(content(page, 1)).toHaveText('The first half of a long story');
  await expect(page.getByTestId('tool-status')).toHaveText('Stopped. The partial reply is kept.');
  await expect(page.getByTestId('stop-button')).toBeHidden();
  await expect(page.getByTestId('message-error')).toHaveCount(0);
  await expect(page.getByTestId('error-toast')).toHaveCount(0);
});

test('editing a message makes a branch; ‹ › navigate the versions', async ({ page, mock }) => {
  mock.sse(CHAT, reply('Where would you like to go?'));
  await openChat(page);
  await send(page, 'Plan a trip');
  await expect(content(page, 1)).toHaveText('Where would you like to go?');

  mock.sse(CHAT, reply('Rome it is: three days, five sights.'));
  await messages(page).first().getByTestId('message-edit').click();
  const editor = page.getByTestId('edit-input');
  await expect(editor).toBeFocused();
  await editor.fill('Plan a trip to Rome');
  await page.getByTestId('edit-save').click();

  await expect(content(page, 0)).toHaveText('Plan a trip to Rome');
  await expect(content(page, 1)).toHaveText('Rome it is: three days, five sights.');
  const position = messages(page).first().getByTestId('sibling-position');
  await expect(position).toContainText('2/2');
  expect(messagesOf(mock.calls(CHAT, 'POST')[1])).toEqual([
    { role: 'user', content: 'Plan a trip to Rome' },
  ]);

  await messages(page).first().getByTestId('sibling-prev').click();
  await expect(content(page, 0)).toHaveText('Plan a trip');
  await expect(content(page, 1)).toHaveText('Where would you like to go?');
  await expect(position).toContainText('1/2');
  await expect(messages(page).first().getByTestId('sibling-prev')).toBeDisabled();
  await messages(page).first().getByTestId('sibling-next').click();
  await expect(content(page, 0)).toHaveText('Plan a trip to Rome');
});

test('the mid-chat model switch is recorded on each reply', async ({ page, mock }) => {
  mock.sse(CHAT, reply('Paid answer.'));
  await openChat(page);
  await send(page, 'First question');
  await expect(content(page, 1)).toHaveText('Paid answer.');

  await page.getByTestId('composer-model').click();
  const picker = page.getByTestId('model-picker');
  await picker.getByTestId('model-option-test/text-model:free').click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId('composer-model')).toContainText('Test: Text Model (free)');
  await expect(page.getByTestId('composer-model-reset')).toBeVisible();

  mock.sse(CHAT, reply('Free answer.', 'test/text-model:free', 0));
  await send(page, 'Second question');
  await expect(content(page, 3)).toHaveText('Free answer.');
  await expect(page.getByTestId('message-author')).toHaveText([
    'You',
    'Test: Text Model',
    'You',
    'Test: Text Model (free)',
  ]);
  const calls = mock.calls(CHAT, 'POST');
  expect(calls.map((call) => body(call)['model'])).toEqual([
    'test/text-model',
    'test/text-model:free',
  ]);
  expect(messagesOf(calls[1])).toEqual([
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'Paid answer.' },
    { role: 'user', content: 'Second question' },
  ]);
});

test('an image attachment goes as an image_url part', async ({ page, mock }) => {
  mock.sse(CHAT, reply('A colourful test pattern.'));
  await openChat(page);
  await page
    .getByTestId('composer-file')
    .setInputFiles(join(MEDIA_FIXTURES_DIR, 'generated-image.jpg'));
  await expect(page.getByTestId('composer-attachment')).toContainText('generated-image.jpg');
  await send(page, 'What is in this picture?');
  await expect(content(page, 1)).toHaveText('A colourful test pattern.');
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
  await expect(page.getByTestId('message-attachment')).toContainText('generated-image.jpg');

  const [first] = messagesOf(mock.calls(CHAT, 'POST')[0]);
  const parts = first?.content as { type: string; text?: string; image_url?: { url: string } }[];
  expect(parts[0]).toEqual({ type: 'text', text: 'What is in this picture?' });
  expect(parts[1]?.type).toBe('image_url');
  expect(parts[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
});

test('a pasted PDF is read once; later messages send the parser text', async ({ page, mock }) => {
  mock.sse(CHAT, replyWithAnnotations('Invoice number: 4711 / Total: 128.50 EUR'));
  await openChat(page);
  const pdf = readFileSync(join(MEDIA_FIXTURES_DIR, 'invoice.pdf')).toString('base64');
  // Paste a file (no text) onto the page: the framework hands it to the tool.
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'invoice.pdf', { type: 'application/pdf' }));
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true }),
    );
  }, pdf);
  await expect(page.getByTestId('composer-attachment')).toContainText('invoice.pdf');
  await send(page, 'Invoice number and total?');
  await expect(content(page, 1)).toContainText('Total: 128.50 EUR');

  const call = mock.calls(CHAT, 'POST')[0];
  const parts = messagesOf(call)[0]?.content as { type: string; file?: Record<string, string> }[];
  expect(parts[1]).toEqual({
    type: 'file',
    file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${pdf}` },
  });
  expect(body(call)['stream']).toBe(true);
  expect(body(call)['plugins']).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);

  // The next turn streams, and sends the parser's text instead of uploading the PDF again.
  mock.sse(CHAT, reply('It has no date.'));
  await send(page, 'And the date?');
  await expect(content(page, 3)).toHaveText('It has no date.');
  const next = mock.calls(CHAT, 'POST')[1];
  const sent = messagesOf(next)[0]?.content as { type: string; text?: string }[];
  expect(sent.map((part) => part.type)).toEqual(['text', 'text']);
  expect(sent[1]?.text).toMatch(/^<file name="invoice\.pdf">\n# document\.pdf/);
  expect(sent[1]?.text).toContain('Invoice 4711 total 128.50 EUR');
  expect(body(next)['plugins']).toBeUndefined();

  // The text is kept with the thread: after a reload the PDF still counts.
  await repliesStored(page, 2);
  await page.reload();
  await expect(content(page, 3)).toHaveText('It has no date.');
  await expect(page.getByTestId('attachment-missing')).toHaveCount(0);
});

test('two tabs on one chat: each takes in what the other sent', async ({ page, context, mock }) => {
  mock.sse(CHAT, reply('Answer in tab one.'));
  await openChat(page);
  await send(page, 'From tab one');
  await expect(content(page, 1)).toHaveText('Answer in tab one.');

  const other = await context.newPage();
  await openChat(other);
  await expect(content(other, 1)).toHaveText('Answer in tab one.');
  mock.sse(CHAT, reply('Answer in tab two.'));
  await send(other, 'From tab two');
  await expect(content(other, 3)).toHaveText('Answer in tab two.');

  // Tab one shows it without a reload, and its next message builds on both.
  await expect(content(page, 3)).toHaveText('Answer in tab two.');
  mock.sse(CHAT, reply('Third answer.'));
  await send(page, 'Back in tab one');
  await expect(content(page, 5)).toHaveText('Third answer.');
  expect(messagesOf(mock.calls(CHAT, 'POST')[2])).toHaveLength(5);
  await expect(content(other, 5)).toHaveText('Third answer.');

  await repliesStored(page, 3);
  await page.reload();
  await expect(messages(page)).toHaveCount(6);
});

test('a thread persists across a reload; its attachments are marked as not kept', async ({
  page,
  mock,
}) => {
  mock.sse(CHAT, reply('A test pattern.'));
  await openChat(page);
  await page
    .getByTestId('composer-file')
    .setInputFiles(join(MEDIA_FIXTURES_DIR, 'generated-image.jpg'));
  await send(page, 'Describe it');
  await expect(content(page, 1)).toHaveText('A test pattern.');
  await expect(page.getByTestId('attachment-missing')).toHaveCount(0);

  await repliesStored(page, 1);
  await page.reload();
  await expect(content(page, 0)).toHaveText('Describe it');
  await expect(content(page, 1)).toHaveText('A test pattern.');
  await expect(page.getByTestId('attachment-missing')).toHaveText(
    'Attachment not kept after reload',
  );
  await expect(page.getByTestId('thread-item')).toHaveCount(1);
  await expect(page.getByTestId('thread-title')).toHaveText('Describe it');

  // A new chat, then back to the first one from the list.
  await page.getByTestId('chat-new').click();
  await expect(messages(page)).toHaveCount(0);
  await page.getByTestId('thread-open').click();
  await expect(content(page, 1)).toHaveText('A test pattern.');
});

test('Export writes the conversation as Markdown', async ({ page, mock }) => {
  mock.sse(CHAT, reply('Hello! Here is code:\n\n```js\nconsole.log(1);\n```'));
  await openChat(page);
  await send(page, 'Greet me');
  await expect(messages(page).nth(1).locator('pre')).toHaveText('console.log(1);');
  await expect(page.getByTestId('code-copy')).toBeVisible();

  await page.getByTestId('chat-export').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-md').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Greet me.md');
  const text = readFileSync(await file.path(), 'utf8');
  expect(text).toBe(
    '# Greet me\n\n## You\n\nGreet me\n\n## Assistant (test/text-model)\n\nHello! Here is code:\n\n```js\nconsole.log(1);\n```\n',
  );
});

test('each send is a History run; reopening it fills the composer', async ({ page, mock }) => {
  mock.sse(CHAT, reply('Sure.'));
  await openChat(page);
  await send(page, 'Summarise the meeting notes');
  await expect(content(page, 1)).toHaveText('Sure.');

  await page.goto('history/?tool=chat');
  const row = page.getByTestId('history-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('run-title')).toHaveText('Summarise the meeting notes');
  await row.getByTestId('run-open').click();
  await page.getByTestId('run-reopen').click();

  await expect(page).toHaveURL(/\/tools\/chat\/$/);
  await expect(composer(page)).toHaveValue('Summarise the meeting notes');
  await expect(page.getByTestId('composer-model')).toContainText('Test: Text Model');
  // Reopening starts a new chat: the thread itself is not rebuilt.
  await expect(messages(page)).toHaveCount(0);
});

test('free-only mode blocks a paid model with the shell notice', async ({
  page,
  context,
  mock,
}) => {
  await context.addInitScript(() => {
    const raw = localStorage.getItem('ortoolbox:settings');
    const settings = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem('ortoolbox:settings', JSON.stringify({ ...settings, freeOnly: true }));
  });
  await page.goto('tools/chat/');
  await seedDb(page, {
    runs: [
      makeRun('run-paid', 5, {
        prompt: 'Draft a reply',
        settings: { model: 'test/text-model', system: '', temperature: null, maxTokens: null },
      }),
    ],
  });
  await page.goto('tools/chat/?run=run-paid');
  await expect(composer(page)).toHaveValue('Draft a reply');
  await expect(page.getByTestId('warning-free-only')).toContainText('Free-only mode is on');

  await composer(page).press('Enter');
  const notice = page.getByTestId('error-toast');
  await expect(notice).toContainText('Free-only mode is on');
  await expect(notice).toContainText('test/text-model');
  await expect(messages(page)).toHaveCount(0);
  await expect(composer(page)).toHaveValue('Draft a reply');
  expect(mock.calls(CHAT)).toHaveLength(0);
});

test('an API error shows on the reply with Retry', async ({ page, mock }) => {
  mock.error(CHAT, 400, { error: { code: 400, message: 'This model does not exist.' } });
  await openChat(page);
  await send(page, 'Hello?');
  await expect(page.getByTestId('message-error')).toContainText('This model does not exist.');
  await expect(page.getByTestId('error-toast')).toHaveCount(0);

  mock.sse(CHAT, reply('Hello again.'));
  await page.getByTestId('message-retry').click();
  await expect(content(page, 1)).toHaveText('Hello again.');
  await expect(page.getByTestId('message-error')).toHaveCount(0);
});

test('a conversation passes axe in light and dark', async ({ page, mock }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  mock.sse(
    CHAT,
    replyWithAnnotations('# Plan\n\n- **Day 1:** sights\n- Day 2: food\n\n```py\nprint("hi")\n```'),
  );
  await openChat(page);
  await page.getByTestId('composer-file').setInputFiles(join(MEDIA_FIXTURES_DIR, 'invoice.pdf'));
  await send(page, 'Plan a trip');
  await expect(messages(page)).toHaveCount(2);
  await expect(page.getByTestId('code-copy')).toBeVisible();
  mock.sse(CHAT, reply('Another plan.'));
  await messages(page).nth(1).getByTestId('message-regenerate').click();
  await expect(messages(page).nth(1).getByTestId('sibling-position')).toContainText('2/2');

  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await expectNoSeriousA11yViolations(page);
});
