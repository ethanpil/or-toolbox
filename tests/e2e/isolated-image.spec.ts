/**
 * Stage 5 gate, Isolated image: 20 synthetic product photos (tests/e2e/isolated-image-photos.ts) go to a
 * mocked edit model that answers imperfect isolations (off-white 240-252 with noise, a soft shadow, off-centre,
 * varied sizes). Every result must pass the QA, and the ZIP of 20 JPGs is checked pixel by pixel in the page:
 * every border pixel exactly #FFFFFF, the product centred with the margin, no background left around it, and the
 * white parts inside the products not flood-filled. Also: a failed request retried on its own, the review
 * (before/after slider by keyboard, side by side, a margin change made again without a request), free-only mode,
 * axe in both themes, and the pipeline running in the image worker.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { expect, type OpenRouterMock, type RecordedCall, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { INTERIOR_WHITE, type TestPhoto, testPhotos } from './isolated-image-photos.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
/** $0.014 per megapixel, per image token: a 1024 px photo is estimated at 4175 tokens, about $0.0143, and the photo sent as a reference counts as much again (klein lists no input price). */
const KLEIN_IMAGE_TOKEN = '0.000003418';

interface ImageBody {
  model: string;
  prompt: string;
  n?: number;
  output_format?: string;
  input_references?: { type: string; image_url: { url: string } }[];
}

/** Another editor, for "Retry with another model": takes neither `n` nor `output_format`. */
const GEMINI = 'google/gemini-3.1-flash-image';

const catalogEntry = (id: string, name: string, imageToken: string) => ({
  id,
  name,
  created: 1750000000,
  description: 'Image generation and editing.',
  context_length: null,
  architecture: {
    modality: 'text+image->image',
    input_modalities: ['text', 'image'],
    output_modalities: ['image'],
    tokenizer: 'Other',
  },
  pricing: { prompt: '0', completion: '0', image_output: imageToken },
});

function mockModels(mock: OpenRouterMock): void {
  mock.json('GET', '/api/v1/models', {
    data: [
      catalogEntry(KLEIN, 'Black Forest Labs: FLUX.2 Klein 4B', KLEIN_IMAGE_TOKEN),
      catalogEntry(GEMINI, 'Google: Gemini 3.1 Flash Image', '0.000005'),
    ],
  });
  mock.json('GET', '/api/v1/images/models', {
    data: [
      {
        id: KLEIN,
        name: 'Black Forest Labs: FLUX.2 Klein 4B',
        supported_parameters: {
          aspect_ratio: { type: 'enum', values: ['1:1', '4:3', '3:4', 'auto'] },
          output_format: { type: 'enum', values: ['png', 'jpeg'] },
          n: { type: 'range', min: 1, max: 1 },
          input_references: { type: 'range', min: 0, max: 4 },
        },
      },
      {
        id: GEMINI,
        name: 'Google: Gemini 3.1 Flash Image',
        supported_parameters: { input_references: { type: 'range', min: 0, max: 14 } },
      },
    ],
  });
}

/** The photo a request is for: its data-URL reference is the uploaded file as it is (small photos pass through). */
function photoFor(call: RecordedCall, photos: readonly TestPhoto[]): TestPhoto | undefined {
  const url = (call.body as ImageBody).input_references?.[0]?.image_url.url ?? '';
  const base64 = url.slice(url.indexOf(',') + 1);
  return photos.find((photo) => photo.photo.toString('base64') === base64);
}

/** Answers each edit with that photo's isolation; `fail(name, attempt)` makes an attempt a 502. */
function mockEdits(
  mock: OpenRouterMock,
  photos: readonly TestPhoto[],
  fail: (name: string, attempt: number) => boolean = () => false,
): void {
  const attempts = new Map<string, number>();
  mock.respond('POST', '/api/v1/images', (call) => {
    const photo = photoFor(call, photos);
    if (!photo) return { status: 400, body: { error: { code: 400, message: 'Unknown photo' } } };
    const attempt = (attempts.get(photo.name) ?? 0) + 1;
    attempts.set(photo.name, attempt);
    if (fail(photo.name, attempt)) {
      return { status: 502, body: { error: { code: 502, message: 'Mocked error 502' } } };
    }
    return {
      headers: { 'x-generation-id': `gen-img-${attempt}-${photo.name}` },
      body: {
        created: 0,
        data: [{ b64_json: photo.isolation.toString('base64'), media_type: 'image/png' }],
        usage: { prompt_tokens: 4096, completion_tokens: 4096, total_tokens: 8192, cost: 0.015 },
      },
    };
  });
}

