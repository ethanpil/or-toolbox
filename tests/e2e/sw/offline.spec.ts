/**
 * Stage 0 gate: after one online visit the site shell loads offline.
 *
 * Each test serves the build from a host of its own and shuts that host down
 * to go offline (see `serveBuild()` for why not `context.setOffline()`).
 */
import { expect, test } from '../../mock/index.ts';
import { serveBuild, waitUntilIsolated } from '../support.ts';

let host: Awaited<ReturnType<typeof serveBuild>>;

test.beforeEach(async ({ page }) => {
  host = await serveBuild();
  await page.goto(host.baseURL);
  // Isolated means the worker is installed (the whole shell is precached
  // before it activates) and in control.
  await waitUntilIsolated(page);
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

  // Styled, with icons: CSS and the icon font came from the cache too.
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
  );
  expect(primary).toBe('#4f46e5');
  await page.goto(`${host.baseURL}tools/chat/`);
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return document.fonts.check('16px bootstrap-icons');
    }),
  ).toBe(true);

  // Still isolated offline: cached responses carry the headers as well.
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});

test('an unknown address falls back to Home while offline', async ({ page }) => {
  await page.goto(`${host.baseURL}no-such-page/`);
  await expect(page.getByTestId('page-title')).toHaveText('ORtoolbox');
});

test('the ffmpeg cores are not part of the offline shell', async ({ page }) => {
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  });

  expect(cached.some((url) => url.endsWith('/settings/index.html'))).toBe(true);
  expect(cached.filter((url) => url.includes('/vendor/'))).toEqual([]);
});
