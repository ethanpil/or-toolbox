/**
 * Stage 6 gate (PLAN.md): a 5-step chained sequence survives a reload mid-run, each step after the first starting
 * from the previous clip's true last frame; the five clips join into one MP4 that decodes and plays; a spend cap
 * stops a sequence with nothing more sent. Runs against the dev server and the production build (`vite preview`,
 * where the page is not cross-origin isolated without the service worker, so ffmpeg runs single-threaded).
 *
 * Firefox, WebKit and VLC are not covered here: the joined file's playback there is a manual check.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { isDevServer, watchForProblems } from './support.ts';
import {
  mockVideoCatalog,
  mockVideoJobs,
  NO_BUDGETS,
  pngSize,
  VIDEO_BYTES,
  type VideoBody,
} from './video-mocks.ts';

/** The fixture clip: 25 frames at 24 fps. */
const CLIP_SECONDS = 25 / 24;

async function openSequence(page: Page): Promise<void> {
  const id = await page.getByTestId('video-tab-sequence').getAttribute('id');
  await page.locator(`label[for="${id}"]`).click();
  await expect(page.getByTestId('video-sequence-panel')).toBeVisible();
}

async function buildSequence(
  page: Page,
  prompts: readonly string[],
  options: { cap?: string } = {},
): Promise<void> {
  await openSequence(page);
  for (let i = 1; i < prompts.length; i++) await page.getByTestId('seq-add-step').click();
  for (const [index, prompt] of prompts.entries()) {
    await page.getByTestId('seq-step-prompt').nth(index).fill(prompt);
  }
  await page.getByTestId('video-duration').selectOption('1');
  if (options.cap) {
    await page.getByTestId('seq-cap').fill(options.cap);
    await page.getByTestId('seq-cap').blur();
  }
}

const slots = (page: Page) => page.getByTestId('seq-slot');
const firstFrameOf = (body: VideoBody): string | undefined =>
  body.frame_images?.find((frame) => frame.frame_type === 'first_frame')?.image_url.url;

/**
 * How far (mean channel difference, 0 to 255, at 64 x 64) a sent frame is from the fixture clip's first and last
 * frames, decoded by the browser itself.
 */
function frameDistances(page: Page, frame: string): Promise<{ toLast: number; toFirst: number }> {
  return page.evaluate(
    async ({ video, frame }) => {
      const bytes = Uint8Array.from(atob(video), (char) => char.charCodeAt(0));
      const element = document.createElement('video');
      element.muted = true;
      element.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      await new Promise((resolve) =>
        element.addEventListener('loadeddata', resolve, { once: true }),
      );
      const pixels = (source: CanvasImageSource): Uint8ClampedArray => {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d')!;
        context.drawImage(source, 0, 0, 64, 64);
        return context.getImageData(0, 0, 64, 64).data;
      };
      const at = async (time: number): Promise<Uint8ClampedArray> => {
        const seeked = new Promise((resolve) =>
          element.addEventListener('seeked', resolve, { once: true }),
        );
        element.currentTime = time;
        await seeked;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return pixels(element);
      };
      const first = await at(0);
      const last = await at(element.duration - 1 / 48);
      const image = new Image();
      image.src = frame;
      await image.decode();
      const sent = pixels(image);
      const distance = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
        let sum = 0;
        for (let i = 0; i < a.length; i += 4) {
          sum +=
            Math.abs(a[i]! - b[i]!) +
            Math.abs(a[i + 1]! - b[i + 1]!) +
            Math.abs(a[i + 2]! - b[i + 2]!);
        }
        return sum / ((a.length / 4) * 3);
      };
      return { toLast: distance(sent, last), toFirst: distance(sent, first) };
    },
    { video: VIDEO_BYTES.toString('base64'), frame },
  );
}

