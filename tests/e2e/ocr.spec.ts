/**
 * Stage 3 gate, OCR: a 20-page PDF (tests/fixtures/media/text-20-pages.pdf, made by
 * scripts/generate-text-pdf.mjs) read page by page against mocked streaming answers: 20 page results, the
 * combined text in page order, Markdown/text/Word exports, and a page that failed retried on its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { expect, MEDIA_FIXTURES_DIR, type RecordedCall, sseResponse, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const PDF = join(MEDIA_FIXTURES_DIR, 'text-20-pages.pdf');

interface Body {
  model: string;
  messages: {
    role: string;
    content: string | { type: string; text?: string; image_url?: { url: string } }[];
  }[];
}

/** The page a request is for, from its "Page N of 20" text part. */
function pageOf(call: RecordedCall): number {
  const parts = (call.body as Body).messages[1]?.content;
  const text = Array.isArray(parts) ? (parts[0]?.text ?? '') : '';
  return Number(/^Page (\d+) of/.exec(text)?.[1] ?? 0);
}

/** A streamed answer: the page's text in two chunks, the finish chunk, then usage (as OpenRouter sends it). */
function pageStream(n: number) {
  const base = {
    id: `gen-${n}`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test/vision',
  };
  const choice = (content: string, finish: string | null) => [
    { index: 0, delta: { role: 'assistant', content }, finish_reason: finish },
  ];
  return sseResponse([
    { ...base, choices: choice(`## Page ${n}\n\n`, null) },
    { ...base, choices: choice(`Text of page ${n}.`, null) },
    { ...base, choices: choice('', 'stop') },
    {
      ...base,
      choices: choice('', 'stop'),
      usage: { prompt_tokens: 1500, completion_tokens: 12, total_tokens: 1512, cost: 0.0004 },
    },
  ]);
}

async function addPdf(page: Page): Promise<void> {
  await page.getByTestId('doc-drop-zone').locator('input[type=file]').setInputFiles(PDF);
  await expect(page.getByTestId('doc-count')).toHaveText('1 file · 20 pages');
}

async function download(page: Page, testId: string): Promise<Buffer> {
  await page.getByTestId('output-download').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  return readFileSync(await file.path());
}

