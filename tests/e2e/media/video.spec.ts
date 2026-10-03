import { expect, test } from '../../mock/index.ts';
import { fixture, openMediaPage } from './support.ts';

test.setTimeout(180_000);

test('reads metadata and grabs the first, last and any other frame', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(
    async ({ clip, speech }) => {
      const { video, helpers } = window.__media as NonNullable<Window['__media']>;
      const blob = helpers.blobOf(clip);

      const metadata = await video.getVideoMetadata(blob);
      const first = await video.captureFrame(blob, 'first');
      const last = await video.captureFrame(blob, 'last');
      const lastWithRate = await video.captureFrame(blob, 'last', { fps: 24 });
      const clamped = await video.captureFrame(blob, 99); // the browser clamps a seek past the end
      const middle = await video.captureFrame(blob, 0.5);
      const negative = await video.captureFrame(blob, -3);

      const pixels = {
        first: await helpers.pixels(first),
        last: await helpers.pixels(last),
        lastWithRate: await helpers.pixels(lastWithRate),
        clamped: await helpers.pixels(clamped),
        middle: await helpers.pixels(middle),
        negative: await helpers.pixels(negative),
      };

      const progress: number[] = [];
      const thumbnails = await video.frameAtTimes(blob, [0, 0.5, 1, 99], {
        maxWidth: 100,
        onFrame: (index) => progress.push(index),
      });
      const thumbnailPixels = await Promise.all(
        thumbnails.map((thumbnail) => helpers.pixels(thumbnail)),
      );

      const audioOnly = await video.getVideoMetadata(helpers.blobOf(speech)).then(
        () => 'resolved',
        (error: unknown) => (error as Error).message,
      );

      return {
        metadata,
        types: [first.type, last.type, middle.type, thumbnails[0]?.type],
        size: [pixels.first.width, pixels.first.height],
        differences: {
          firstToLast: helpers.meanDifference(pixels.first, pixels.last),
          firstToMiddle: helpers.meanDifference(pixels.first, pixels.middle),
          middleToLast: helpers.meanDifference(pixels.middle, pixels.last),
          lastToLastWithRate: helpers.meanDifference(pixels.last, pixels.lastWithRate),
          lastToClamped: helpers.meanDifference(pixels.last, pixels.clamped),
          firstToNegative: helpers.meanDifference(pixels.first, pixels.negative),
        },
        thumbnails: thumbnailPixels.map((p) => [p.width, p.height]),
        progress,
        audioOnly,
      };
    },
    { clip: fixture('video-1s.mp4'), speech: fixture('speech.mp3') },
  );

  expect(result.metadata.width).toBe(544);
  expect(result.metadata.height).toBe(544);
  expect(result.metadata.duration).toBeGreaterThan(1);
  expect(result.metadata.duration).toBeLessThan(1.1);
  expect(result.types).toEqual(['image/png', 'image/png', 'image/png', 'image/jpeg']);
  expect(result.size).toEqual([544, 544]);

  // The "last" frame is the final frame: the same picture as a seek clamped to the end, and not the first frame.
  expect(result.differences.lastToClamped).toBeLessThan(1);
  expect(result.differences.lastToLastWithRate).toBeLessThan(1);
  expect(result.differences.firstToNegative).toBeLessThan(0.5);
  expect(result.differences.firstToLast).toBeGreaterThan(1);

  expect(result.thumbnails).toEqual([
    [100, 100],
    [100, 100],
    [100, 100],
    [100, 100],
  ]);
  expect(result.progress).toEqual([0, 1, 2, 3]);
  expect(result.audioOnly).toBe('This file has no video track.');
  expect(problems).toEqual([]);
});