async function addPhotos(page: Page, photos: readonly TestPhoto[]): Promise<void> {
  await page
    .getByTestId('iso-drop-zone')
    .locator('input[type=file]')
    .setInputFiles(
      photos.map((photo) => ({ name: photo.name, mimeType: 'image/png', buffer: photo.photo })),
    );
  await expect(page.getByTestId('iso-photo')).toHaveCount(photos.length);
}

interface PixelStats {
  width: number;
  height: number;
  /** Border pixels that are not exactly #FFFFFF. */
  borderNotWhite: number;
  /** Margins around the content: the groups of non-white pixels (darkest channel below 248) of 2,000 or more. */
  margins: { left: number; top: number; right: number; bottom: number };
  /** Pixels in smaller groups: grey dots floating on the white (specks of noise or of a shadow's fringe). */
  floating: number;
  /** Light grey pixels the border cannot reach: the white parts inside the products. */
  enclosedWhite: number;
}

/** Decodes a JPG in the page and measures it (see `PixelStats`). */
function measure(page: Page, jpeg: Uint8Array): Promise<PixelStats> {
  return page.evaluate(
    async ({ base64, interior }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const darkest = (p: number): number =>
        Math.min(data[p * 4] ?? 0, data[p * 4 + 1] ?? 0, data[p * 4 + 2] ?? 0);
      const white = (p: number): boolean =>
        data[p * 4] === 255 && data[p * 4 + 1] === 255 && data[p * 4 + 2] === 255;

      let borderNotWhite = 0;
      const border: number[] = [];
      for (let x = 0; x < width; x++) border.push(x, (height - 1) * width + x);
      for (let y = 1; y < height - 1; y++) border.push(y * width, y * width + width - 1);
      for (const p of border) if (!white(p)) borderNotWhite += 1;

      const pixels = width * height;
      /** Floods from `seeds` through pixels that `pass`, marking them in `seen`: how many, and their box. */
      const flood = (seeds: number[], seen: Uint8Array, pass: (p: number) => boolean) => {
        const stack: number[] = [];
        for (const p of seeds) {
          if (!seen[p] && pass(p)) {
            seen[p] = 1;
            stack.push(p);
          }
        }
        const box = { count: 0, left: width, top: height, right: -1, bottom: -1 };
        while (stack.length > 0) {
          const p = stack.pop()!;
          const x = p % width;
          const y = (p - x) / width;
          box.count += 1;
          box.left = Math.min(box.left, x);
          box.right = Math.max(box.right, x);
          box.top = Math.min(box.top, y);
          box.bottom = Math.max(box.bottom, y);
          for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
            if (q < 0 || q >= pixels || seen[q] || !pass(q)) continue;
            seen[q] = 1;
            stack.push(q);
          }
        }
        return box;
      };

      // Groups of content (darkest channel below 248): the product with its shadow, and anything floating.
      const grouped = new Uint8Array(pixels);
      const content = (p: number): boolean => darkest(p) < 248;
      let left = width;
      let top = height;
      let right = -1;
      let bottom = -1;
      let floating = 0;
      for (let p = 0; p < pixels; p++) {
        if (grouped[p] || !content(p)) continue;
        const group = flood([p], grouped, content);
        if (group.count < 2000) {
          floating += group.count;
          continue;
        }
        left = Math.min(left, group.left);
        right = Math.max(right, group.right);
        top = Math.min(top, group.top);
        bottom = Math.max(bottom, group.bottom);
      }

      // Everything light that is connected to the border is background; light grey it cannot reach is enclosed.
      const background = new Uint8Array(pixels);
      flood(border, background, (p) => darkest(p) >= 225);
      let enclosedWhite = 0;
      for (let p = 0; p < pixels; p++) {
        if (!background[p]) {
          const r = data[p * 4] ?? 0;
          const g = data[p * 4 + 1] ?? 0;
          const b = data[p * 4 + 2] ?? 0;
          if (
            Math.abs(r - interior) <= 6 &&
            Math.abs(g - interior) <= 6 &&
            Math.abs(b - interior) <= 6 &&
            Math.max(r, g, b) - Math.min(r, g, b) <= 4
          ) {
            enclosedWhite += 1;
          }
        }
      }
      bitmap.close();
      return {
        width,
        height,
        borderNotWhite,
        margins: { left, top, right: width - 1 - right, bottom: height - 1 - bottom },
        floating,
        enclosedWhite,
      };
    },
    { base64: Buffer.from(jpeg).toString('base64'), interior: INTERIOR_WHITE },
  );
}

