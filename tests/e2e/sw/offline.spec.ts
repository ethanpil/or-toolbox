/**
 * Stage 0 gate: after one online visit the site shell loads offline.
 *
 * Each test serves the build from a private `vite preview` and shuts it down
 * to go offline (see `startPrivatePreview()` for why not
 * `context.setOffline()`).
 */
import { expect, test } from '../../mock/index.ts';
import {
  cachedUrls,
  expectStyledWithIcons,
  startPrivatePreview,
  waitUntilControlled,
} from '../support.ts';

let host: Awaited<ReturnType<typeof startPrivatePreview>>;

test.beforeEach(async ({ page }, testInfo) => {
  host = await startPrivatePreview(testInfo);
  await page.goto(host.baseURL);
  // In control means installed: the whole shell is cached before activation.
  await waitUntilControlled(page);
  await host.stop();
});

test.afterEach(async () => {
  await host.stop();
});

test('the shell loads offline after one online visit', async ({ page }) => {
  // Pages never visited online, one with a query string, and a reload.
  for (const [route, heading] of [
    ['settings/', 'Settings'],
    ['tools/video-studio/', 'Video studio'],
    ['history/?tool=ocr', 'History'],
  ] as const) {
    await page.goto(host.baseURL + route);
    await expect(page.getByTestId('page-title')).toHaveText(heading);
  }
  await page.reload();
  await expect(page.getByTestId('page-title')).toHaveText('History');

  await page.goto(`${host.baseURL}tools/chat/`);
  await expectStyledWithIcons(page);
  // Still isolated offline: cached responses carry the headers as well.
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});

test('an unknown address falls back to Home while offline', async ({ page }) => {
  await page.goto(`${host.baseURL}no-such-page/`);
  await expect(page.getByTestId('page-title')).toHaveText('ORtoolbox');
});

test('the offline shell is pages and eager assets only', async ({ page }) => {
  const pages = await cachedUrls(page, 'ortoolbox-pages-');
  const assets = await cachedUrls(page, 'ortoolbox-assets');

  expect(pages.some((url) => url.endsWith('/settings/index.html'))).toBe(true);
  expect(pages.some((url) => url.endsWith('/theme-init.js'))).toBe(true);
  expect(assets.some((url) => /\/assets\/.+\.css$/.test(url))).toBe(true);
  expect(assets.some((url) => url.endsWith('.woff2'))).toBe(true);
  // Lazy chunks and the ffmpeg cores are cached on first use, never up front.
  expect(
    [...pages, ...assets].filter((url) => /\/vendor\/|\/assets\/(esm|worker)-/.test(url)),
  ).toEqual([]);
});
