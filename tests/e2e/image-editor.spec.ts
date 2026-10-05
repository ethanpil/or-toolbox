/**
 * Stage 5 gate, Image editor: the mask edit round trip. A test picture is loaded, a mask is painted with real
 * pointer events, Inpaint runs with "Keep outside the mask" against a mocked `/images` answer (the recorded
 * edit of the same picture, its circle recoloured), and:
 *
 * - the request carried the marked-up picture, the plain picture and the mask PNG, with the instruction;
 * - every pixel outside the mask equals the original exactly, and pixels inside it come from the result;
 * - the new version is in the history strip; undo/redo of strokes works; the version downloads.
 *
 * Also: outpaint to 16:9 (the original kept exactly in the middle), keyboard operation of the brush tools,
 * the free-only notice and axe in both themes.
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp, tabTo } from './app.ts';
import {
  EDITED_JPG,
  GENERATED_JPG,
  GENERATED_PATH,
  type ImagesBody,
  imagesJson,
  KLEIN,
  mockImageCatalog,
} from './image-mocks.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

/** The editor's default soft edge (px) plus one: deeper than this inside the mask, the result is taken as is. */
const INNER = 7;

async function openWithPicture(page: Page): Promise<void> {
  await page.goto('tools/image-editor/');
  await page.getByTestId('editor-drop').locator('input[type="file"]').setInputFiles(GENERATED_PATH);
  await expect(page.getByTestId('editor-source-name')).toHaveText(
    'generated-image.jpg · 1024 × 1024',
  );
  await expect(page.getByTestId('editor-coverage')).toHaveText('No mask painted yet.');
}

/** Drags across the middle of the canvas with the mouse. */
async function paint(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.getByTestId('editor-canvas').boundingBox())!;
  const at = (fraction: [number, number]): [number, number] => [
    box.x + box.width * fraction[0],
    box.y + box.height * fraction[1],
  ];
  const [x0, y0] = at(from);
  const [x1, y1] = at(to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
}

async function downloadVersion(
  page: Page,
  extension: string,
): Promise<{ name: string; bytes: Buffer }> {
  const card = page.getByTestId('editor-version-result');
  await card.getByTestId('editor-version-download').click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    card.getByTestId(`export-${extension}`).click(),
  ]);
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

const base64 = (bytes: Buffer): string => bytes.toString('base64');

const GREEN: [number, number, number] = [20, 200, 60];

/** A PNG of one colour, made in the page (a model answer or a test picture of any size). */
async function solidPng(
  page: Page,
  width: number,
  height: number,
  rgb: [number, number, number],
): Promise<Buffer> {
  const encoded = await page.evaluate(
    async ({ width, height, rgb }) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d')!;
      context.fillStyle = `rgb(${rgb.join(',')})`;
      context.fillRect(0, 0, width, height);
      const bytes = new Uint8Array(
        await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer(),
      );
      let text = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(text);
    },
    { width, height, rgb },
  );
  return Buffer.from(encoded, 'base64');
}

