/**
 * Image generation against the mocked `/images` endpoint: two images with a reference (one request each, for a
 * model that makes one at a time), streamed partial previews (OpenAI SSE events, §3.4), variations with a new
 * seed, downloads in other formats, Edit → Send to Image editor, the free-only notice (no image model is free)
 * and axe in both themes.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import {
  EDITED_JPG,
  GENERATED_JPG,
  GENERATED_PATH,
  GPT_MINI,
  type ImagesBody,
  imagesJson,
  imagesStream,
  KLEIN,
  mockImageCatalog,
} from './image-mocks.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

/** The client cancels a stream once it has read `[DONE]`; Chromium may report that as an aborted request. */
const STREAM_CANCELS = { allowAborted: ['/api/v1/images'] };

test.describe('Image generation', () => {
  test.setTimeout(180_000);

  test('two images with a reference: two requests, consecutive seeds, downloads in other formats', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    mock.respond('POST', '/api/v1/images', () => imagesJson(GENERATED_JPG));
    const problems = await watchForProblems(page);
    await page.goto('tools/image-generation/');

    // FLUX.2 klein: per megapixel; one 1024 x 1024 image is the 4175-token floor, about $0.0143.
    await expect(page.getByTestId('cost-estimate-value')).toHaveText('≈ $0.014');
    await page.getByTestId('tool-prompt').fill('A lighthouse on a rocky coast at dusk');
    await page.getByTestId('imagegen-style').fill('watercolour');
    await page.locator('label[for]', { hasText: '16:9' }).click();
    await expect(page.getByTestId('imagegen-aspect-16-9')).toBeChecked();
    await page.getByTestId('imagegen-count').selectOption('2');
    await expect(page.getByText('2 requests: this model makes one image at a time.')).toBeVisible();
    await page
      .getByTestId('imagegen-reference-drop')
      .locator('input[type="file"]')
      .setInputFiles(GENERATED_PATH);
    await expect(page.getByTestId('imagegen-reference')).toHaveCount(1);
    await expect(page.getByTestId('imagegen-reference-count')).toHaveText('1 of 4');
    // Two requests, each an image (4175 tokens) plus its reference (priced high, 4096 tokens): about $0.057.
    await expect(page.getByTestId('cost-estimate-value')).toHaveText(/≈ \$0\.05[67]/);

    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('imagegen-result')).toHaveCount(2, { timeout: 60_000 });
    const calls = mock.calls('/api/v1/images', 'POST').map((call) => call.body as ImagesBody);
    expect(calls).toHaveLength(2);
    for (const body of calls) {
      expect(body).toMatchObject({
        model: KLEIN,
        prompt: 'A lighthouse on a rocky coast at dusk\n\nStyle: watercolour',
        aspect_ratio: '16:9',
      });
      expect(body.n).toBeUndefined();
      expect(body.stream).toBeUndefined();
      expect(body.input_references).toHaveLength(1);
      expect(body.input_references?.[0]?.image_url.url).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    }
    expect(calls[1]!.seed).toBe(calls[0]!.seed! + 1);
    await expect(page.getByTestId('imagegen-result-meta').first()).toContainText(
      `1024 × 1024 · seed ${calls[0]!.seed}`,
    );
    await expect(page.getByTestId('tool-status')).toHaveText('2 images ready');
    // The seed of the run is shown in the drawer's field.
    await expect(page.getByTestId('imagegen-seed')).toHaveValue(String(calls[0]!.seed));

    // Downloads: the JPEG as it is, PNG converted in the browser.
    const card = page.getByTestId('imagegen-result').nth(1);
    const save = async (extension: string): Promise<Buffer> => {
      await card.getByTestId('imagegen-download').click();
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        card.getByTestId(`export-${extension}`).click(),
      ]);
      expect(file.suggestedFilename()).toBe(`a-lighthouse-on-a-rocky-2.${extension}`);
      return readFileSync(await file.path());
    };
    expect((await save('jpg')).equals(GENERATED_JPG)).toBe(true);
    expect((await save('png')).subarray(1, 4).toString('latin1')).toBe('PNG');

    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('a streaming model shows the partial image, then the finished one', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    mock.respond('POST', '/api/v1/images', () => imagesStream(EDITED_JPG, GENERATED_JPG));
    const problems = await watchForProblems(page, STREAM_CANCELS);
    await page.goto(`tools/image-generation/?model=${encodeURIComponent(GPT_MINI)}`);
    await expect(page.getByTestId('imagegen-aspect-3-2')).toHaveCount(1);
    // Record every partial preview the page draws (the mock delivers the stream in one piece).
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { partials: string[] }).partials = seen;
      new MutationObserver(() => {
        for (const image of document.querySelectorAll<HTMLImageElement>(
          '[data-testid="imagegen-partial"]',
        )) {
          if (!seen.includes(image.src)) seen.push(image.src);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.getByTestId('tool-prompt').fill('A paper crane');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('imagegen-result')).toHaveCount(1, { timeout: 60_000 });
    const partials = await page.evaluate(
      () => (window as unknown as { partials: string[] }).partials,
    );
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatch(/^blob:/);
    await expect(page.getByTestId('imagegen-partial')).toHaveCount(0);
    const [call] = mock.calls('/api/v1/images', 'POST');
    expect(call?.body).toMatchObject({
      model: GPT_MINI,
      prompt: 'A paper crane',
      stream: true,
      aspect_ratio: '1:1',
    });
    // GPT Image takes no seed: none is sent or shown.
    expect((call?.body as ImagesBody).seed).toBeUndefined();
    await expect(page.getByTestId('imagegen-result-meta')).not.toContainText('seed');
    expect(problems).toEqual([]);
  });

  test('Stop keeps the image that was ready, and Retry makes only the rest', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    // The mock serves a stream in one piece, so a Stop cannot land inside it. The first request is held open from
    // inside the page instead: one image completes (and is billed), then nothing until the request is aborted.
    // Later requests (the Retry) go on to the mock.
    await page.addInitScript((completed: string) => {
      const original = window.fetch.bind(window);
      let held = false;
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (held || !url.endsWith('/api/v1/images') || init?.method !== 'POST') {
          return original(input, init);
        }
        held = true;
        const encoder = new TextEncoder();
        const event = {
          type: 'image_generation.completed',
          b64_json: completed,
          media_type: 'image/jpeg',
          created: 1790983685,
          usage: { prompt_tokens: 16, completion_tokens: 272, total_tokens: 288, cost: 0.003006 },
        };
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('The operation was aborted.', 'AbortError')),
            );
          },
          // The reader asks again once it has the event: that is when the image counts as received.
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } else {
              (window as unknown as { imageReceived: boolean }).imageReceived = true;
            }
          },
        });
        return Promise.resolve(
          new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      };
    }, GENERATED_JPG.toString('base64'));
    mock.respond('POST', '/api/v1/images', () => imagesJson(EDITED_JPG));
    const problems = await watchForProblems(page, STREAM_CANCELS);
    await page.goto(`tools/image-generation/?model=${encodeURIComponent(GPT_MINI)}`);
    await expect(page.getByTestId('imagegen-aspect-3-2')).toHaveCount(1);
    await page.getByTestId('tool-prompt').fill('Two paper cranes');
    await page.getByTestId('imagegen-count').selectOption('2');
    await page.getByTestId('run-button').click();

    // One of the two has arrived (a request shows its images when it ends); the other is still being made.
    await page.waitForFunction(
      () => (window as unknown as { imageReceived?: boolean }).imageReceived === true,
    );
    await expect(page.getByTestId('imagegen-waiting')).toHaveCount(1);
    await expect(page.getByTestId('stop-button')).toBeVisible();
    await page.getByTestId('stop-button').click();

    // The ready image stays (it was paid for), the other is a stopped card, and nothing is reported as an error.
    await expect(page.getByTestId('stop-button')).toBeHidden();
    await expect(page.getByTestId('imagegen-image')).toHaveCount(1);
    await expect(page.getByTestId('imagegen-failed')).toHaveCount(1);
    await expect(page.getByTestId('imagegen-error')).toHaveText('Stopped before it was ready.');
    await expect(page.getByTestId('error-toast')).toHaveCount(0);

    // Retry asks for the one that is missing, not for both again.
    await page.getByTestId('imagegen-retry').click();
    await expect(page.getByTestId('imagegen-image')).toHaveCount(2);
    await expect(page.getByTestId('imagegen-failed')).toHaveCount(0);
    const retries = mock.calls('/api/v1/images', 'POST').map((call) => call.body as ImagesBody);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.n).toBeUndefined();
    expect(problems).toEqual([]);
  });

  test('variations use a new seed; Edit sends the image to Image editor', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    mock.respond('POST', '/api/v1/images', () => imagesJson(GENERATED_JPG));
    const problems = await watchForProblems(page);
    await page.goto('tools/image-generation/');
    await page.getByTestId('tool-prompt').fill('A red fox in the snow');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('imagegen-result')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('imagegen-vary').click();
    await expect(page.getByTestId('imagegen-group')).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId('imagegen-result')).toHaveCount(2, { timeout: 60_000 });
    const [first, second] = mock
      .calls('/api/v1/images', 'POST')
      .map((call) => call.body as ImagesBody);
    expect(second).toMatchObject({
      model: KLEIN,
      prompt: 'A red fox in the snow',
      aspect_ratio: '1:1',
    });
    expect(typeof second!.seed).toBe('number');
    expect(second!.seed).not.toBe(first!.seed);
    await expect(page.getByTestId('imagegen-group').first()).toContainText(
      `Variation of a-red-fox-in-the-1.jpg · seed ${second!.seed}`,
    );

    // Use as reference, then Edit: the editor opens in a new tab with the picture loaded.
    await page.getByTestId('imagegen-use-reference').first().click();
    await expect(page.getByTestId('imagegen-reference')).toHaveCount(1);
    const [editor] = await Promise.all([
      context.waitForEvent('page'),
      page.getByTestId('imagegen-edit').first().click(),
    ]);
    // A new tab loads a page the dev server may not have compiled yet: allow for it.
    await expect(editor.getByTestId('page-title')).toHaveText('Image editor', { timeout: 90_000 });
    await expect(editor.getByTestId('editor-source-name')).toHaveText(
      'a-red-fox-in-the-1.jpg · 1024 × 1024',
      { timeout: 30_000 },
    );
    await expect(editor.getByTestId('editor-canvas')).toBeVisible();
    await expect(page.getByTestId('toast')).toContainText(
      'Sent a-red-fox-in-the-1.jpg to Image editor.',
    );
    expect(problems).toEqual([]);
  });

  test('free-only mode shows the notice: no image model is free', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true, settings: { freeOnly: true } });
    mockImageCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/image-generation/');
    const notice = page.getByTestId('free-only-notice');
    await expect(notice).toContainText('This tool cannot run in free-only mode');
    await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
    await expectNoSeriousA11yViolations(page);
    expect(mock.calls('/api/v1/images', 'POST')).toHaveLength(0);
    expect(problems).toEqual([]);
  });
});
