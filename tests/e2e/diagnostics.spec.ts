/**
 * Stage 0 gate: without the service worker the page is not cross-origin
 * isolated and ffmpeg falls back to its single-threaded core.
 *
 * (These projects block service workers. The isolated, multi-threaded case is
 * tests/e2e/sw/ffmpeg.spec.ts.)
 */
import { expect, test } from '../mock/index.ts';
import { watchForProblems } from './support.ts';

test('reports an un-isolated page when no service worker is in control', async ({ page }) => {
  await page.goto('diagnostics/');

  await expect(page.getByTestId('diag-isolated')).toHaveAttribute('data-value', 'false');
  await expect(page.getByTestId('diag-sw-state')).toHaveAttribute('data-value', 'not-registered');
  await expect(page.getByTestId('diag-coep-mode')).toHaveAttribute('data-value', 'none');
  await expect(page.getByTestId('diag-base')).toHaveAttribute(
    'data-value',
    new URL(page.url()).pathname.replace(/diagnostics\/$/, ''),
  );
});

test('ffmpeg runs on the single-threaded core without isolation', async ({ page }) => {
  // Downloads and compiles a 32 MB WebAssembly module, then encodes video.
  test.setTimeout(180_000);
  const problems = await watchForProblems(page);

  await page.goto('diagnostics/');
  await page.getByTestId('diag-ffmpeg-run').click();

  const status = page.getByTestId('diag-ffmpeg-status');
  await expect(status).toHaveAttribute('data-value', /passed|failed/, { timeout: 150_000 });
  await expect(status).toHaveAttribute('data-value', 'passed');
  await expect(page.getByTestId('diag-ffmpeg-core')).toHaveAttribute(
    'data-value',
    'single-threaded',
  );
  await expect(page.getByTestId('diag-ffmpeg-output')).not.toHaveAttribute('data-value', '');
  await expect(page.getByTestId('diag-ffmpeg-preview').locator('video')).toBeVisible();

  expect(problems).toEqual([]);
});