test('gate: 20 product photos come back on pure white, pass the QA and export as a ZIP of 20 JPGs', async ({
  page,
  context,
  mock,
}) => {
  test.setTimeout(600_000);
  await seedApp(context, { key: true });
  const photos = testPhotos(20);
  mockModels(mock);
  mockEdits(mock, photos);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const problems = await watchForProblems(page);
  await page.goto('tools/isolated-image/');
  await addPhotos(page, photos);
  await expect(page.getByTestId('iso-count')).toHaveText('20 photos · ≈ $0.57');

  await page.getByTestId('run-button').click();
  // About $0.57 is above the default $0.10 per-run threshold: the run asks first.
  const dialog = page.getByTestId('budget-dialog');
  await expect(dialog.getByTestId('budget-estimate')).toContainText('$0.57');
  await dialog.getByTestId('budget-confirm').click();
  await expect(page.getByTestId('iso-summary')).toHaveText('20 of 20 results passed QA', {
    timeout: 540_000,
  });
  await expect(page.getByTestId('tool-status')).toHaveText('Done · 20 photos · 20 passed QA');
  await expect(page.locator('[data-testid="iso-card"][data-qa="pass"]')).toHaveCount(20);

  // One edit request per photo: the photo as a data URL, the fixed instruction, one PNG.
  const calls = mock.calls('/api/v1/images', 'POST');
  expect(calls).toHaveLength(20);
  expect(new Set(calls.map((call) => photoFor(call, photos)?.name)).size).toBe(20);
  for (const call of calls) {
    const body = call.body as ImageBody;
    expect(body.model).toBe(KLEIN);
    expect(body.n).toBe(1);
    expect(body.output_format).toBe('png');
    expect(body.prompt).toContain('Keep the product exactly as it is');
    expect(body.prompt).toContain('pure white background (#FFFFFF)');
    expect(body.input_references?.[0]?.image_url.url).toMatch(/^data:image\/png;base64,/);
  }

  // Unsaved results are protected: leaving asks first.
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page.getByTestId('leave-guard-list')).toHaveText('20 images not downloaded');
  await page.getByTestId('leave-guard-stay').click();
  await expect(page.getByTestId('leave-guard')).toHaveCount(0);

  // The ZIP: 20 JPGs named by the default pattern.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('iso-download-zip').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^isolated-images-\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const names = photos.map((photo) => photo.name.replace(/\.png$/, '-white.jpg'));
  expect(Object.keys(files).sort()).toEqual([...names].sort());

  for (const [index, photo] of photos.entries()) {
    const jpeg = files[names[index]!]!;
    expect([jpeg[0], jpeg[1], jpeg[2]]).toEqual([0xff, 0xd8, 0xff]);
    const stats = await measure(page, jpeg);
    const label = `${photo.name}: ${JSON.stringify(stats)}`;
    expect([stats.width, stats.height], label).toEqual([2000, 2000]);
    // QA in the file itself: every border pixel is exactly #FFFFFF.
    expect(stats.borderNotWhite, label).toBe(0);
    // Centred, the longer side filling the square minus the 8% margin (160 px).
    const { left, top, right, bottom } = stats.margins;
    const width = 2000 - left - right;
    const height = 2000 - top - bottom;
    const longSide = width >= height ? [left, right] : [top, bottom];
    for (const margin of longSide) {
      expect(margin, label).toBeGreaterThanOrEqual(150);
      expect(margin, label).toBeLessThanOrEqual(180);
    }
    // (A shadow's edge is ragged where it meets the threshold, so the measured box may differ a little.)
    expect(Math.abs(left - right), label).toBeLessThanOrEqual(20);
    expect(Math.abs(top - bottom), label).toBeLessThanOrEqual(20);
    // The box is the product's (and its shadow's), not the model's whole picture.
    expect(width / height / photo.contentAspect, label).toBeGreaterThan(0.85);
    expect(width / height / photo.contentAspect, label).toBeLessThan(1.18);
    // No grey dots float on the white: no noise or shadow fringe was left behind.
    expect(stats.floating, label).toBeLessThan(5_000);
    // The white parts inside a product keep their light grey: the fill never reached them.
    if (photo.hasWhitePart) expect(stats.enclosedWhite, label).toBeGreaterThan(60_000);
    else expect(stats.enclosedWhite, label).toBeLessThan(20_000);
  }

  // The pipeline ran in the image worker (a same-origin module worker), never on the page.
  const origin = new URL(page.url()).origin;
  expect(workers.some((url) => /image-worker/.test(url) && url.startsWith(origin))).toBe(true);
  // The ZIP counted as downloading every result: leaving no longer asks.
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  await expect(page).toHaveURL(/\/models\/$/);
  expect(problems).toEqual([]);
});