test.describe('Image editor', () => {
  test.setTimeout(240_000);

  test('gate: mask edit round trip with "Keep outside the mask"', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    mock.respond('POST', '/api/v1/images', () => imagesJson(EDITED_JPG, 1, 0.015));
    const problems = await watchForProblems(page);
    await openWithPicture(page);

    // Paint a mask with real pointer events, then undo and redo the stroke.
    await paint(page, [0.35, 0.45], [0.65, 0.55]);
    const coverage = page.getByTestId('editor-coverage');
    await expect(coverage).toHaveText(/^Mask covers \d+\.\d% of the picture\.$/);
    const painted = await coverage.textContent();
    await page.keyboard.press('Control+z');
    await expect(coverage).toHaveText('No mask painted yet.');
    await page.keyboard.press('Control+Shift+z');
    await expect(coverage).toHaveText(painted!);

    await page.getByTestId('tool-prompt').fill('Make the circle blue');
    await expect(page.getByTestId('editor-keep-outside')).toBeChecked();
    await page.getByTestId('run-button').click();

    // The new version is in the history strip and is the one being edited.
    const thumbs = page.getByTestId('editor-version-thumb');
    await expect(thumbs).toHaveCount(2, { timeout: 60_000 });
    await expect(thumbs.nth(1)).toHaveAttribute('aria-current', 'true');
    const card = page.getByTestId('editor-version-result');
    await expect(card.locator('h4')).toHaveText('Version 1');
    await expect(page.getByTestId('editor-version-result-meta')).toContainText(
      'Inpaint · 1024 × 1024 · outside kept',
    );
    await expect(page.getByTestId('tool-status')).toHaveText(
      'Version 1 ready: inpaint, 1024 × 1024',
    );

    // The request: marked-up picture, plain picture, mask PNG, and the instruction naming the marked area.
    const [call] = mock.calls('/api/v1/images', 'POST');
    const body = call!.body as ImagesBody;
    expect(body.model).toBe(KLEIN);
    expect(body.aspect_ratio).toBe('1:1');
    expect(body.output_format).toBe('png');
    expect(body.prompt).toContain('Change only the marked area: Make the circle blue.');
    expect(body.prompt).toContain('tinted magenta');
    expect(body.prompt).toContain('black-and-white mask where white is the area to change');
    const [marked, plain, maskRef] = (body.input_references ?? []).map((ref) => ref.image_url.url);
    expect(body.input_references).toHaveLength(3);
    expect(marked).toMatch(/^data:image\/png;base64,/);
    // The plain picture is the decoded, upright pixels at the same size as the others (checked below).
    expect(plain).toMatch(/^data:image\/png;base64,/);
    expect(maskRef).toMatch(/^data:image\/png;base64,/);

    // The mask is cleared after the edit, as one undoable step.
    await expect(coverage).toHaveText('No mask painted yet.');
    await page.getByTestId('editor-canvas').focus();
    await page.keyboard.press('Control+z');
    await expect(coverage).toHaveText(painted!);

    // Downloading the version works.
    const saved = await downloadVersion(page, 'png');
    expect(saved.name).toBe('generated-image-v1.png');
    expect(saved.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');

    // Pixels: outside the mask exactly the original, inside (deeper than the soft edge) the result.
    const check = await page.evaluate(
      async ({ original, result, version, mask, markedUrl, plainUrl, inner }) => {
        const decode = async (url: string): Promise<ImageData> => {
          const blob = await (await fetch(url)).blob();
          const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d', { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const [o, r, v, m, k, p] = await Promise.all([
          decode(`data:image/jpeg;base64,${original}`),
          decode(`data:image/jpeg;base64,${result}`),
          decode(`data:image/png;base64,${version}`),
          decode(mask),
          decode(markedUrl),
          decode(plainUrl),
        ]);
        let plainDiff = 0;
        for (let i = 0; i < o.data.length; i++) if (p.data[i] !== o.data[i]) plainDiff++;
        const { width, height } = o;
        const marked = (x: number, y: number): boolean => (m.data[(y * width + x) * 4] ?? 0) > 127;
        let outside = 0;
        let outsideDiff = 0;
        let markedOutsideDiff = 0;
        let deep = 0;
        let deepDiff = 0;
        let tinted = 0;
        let white = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (!marked(x, y)) {
              outside++;
              for (let c = 0; c < 4; c++) {
                if (v.data[i + c] !== o.data[i + c]) outsideDiff++;
                if (k.data[i + c] !== o.data[i + c]) markedOutsideDiff++;
              }
              continue;
            }
            white++;
            // The marked reference: half magenta over the picture.
            const expected = [
              (o.data[i]! + 255) / 2,
              o.data[i + 1]! / 2,
              (o.data[i + 2]! + 255) / 2,
            ];
            if (expected.every((value, c) => Math.abs(value - k.data[i + c]!) <= 1)) tinted++;
            let isDeep = x >= inner && y >= inner && x < width - inner && y < height - inner;
            for (let dy = -inner; isDeep && dy <= inner; dy++) {
              for (let dx = -inner; dx <= inner; dx++) {
                if (!marked(x + dx, y + dy)) {
                  isDeep = false;
                  break;
                }
              }
            }
            if (!isDeep) continue;
            deep++;
            for (let c = 0; c < 3; c++)
              deepDiff = Math.max(deepDiff, Math.abs(v.data[i + c]! - r.data[i + c]!));
          }
        }
        return {
          size: [v.width, v.height, m.width, m.height, k.width, k.height, p.width, p.height],
          plainDiff,
          outside,
          outsideDiff,
          markedOutsideDiff,
          white,
          tinted,
          deep,
          deepDiff,
        };
      },
      {
        original: base64(GENERATED_JPG),
        result: base64(EDITED_JPG),
        version: base64(saved.bytes),
        mask: maskRef!,
        markedUrl: marked!,
        plainUrl: plain!,
        inner: INNER,
      },
    );
    console.info(
      `Mask edit gate: ${check.white} masked px (${check.deep} deeper than the soft edge, max channel diff ${check.deepDiff} from the result); ${check.outside} px outside, ${check.outsideDiff} differing channels`,
    );
    expect(check.size).toEqual([1024, 1024, 1024, 1024, 1024, 1024, 1024, 1024]);
    expect(check.plainDiff).toBe(0);
    expect(check.white).toBeGreaterThan(1000);
    expect(check.outside).toBe(1024 * 1024 - check.white);
    expect(check.outsideDiff).toBe(0);
    expect(check.markedOutsideDiff).toBe(0);
    expect(check.tinted).toBe(check.white);
    expect(check.deep).toBeGreaterThan(500);
    expect(check.deepDiff).toBeLessThanOrEqual(2);

    // Continue from the original: it becomes the version being edited; Show before compares with the parent.
    await thumbs.nth(0).click();
    await expect(thumbs.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('editor-compare')).toBeDisabled();
    await thumbs.nth(1).click();
    await page.getByTestId('editor-compare').click();
    await expect(page.getByTestId('editor-compare')).toHaveAttribute('aria-pressed', 'true');
    // A before/after wipe of the version and the one it was made from.
    await expect(page.getByTestId('editor-compare-slider')).toBeVisible();
    await expect(page.getByTestId('compare-range')).toHaveAttribute(
      'aria-label',
      'Compare version 1 with original',
    );
    await page.getByTestId('editor-compare').click();
    await expect(page.getByTestId('editor-compare-slider')).toHaveCount(0);

    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });

  test('outpaint to 16:9 with a soft edge: no grey in the new area, the picture exact beyond the edge', async ({
    page,
    context,
    mock,
  }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    let answer: Buffer = EDITED_JPG;
    mock.respond('POST', '/api/v1/images', () => imagesJson(answer, 1, 0.02, 'image/png'));
    const problems = await watchForProblems(page);
    await openWithPicture(page);
    // The model's answer: a 16:9 picture, all one green, so any grey filler or stretching would show.
    answer = await solidPng(page, 1792, 1008, GREEN);
    await page.getByTestId('editor-mode-outpaint').check();
    await expect(page.getByTestId('editor-reason')).toHaveText(
      'Outpaint marks the new area for you.',
    );
    await expect(page.getByTestId('editor-tool-brush')).toBeDisabled();
    await page.getByTestId('editor-extend').selectOption('16:9');
    await expect(page.getByTestId('editor-outpaint-size')).toHaveText('1024 × 1024 → 1820 × 1024');
    await expect(page.getByTestId('editor-keep-outside')).toBeChecked();
    await page.getByTestId('run-button').click();

    await expect(page.getByTestId('editor-version-result-meta')).toContainText(
      'Outpaint · 1820 × 1024 · outside kept',
      { timeout: 60_000 },
    );
    await expect(page.getByTestId('editor-version-fitted')).toHaveCount(0);
    const body = mock.calls('/api/v1/images', 'POST')[0]!.body as ImagesBody;
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.prompt).toContain('the empty area to fill tinted magenta');
    expect(body.prompt).toContain('Keep the original part of the picture exactly as it is');
    expect(body.input_references).toHaveLength(3);

    const saved = await downloadVersion(page, 'png');
    expect(saved.name).toBe('generated-image-v1.png');
    const check = await page.evaluate(
      async ({ original, version, green, inner }) => {
        const pixels = async (url: string): Promise<ImageData> => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob(), {
            imageOrientation: 'from-image',
          });
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d', { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          return context.getImageData(0, 0, bitmap.width, bitmap.height);
        };
        const v = await pixels(`data:image/png;base64,${version}`);
        const o = await pixels(`data:image/jpeg;base64,${original}`);
        // The picture beyond the soft edge: exactly the original.
        let originalDiff = 0;
        for (let y = 0; y < 1024; y++) {
          for (let x = inner; x < 1024 - inner; x++) {
            const i = (y * v.width + x + 398) * 4;
            const j = (y * 1024 + x) * 4;
            for (let c = 0; c < 4; c++) if (v.data[i + c] !== o.data[j + c]) originalDiff++;
          }
        }
        // The new area, right up to the seam: all result (green), never the grey filler.
        let newDiff = 0;
        for (let y = 0; y < v.height; y++) {
          for (let x = 0; x < v.width; x++) {
            if (x >= 398 && x < 1422) continue;
            const i = (y * v.width + x) * 4;
            for (let c = 0; c < 3; c++)
              newDiff = Math.max(newDiff, Math.abs(v.data[i + c]! - green[c]!));
          }
        }
        return { size: [v.width, v.height], originalDiff, newDiff };
      },
      { original: base64(GENERATED_JPG), version: base64(saved.bytes), green: GREEN, inner: INNER },
    );
    expect(check.size).toEqual([1820, 1024]);
    expect(check.originalDiff).toBe(0);
    expect(check.newDiff).toBeLessThanOrEqual(3);

    // Removing the only edit goes back to the original, focus on the canvas.
    await page.getByTestId('editor-version-remove').click();
    await expect(page.getByTestId('editor-versions')).toBeHidden();
    await expect(page.getByTestId('editor-canvas')).toBeFocused();
    await expect(page.getByTestId('editor-outpaint-size')).toHaveText('1024 × 1024 → 1820 × 1024');
    expect(problems).toEqual([]);
  });

  test('a picture too big for browsers is scaled down; references share one size; another shape is fitted', async ({
    page,
    context,
    mock,
  }) => {
    test.setTimeout(300_000);
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    let answer: Buffer = EDITED_JPG;
    mock.respond('POST', '/api/v1/images', () => imagesJson(answer, 1, 0.02, 'image/png'));
    const problems = await watchForProblems(page);
    await page.goto('tools/image-editor/');
    // 5000 x 4000 is 20 megapixels, more than Safari's 16.7 MP canvas limit.
    const big = await solidPng(page, 5000, 4000, [200, 180, 40]);
    answer = await solidPng(page, 1536, 1024, GREEN);
    await page
      .getByTestId('editor-drop')
      .locator('input[type="file"]')
      .setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: big });
    await expect(page.getByTestId('editor-source-name')).toHaveText('big.png · 4579 × 3663', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('tool-status')).toContainText(
      'Scaled down from 5000 × 4000 to 4579 × 3663',
    );

    await paint(page, [0.3, 0.5], [0.7, 0.5]);
    await page.getByTestId('tool-prompt').fill('A green stripe');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('editor-version-result-meta')).toContainText(
      'Inpaint · 4579 × 3663 · outside kept',
      { timeout: 120_000 },
    );
    // 3:2 into a 5:4 picture: fitted inside and centered, not stretched, and the version says so.
    await expect(page.getByTestId('editor-version-fitted')).toContainText(
      'fitted inside and centered',
    );

    // Every reference was built at the same size: the picture fitted in 2048 px.
    const urls = (
      mock.calls('/api/v1/images', 'POST')[0]!.body as ImagesBody
    ).input_references!.map((ref) => ref.image_url.url);
    const sizes = await page.evaluate(
      (list) =>
        Promise.all(
          list.map(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob());
            return `${bitmap.width}x${bitmap.height}`;
          }),
        ),
      urls,
    );
    expect(sizes).toEqual(['2048x1638', '2048x1638', '2048x1638']);
    expect(problems).toEqual([]);
  });
  test('the brush tools work from the keyboard', async ({ page, context, mock }) => {
    await seedApp(context, { key: true });
    mockImageCatalog(mock);
    const problems = await watchForProblems(page);
    await openWithPicture(page);

    await page.getByTestId('editor-tool-brush').focus();
    await page.keyboard.press('e');
    await expect(page.getByTestId('editor-tool-eraser')).toBeChecked();
    await page.keyboard.press('b');
    await expect(page.getByTestId('editor-tool-brush')).toBeChecked();
    await expect(page.getByTestId('editor-size')).toHaveValue('51');
    await page.keyboard.press(']');
    await expect(page.getByTestId('editor-size')).toHaveValue('64');
    await page.keyboard.press('[');
    await expect(page.getByTestId('editor-size')).toHaveValue('51');

    // On the canvas: arrows move the brush, Enter paints a dot, Shift+arrows paint along.
    await tabTo(page, 'editor-canvas');
    const coverage = page.getByTestId('editor-coverage');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(coverage).toHaveText(/^Mask covers /);
    const dot = await coverage.textContent();
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
    await expect(coverage).not.toHaveText(dot!);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await expect(coverage).toHaveText(dot!);
    await page.keyboard.press('Control+y');
    await expect(coverage).not.toHaveText(dot!);

    // M hides the mask; the hand tool pans with the arrows; + zooms and 0 fits again.
    await page.keyboard.press('m');
    await expect(page.getByTestId('editor-overlay')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('m');
    const zoom = page.getByTestId('editor-zoom');
    const fitted = await zoom.textContent();
    await page.keyboard.press('h');
    await expect(page.getByTestId('editor-tool-pan')).toBeChecked();
    const painted = await coverage.textContent();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter');
    await expect(coverage).toHaveText(painted!);
    await page.keyboard.press('+');
    await expect(zoom).not.toHaveText(fitted!);
    await page.keyboard.press('0');
    await expect(zoom).toHaveText(fitted!);
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
    await page.goto('tools/image-editor/');
    await expect(page.getByTestId('free-only-notice')).toContainText(
      'This tool cannot run in free-only mode',
    );
    await expect(page.getByTestId('run-button')).toHaveAttribute('aria-disabled', 'true');
    await expectNoSeriousA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoSeriousA11yViolations(page);
    expect(problems).toEqual([]);
  });
});