test.describe('Video studio gate', () => {
  test('a 5-step chained sequence survives a reload mid-run and joins into one MP4 that plays', async ({
    page,
    context,
    mock,
  }) => {
    test.setTimeout(900_000);
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    // Step 3 stays pending until the page has been reloaded.
    const jobs = mockVideoJobs(mock, { pendingPolls: 2, held: [3] });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');

    const prompts = [
      'A paper boat sets off on a rain-filled gutter',
      'The boat drifts past fallen leaves',
      'It slips under a small bridge of twigs',
      'The current carries it toward a drain',
      'It spins once and sails into the light',
    ];
    await buildSequence(page, prompts);
    // Five 1 s clips on grok at 480p: $0.05 each, $0.002 more for each first frame sent.
    await expect(page.getByTestId('seq-estimate')).toContainText('5 clips');
    await page.getByTestId('seq-start').click();

    // Steps 1 and 2 are made; step 3 was sent and is still generating.
    await expect.poll(() => jobs.submits().length, { timeout: 120_000 }).toBe(3);
    await expect(slots(page).nth(2)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await expect(slots(page).nth(0)).toHaveAttribute('data-status', 'done');
    await expect(slots(page).nth(1)).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('video-clip')).toHaveCount(2);
    const downloadsBefore = jobs.downloads().length;

    await page.reload();

    // After the reload the sequence, its progress and the two clips are back (downloaded again).
    await expect(slots(page)).toHaveCount(5);
    await expect(slots(page).nth(2)).toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId('video-clip-player')).toHaveCount(2, { timeout: 60_000 });
    expect(jobs.downloads().length).toBeGreaterThanOrEqual(downloadsBefore + 2);

    jobs.release(3);
    await expect(page.locator('[data-testid="seq-slot"][data-status="done"]')).toHaveCount(5, {
      timeout: 240_000,
    });
    await expect(page.getByTestId('seq-message')).toHaveText('Finished: all 5 steps made.');
    const bodies = jobs.submits();
    expect(bodies).toHaveLength(5);

    // Step 1 starts from its prompt; every later step from the previous clip's last frame, a PNG at full size.
    expect(bodies[0]!.frame_images).toBeUndefined();
    expect(bodies[0]!.prompt).toBe(prompts[0]);
    const frames: string[] = [];
    for (const [index, body] of bodies.entries()) {
      expect(body.prompt).toBe(prompts[index]);
      if (index === 0) continue;
      expect(body.frame_images).toHaveLength(1);
      expect(body.input_references).toBeUndefined();
      const frame = firstFrameOf(body);
      expect(frame).toMatch(/^data:image\/png;base64,/);
      expect(pngSize(frame!)).toEqual({ width: 544, height: 544 });
      frames.push(frame!);
    }
    // Every clip is the same fixture, so every step sent the same frame: the clip's last, not its first.
    expect(new Set(frames).size).toBe(1);
    const distances = await frameDistances(page, frames[0]!);
    expect(distances.toLast).toBeLessThan(4);
    expect(distances.toLast).toBeLessThan(distances.toFirst);

    // The clips are on the timeline in step order; chained ones leave out their repeated first frame.
    const clips = page.getByTestId('video-clip');
    await expect(clips).toHaveCount(5);
    for (let index = 0; index < 5; index++) {
      await expect(clips.nth(index).getByTestId('video-clip-meta')).toContainText(
        `Sequence step ${index + 1}`,
      );
      await expect(clips.nth(index)).toContainText(prompts[index]!);
      if (index > 0) await expect(clips.nth(index).getByTestId('video-drop-first')).toBeChecked();
    }
    await expect(page.getByTestId('video-clip-player')).toHaveCount(5, { timeout: 60_000 });

    // Join: one MP4 of about 5 x 1.04 s minus the 4 dropped frames, which decodes and plays.
    await page.getByTestId('video-join').click();
    await expect(page.getByTestId('video-export')).toHaveCount(1, { timeout: 600_000 });
    const joined = await page
      .getByTestId('video-export-player')
      .locator('video')
      .evaluate(async (video: HTMLVideoElement) => {
        if (video.readyState < 1) {
          await new Promise((resolve) =>
            video.addEventListener('loadedmetadata', resolve, { once: true }),
          );
        }
        video.muted = true;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 800));
        video.pause();
        return {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
          played: video.currentTime,
        };
      });
    const expected = 5 * CLIP_SECONDS - 4 / 24;
    expect(joined.width).toBe(544);
    expect(joined.height).toBe(544);
    expect(joined.duration).toBeGreaterThan(expected - 0.15);
    expect(joined.duration).toBeLessThan(expected + 0.15);
    expect(joined.played).toBeGreaterThan(0.1);
    // The dev server isolates the page (multi-threaded ffmpeg); the build without its service worker does not
    // (the single-threaded fallback). Either way the join above worked.
    const isolated = await page.evaluate(() => crossOriginIsolated);
    expect(isolated).toBe(isDevServer(test.info()));
    test.info().annotations.push({
      type: 'ffmpeg',
      description: isolated ? 'multi-threaded (isolated page)' : 'single-threaded (not isolated)',
    });
    expect(problems).toEqual([]);
  });

  test('a spend cap stops a sequence before a step would pass it, and nothing more is sent', async ({
    page,
    context,
    mock,
  }) => {
    test.setTimeout(300_000);
    await seedApp(context, { key: true, settings: NO_BUDGETS });
    const jobs = mockVideoJobs(mock, { pendingPolls: 1, cost: 0.052 });
    mockVideoCatalog(mock);
    const problems = await watchForProblems(page);
    await page.goto('tools/video-studio/');

    // $0.05 for the first step, $0.052 for each later one (its first frame): a $0.12 cap allows two.
    await buildSequence(page, ['One', 'Two', 'Three', 'Four', 'Five'], { cap: '0.12' });
    await page.getByTestId('seq-start').click();

    await expect(page.getByTestId('seq-message')).toContainText('Stopped before step 3', {
      timeout: 120_000,
    });
    await expect(page.getByTestId('seq-message')).toContainText('$0.12 spend cap');
    await expect(page.getByTestId('seq-resume')).toBeVisible();
    // Give a stray submit time to show up: there must be none.
    await page.waitForTimeout(3000);
    expect(jobs.submits()).toHaveLength(2);
    const statuses = await slots(page).evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-status')),
    );
    expect(statuses).toEqual(['done', 'done', 'pending', 'pending', 'pending']);
    await expect(page.getByTestId('seq-spent')).toContainText('$0.10');
    await expect(page.getByTestId('video-clip')).toHaveCount(2);
    expect(problems).toEqual([]);
  });
});