test('a failed photo is retried on its own; the review compares, and a margin change needs no request', async ({
  page,
  context,
  mock,
}) => {
  test.setTimeout(300_000);
  await seedApp(context, { key: true });
  const photos = testPhotos(3);
  mockModels(mock);
  mockEdits(mock, photos, (name, attempt) => name === photos[1]!.name && attempt === 1);
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const problems = await watchForProblems(page);
  await page.goto('tools/isolated-image/');
  await addPhotos(page, photos);
  await expect(page.getByTestId('iso-count')).toHaveText('3 photos · ≈ $0.086');
  await page.getByTestId('run-button').click();
  // The run's last status says what went wrong, and where.
  await expect(page.getByTestId('tool-status')).toHaveText(
    /^Done · 2 of 3 photos; 1 failed · 2 passed QA · 02-bottle\.png: .+/,
    { timeout: 240_000 },
  );
  const failed = page.locator('[data-testid="iso-card"][data-phase="failed"]');
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText(photos[1]!.name);
  await expect(failed.getByTestId('iso-error')).toBeVisible();
  await expect(page.getByTestId('iso-summary')).toHaveText(
    '2 of 2 results passed QA · 1 not isolated',
  );
  await expectNoSeriousA11yViolations(page);

  // Retry just that photo: one more request, for it alone.
  await failed.getByTestId('iso-retry').click();
  await expect(page.locator('[data-testid="iso-card"][data-qa="pass"]')).toHaveCount(3, {
    timeout: 120_000,
  });
  const calls = mock.calls('/api/v1/images', 'POST');
  expect(calls).toHaveLength(4);
  expect(photoFor(calls[3]!, photos)?.name).toBe(photos[1]!.name);
  await expect(page.getByTestId('iso-summary')).toHaveText('3 of 3 results passed QA');

  // The review of the first photo.
  const firstCard = page.getByTestId('iso-card').first();
  await firstCard.getByTestId('iso-review').click();
  const detail = page.getByTestId('iso-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { name: photos[0]!.name })).toBeFocused();
  await expect(detail.getByTestId('iso-qa')).toContainText('QA passed');

  // Before/after slider, by keyboard alone.
  const range = detail.getByTestId('compare-range');
  const frame = detail.locator('.or-compare');
  const divider = () => frame.evaluate((element) => element.style.getPropertyValue('--or-compare'));
  await range.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await expect(range).toHaveValue('45');
  await expect(range).toHaveAttribute(
    'aria-valuetext',
    'Original on the left 45%, Result on the right 55%',
  );
  expect(await divider()).toBe('45%');
  await page.keyboard.press('End');
  await expect(range).toHaveValue('100');
  expect(await divider()).toBe('100%');
  await page.keyboard.press('Home');
  await expect(range).toHaveValue('0');
  expect(await divider()).toBe('0%');

  // Side by side, and back.
  await detail.getByTestId('iso-view-side').click();
  await expect(detail.getByTestId('iso-side')).toBeVisible();
  await expect(detail.getByTestId('iso-compare')).toBeHidden();
  await expect(detail.getByTestId('iso-view-side')).toHaveAttribute('aria-pressed', 'true');
  await detail.getByTestId('iso-view-compare').click();
  await expect(detail.getByTestId('iso-compare')).toBeVisible();

  // A margin change makes the result again in the browser: no request.
  const before = await detail.getByTestId('compare-after').getAttribute('src');
  await expect(detail).toHaveAttribute('data-margin', '0.08');
  await detail.getByTestId('iso-margin').focus();
  // The range moves in the setting's 0.5% steps.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(detail.getByTestId('iso-margin-value')).toHaveText('9%');
  await expect(detail).toHaveAttribute('data-margin', '0.09', { timeout: 60_000 });
  await expect(detail.getByTestId('compare-after')).not.toHaveAttribute('src', before ?? '');
  await expect(detail.getByTestId('iso-updating')).toBeHidden();
  expect(mock.calls('/api/v1/images', 'POST')).toHaveLength(4);
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);

  await detail.getByTestId('iso-back').click();
  await expect(firstCard.getByTestId('iso-review')).toBeFocused();
  await expectNoSeriousA11yViolations(page);

  // Retry the third photo with another model, chosen in the model picker.
  const third = page.getByTestId('iso-card').nth(2);
  await third.getByTestId('iso-retry-model').click();
  await page.getByTestId(`model-option-${GEMINI}`).click();
  await expect.poll(() => mock.calls('/api/v1/images', 'POST').length).toBe(5);
  const retried = mock.calls('/api/v1/images', 'POST')[4]!;
  expect(photoFor(retried, photos)?.name).toBe(photos[2]!.name);
  expect(retried.body).toMatchObject({ model: GEMINI });
  expect(retried.body).not.toHaveProperty('n');
  expect(retried.body).not.toHaveProperty('output_format');
  await expect(page.getByTestId('tool-status')).toHaveText('Done · 1 photo · 1 passed QA', {
    timeout: 120_000,
  });
  await expect(page.locator('[data-testid="iso-card"][data-qa="pass"]')).toHaveCount(3);
  // The post-processing ran in the image worker (same origin, so `worker-src 'self'` allows it).
  const origin = new URL(page.url()).origin;
  expect(workers.some((url) => /image-worker/.test(url) && url.startsWith(origin))).toBe(true);
  // The mocked 502 shows up as a failed response (and Chromium logs it); nothing else may go wrong.
  expect(problems.filter((problem) => !problem.includes('502'))).toEqual([]);
});

