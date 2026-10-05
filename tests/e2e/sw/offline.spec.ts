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

test('the offline shell is the pages, the eager assets and the small lazy chunks', async ({
  page,
}) => {
  const pages = await cachedUrls(page, 'ortoolbox-pages-');
  const assets = await cachedUrls(page, 'ortoolbox-assets');

  expect(pages.some((url) => url.endsWith('/settings/index.html'))).toBe(true);
  expect(pages.some((url) => url.endsWith('/theme-init.js'))).toBe(true);
  expect(assets.some((url) => /\/assets\/.+\.css$/.test(url))).toBe(true);
  expect(assets.some((url) => url.endsWith('.woff2'))).toBe(true);
  // Lazy chunks too (a page served from the cache after a deploy needs them: the host no longer has them).
  expect(assets.some((url) => /\/assets\/marked\.esm-.+\.js$/.test(url))).toBe(true);
  expect(assets.some((url) => /\/assets\/worker-.+\.js$/.test(url))).toBe(true);
  // The ffmpeg cores and pdf.js's big worker, wasm, fonts and CMaps are cached on first use.
  expect(
    [...pages, ...assets].filter((url) =>
      /\/vendor\/|\/assets\/pdf\.worker|\.(wasm|bcmap|pfb|ttf)$/.test(url),
    ),
  ).toEqual([]);
});

test('a poisoned cache entry is never served, and is repaired from the network', async ({
  page,
}, testInfo) => {
  // Back online for this one: the repair downloads the real file.
  const online = await startPrivatePreview(testInfo);
  try {
    await page.goto(online.baseURL);
    await waitUntilControlled(page);
    // Another site on the host shares this CacheStorage and can write to it.
    const poisoned = await page.evaluate(async () => {
      const cache = await caches.open('ortoolbox-assets');
      const entry = (await cache.keys()).find((request) =>
        /\/assets\/shell-.+\.js$/.test(request.url),
      );
      if (!entry) throw new Error('No shell chunk cached');
      await cache.put(
        entry.url,
        new Response('document.title = "pwned"', {
          headers: { 'content-type': 'text/javascript' },
        }),
      );
      const pages = await caches.open(
        (await caches.keys()).find((name) => name.startsWith('ortoolbox-pages-')) ?? '',
      );
      await pages.put(
        new URL('settings/index.html', location.href).href,
        new Response('<!doctype html><title>pwned</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      );
      return entry.url;
    });

    await page.goto(`${online.baseURL}settings/`);
    await expect(page.getByTestId('page-title')).toHaveText('Settings');
    expect(await page.title()).not.toContain('pwned');
    await expect
      .poll(() =>
        page.evaluate(async (url) => {
          const cached = await (await caches.open('ortoolbox-assets')).match(url);
          return cached ? (await cached.text()).includes('pwned') : 'missing';
        }, poisoned),
      )
      .toBe(false);
  } finally {
    await online.stop();
  }
});
