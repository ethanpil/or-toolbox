/**
 * Stage 0 gate: on a cross-origin isolated page ffmpeg loads its
 * multi-threaded core, under the production CSP, and the worker caches the
 * lazily loaded pieces on first use.
 */
import { expect, test } from '../../mock/index.ts';
import { cachedUrls, runFfmpegSmokeTest, waitUntilIsolated, watchForProblems } from '../support.ts';

// Downloads and compiles a 32 MB WebAssembly module, then encodes video.
test.setTimeout(180_000);

test('ffmpeg runs on the multi-threaded core when isolated', async ({ page }) => {
  const problems = await watchForProblems(page);
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  expect(await runFfmpegSmokeTest(page, 'diag-ffmpeg-run')).toBe('multi-threaded');
  expect(problems).toEqual([]);
});

test('the single-threaded core can still be chosen; lazy files are cached on first use', async ({
  page,
}) => {
  const problems = await watchForProblems(page);
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);
  const before = await cachedUrls(page, 'ortoolbox-assets');

  expect(await runFfmpegSmokeTest(page, 'diag-ffmpeg-run-single')).toBe('single-threaded');

  await expect
    .poll(async () =>
      (await cachedUrls(page, 'ortoolbox-assets')).map((url) => url.split('/or-toolbox/')[1]),
    )
    .toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^vendor\/ffmpeg\/core-[\d.]+\/ffmpeg-core\.wasm$/),
        expect.stringMatching(/^vendor\/ffmpeg\/core-[\d.]+\/ffmpeg-core\.js$/),
        expect.stringMatching(/^assets\/worker-[\w-]+\.js$/),
      ]),
    );
  // None of these were part of the offline shell.
  expect(before.filter((url) => /\/vendor\/|\/assets\/worker-/.test(url))).toEqual([]);
  expect(problems).toEqual([]);
});