test('a JPG keeps its border pure white even with a 0.5% margin: QA holds for the exported file', async ({
  page,
  context,
  mock,
}) => {
  test.setTimeout(300_000);
  // 2000 px, JPG 92, a coloured product (navy, a yellow band) and a margin of 0.5% (10 px).
  await seedApp(context, {
    key: true,
    settings: { tools: { 'isolated-image': { options: { margin: 0.005 } } } },
  });
  const photos = testPhotos(1);
  mockModels(mock);
  mockEdits(mock, photos);
  const problems = await watchForProblems(page);
  await page.goto('tools/isolated-image/');
  await addPhotos(page, photos);
  await page.getByTestId('run-button').click();
  const card = page.getByTestId('iso-card');
  await expect(card).toHaveAttribute('data-phase', 'done', { timeout: 240_000 });
  await expect(card).toHaveAttribute('data-qa', 'pass');
  // The result card offers the file as it is (its JPG border was checked); one format: one button.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.getByTestId('iso-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe('01-box-white.jpg');
  const stats = await measure(page, new Uint8Array(readFileSync(await download.path())));
  expect(stats.borderNotWhite, JSON.stringify(stats)).toBe(0);
  // JPG keeps at least 24 px of white whatever the margin, so compression cannot tint the border.
  // (Resampling and compression may tint a pixel or two of that band next to the product, never the border.)
  const { left, top, right, bottom } = stats.margins;
  expect(Math.min(left, top, right, bottom), JSON.stringify(stats)).toBeGreaterThanOrEqual(20);
  await card.getByTestId('iso-review').click();
  await expect(page.getByTestId('iso-margin-value')).toHaveText('0.5% (JPG uses 1.2%)');
  expect(problems).toEqual([]);
});

test('free-only mode: no image model is free, so the tool says so and cannot run (with the sample)', async ({
  page,
  context,
  mock,
}) => {
  await seedApp(context, { key: true, settings: { freeOnly: true } });
  mockModels(mock);
  const problems = await watchForProblems(page);
  // The sample: a product photo drawn on a canvas, shown as a small thumbnail. No text field: the tool is
  // promptless (its instruction is fixed).
  await page.goto('tools/isolated-image/?sample=1');
  await expect(page.getByTestId('iso-photo')).toHaveCount(1);
  await expect(page.getByTestId('iso-photo')).toContainText('sample-mug.png');
  const thumb = page.getByTestId('iso-photo').locator('img');
  await expect(thumb).toHaveJSProperty('complete', true);
  expect(await thumb.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(144);
  await expect(page.getByTestId('tool-prompt')).toHaveCount(0);
  const notice = page.getByTestId('free-only-notice');
  await expect(notice).toContainText('This tool cannot run in free-only mode');
  await expect(notice).toContainText('No free image model exists');
  const run = page.getByTestId('run-button');
  await expect(run).toHaveAttribute('aria-disabled', 'true');
  // Neither the button nor the shortcut starts anything.
  await run.click({ force: true });
  await page.keyboard.press('Control+Enter');
  expect(mock.calls('/api/v1/images', 'POST')).toHaveLength(0);
  await expect(page.getByTestId('iso-card')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});
