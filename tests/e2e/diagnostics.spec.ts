/**
 * Stage 0 gate, service worker blocked:
 *
 * - Against the production build (`npm run e2e`) the page is not
 *   cross-origin isolated, and ffmpeg falls back to its single-threaded core.
 * - Against the dev server (`npm run e2e:dev`) the server's own headers
 *   isolate the page, so the multi-threaded core runs there.
 *
 * The service-worker case is tests/e2e/sw/ffmpeg.spec.ts.
 */
import { expect, test } from '../mock/index.ts';
import { isDevServer, runFfmpegSmokeTest, watchForProblems } from './support.ts';

test('reports the environment', async ({ page }, testInfo) => {
  const isolated = isDevServer(testInfo);
  const problems = await watchForProblems(page);
  await page.goto('diagnostics/');

  await expect(page.getByTestId('diag-isolated')).toHaveAttribute('data-value', String(isolated));
  await expect(page.getByTestId('diag-sab')).toHaveAttribute('data-value', String(isolated));
  await expect(page.getByTestId('diag-sw-state')).toHaveAttribute('data-value', 'not-registered');
  await expect(page.getByTestId('diag-coep-mode')).toHaveAttribute(
    'data-value',
    isolated ? 'require-corp' : 'none',
  );
  await expect(page.getByTestId('diag-base')).toHaveAttribute(
    'data-value',
    new URL(page.url()).pathname.replace(/diagnostics\/$/, ''),
  );
  // Always MB with one decimal, so readings taken at different times compare.
  await expect(page.getByTestId('diag-storage')).toHaveText(
    /^(\d+\.\d MB of \d+\.\d MB|Not reported by this browser)$/,
  );
  expect(problems).toEqual([]);
});

test('ffmpeg picks the core the page can run', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const problems = await watchForProblems(page);
  await page.goto('diagnostics/');

  const core = await runFfmpegSmokeTest(page, 'diag-ffmpeg-run');
  expect(core).toBe(isDevServer(testInfo) ? 'multi-threaded' : 'single-threaded');
  // The button that started the run still has focus afterwards.
  await expect(page.getByTestId('diag-ffmpeg-run')).toBeFocused();
  expect(problems).toEqual([]);
});
