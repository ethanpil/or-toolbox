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
  // The cores were not part of the offline shell (ffmpeg's small worker chunk is).
  expect(before.filter((url) => /\/vendor\//.test(url))).toEqual([]);
  expect(problems).toEqual([]);
});

test('worker scripts and documents carry the policy headers', async ({ page }) => {
  const policies = new Map<string, string | undefined>();
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (/\/assets\/worker-[\w-]+\.js$|\/ffmpeg-core\.worker\.js$|\/diagnostics\/$/.test(path)) {
      policies.set(
        path.replace(/.*\/(assets|diagnostics|vendor)\//, '$1/'),
        response.headers()['content-security-policy'],
      );
    }
  });
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);
  expect(await runFfmpegSmokeTest(page, 'diag-ffmpeg-run')).toBe('multi-threaded');

  const entries = [...policies.entries()];
  const document = entries.find(([path]) => path.startsWith('diagnostics'))?.[1] ?? '';
  expect(document).toContain("frame-ancestors 'none'");
  const workers = entries.filter(([path]) => !path.startsWith('diagnostics'));
  expect(workers.length).toBeGreaterThan(0);
  for (const [path, policy] of workers) {
    expect(policy, path).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy, path).not.toContain('frame-ancestors');
  }
});
