/**
 * Stage 0 gate: on a cross-origin isolated page ffmpeg loads its
 * multi-threaded core, under the production CSP.
 */
import { expect, test } from '../../mock/index.ts';
import { waitUntilIsolated, watchForProblems } from '../support.ts';

// Downloads and compiles a 32 MB WebAssembly module, then encodes video.
test.setTimeout(180_000);

test('ffmpeg runs on the multi-threaded core when isolated', async ({ page }) => {
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);
  const problems = await watchForProblems(page);

  await page.getByTestId('diag-ffmpeg-run').click();

  const status = page.getByTestId('diag-ffmpeg-status');
  await expect(status).toHaveAttribute('data-value', /passed|failed/, { timeout: 150_000 });
  await expect(status).toHaveText(/Passed/);
  await expect(page.getByTestId('diag-ffmpeg-core')).toHaveAttribute(
    'data-value',
    'multi-threaded',
  );
  await expect(page.getByTestId('diag-ffmpeg-output')).not.toHaveAttribute('data-value', '');

  expect(problems).toEqual([]);
});

test('the single-threaded core can still be chosen, and the core files are cached by the worker', async ({
  page,
}) => {
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  await page.getByTestId('diag-ffmpeg-run-single').click();
  await expect(page.getByTestId('diag-ffmpeg-status')).toHaveAttribute('data-value', 'passed', {
    timeout: 150_000,
  });
  await expect(page.getByTestId('diag-ffmpeg-core')).toHaveAttribute(
    'data-value',
    'single-threaded',
  );

  // Cached on first use (never precached): the vendor cache now holds the core.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('ortoolbox-vendor-')) continue;
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls.map((url) => url.split('/vendor/')[1]);
  });
  expect(cached).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^ffmpeg\/core-[\d.]+\/ffmpeg-core\.wasm$/),
      expect.stringMatching(/^ffmpeg\/core-[\d.]+\/ffmpeg-core\.js$/),
    ]),
  );
});