/** True when `parts` appear in `text` in this order. */
function inOrder(text: string, parts: string[]): boolean {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

const ALL_PAGES = Array.from({ length: 20 }, (_, i) => `Text of page ${i + 1}.`);

test('a 20-page PDF: 20 page results in order, exports, a failed page retried', async ({
  page,
  context,
  mock,
}) => {
  test.slow();
  await seedApp(context, { key: true });
  let failSeven = true;
  mock.respond('POST', '/api/v1/chat/completions', (call) => {
    const n = pageOf(call);
    if (n === 7 && failSeven) {
      failSeven = false;
      return { status: 400, body: { error: { code: 400, message: 'Mocked error 400' } } };
    }
    return pageStream(n);
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/ocr/');
  await addPdf(page);
  await page.getByTestId('run-button').click();

  await expect(page.getByTestId('output-status')).toHaveText('Done · 19 of 20 pages; 1 not read');
  expect(mock.calls('/api/v1/chat/completions')).toHaveLength(20);
  // Every page was sent as an image, with the PDF's own text as a hint.
  const third = mock.calls('/api/v1/chat/completions').find((call) => pageOf(call) === 3)!;
  const parts = (third.body as Body).messages[1]!.content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  expect(parts[0]?.text).toContain('This is page 3 of the ORtoolbox OCR test document.');
  expect(parts[1]?.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);

  const combined = page.getByTestId('output-content');
  await expect(combined).toContainText('Text of page 20.');
  const text = await combined.innerText();
  expect(
    inOrder(
      text,
      ALL_PAGES.filter((line) => line !== 'Text of page 7.'),
    ),
  ).toBe(true);
  expect(text).toContain('page 7 of 20 could not be read');

  await page.getByTestId('ocr-view-pages').click();
  const pages = page.getByTestId('ocr-page');
  await expect(pages).toHaveCount(20);
  await expect(page.locator('[data-testid="ocr-page"][data-status="done"]')).toHaveCount(19);
  const seven = page.locator('[data-testid="ocr-page"][data-page="7"]');
  await expect(seven).toHaveAttribute('data-status', 'failed');
  await expectNoSeriousA11yViolations(page);

  // Retry just that page.
  await seven.getByTestId('ocr-page-retry').click();
  await expect(seven).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('output-status')).toHaveText('Done · 20 pages');
  expect(mock.calls('/api/v1/chat/completions')).toHaveLength(21);
  await page.getByTestId('ocr-view-combined').click();
  expect(inOrder(await combined.innerText(), ALL_PAGES)).toBe(true);

  // Exports: Markdown and text keep the order and the separators; Word is a real document.
  const markdown = (await download(page, 'export-md')).toString('utf8');
  expect(inOrder(markdown, ALL_PAGES)).toBe(true);
  expect(markdown).toContain('*text-20-pages.pdf · page 7 of 20*\n\n## Page 7\n\nText of page 7.');
  const plain = (await download(page, 'export-txt')).toString('utf8');
  expect(plain).toContain('--- text-20-pages.pdf · page 20 of 20 ---');
  expect(inOrder(plain, ALL_PAGES)).toBe(true);
  const docx = unzipSync(new Uint8Array(await download(page, 'export-docx')));
  const documentXml = strFromU8(docx['word/document.xml']!);
  expect(inOrder(documentXml, ALL_PAGES)).toBe(true);

  // History holds the combined text of the retry run.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  // The mocked 400 shows up as a failed response (and Chromium logs it); nothing else may go wrong.
  expect(problems.filter((problem) => !problem.includes('400'))).toEqual([]);
});

test('Stop ends the remaining pages and keeps what was read', async ({ page, context, mock }) => {
  await seedApp(context, { key: true });
  mock.respond('POST', '/api/v1/chat/completions', (call) => ({
    ...pageStream(pageOf(call)),
    delayMs: pageOf(call) <= 1 ? 0 : 4000,
  }));
  const problems = await watchForProblems(page);
  await page.goto('tools/ocr/');
  await addPdf(page);
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('output-content')).toContainText('Text of page 1.');
  await page.getByTestId('stop-button').click();
  await expect(page.getByTestId('output-status')).toHaveText(
    'Stopped. The partial result is kept.',
  );
  // Three pages at a time: page 1 answered, pages 2 and 3 were in flight, nothing after them started.
  expect(mock.calls('/api/v1/chat/completions').length).toBeLessThanOrEqual(4);
  await page.getByTestId('ocr-view-pages').click();
  await expect(page.locator('[data-testid="ocr-page"][data-status="done"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ocr-page"][data-status="stopped"]')).toHaveCount(19);
  expect(problems.filter((problem) => !/aborted|ERR_ABORTED|net::/i.test(problem))).toEqual([]);
});

test('free-only mode blocks the paid PDF parser and says why', async ({ page, context }) => {
  await seedApp(context, {
    key: true,
    settings: {
      freeOnly: true,
      tools: { ocr: { options: { pdfParser: true, engine: 'mistral-ocr' } } },
    },
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/ocr/');
  // Free-only swaps in the free vision model, and says so.
  await expect(page.getByTestId('model-note')).toContainText('Free-only mode: using');
  await addPdf(page);
  await expect(page.getByTestId('ocr-engine-notice')).toBeVisible();
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('run-hint')).toHaveText(
    'Mistral OCR is not free; free-only mode is on.',
  );
  await expectNoSeriousA11yViolations(page);

  // The free parser is fine.
  await page.getByTestId('drawer-button').click();
  await page.getByTestId('ocr-engine').selectOption('cloudflare-ai');
  await expect(page.getByTestId('ocr-engine-notice')).toBeHidden();
  await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'false');
  expect(problems).toEqual([]);
});
