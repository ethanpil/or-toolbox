/**
 * Nothing may frame the site (a framed tool page could be clickjacked into a paid run through `?prompt=` and
 * `?model=`). GitHub Pages cannot send `frame-ancestors`, and a page framed by another site never reaches our
 * service worker (browsers partition workers by top-level site; every *.github.io project is its own site), so
 * public/theme-init.js hides a framed page. The worker's header covers the documents it serves.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../../mock/index.ts';
import { waitUntilControlled } from '../support.ts';

test('a page framed by another site shows nothing', async ({ page, baseURL }) => {
  // A real server on 127.0.0.1 (another site than localhost): browsers refuse to let a page without a local
  // address, such as a routed one, embed localhost at all.
  const framer = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      `<!doctype html><iframe src="${baseURL}settings/" width="800" height="600"></iframe>`,
    );
  });
  await new Promise<void>((resolve) => framer.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(framer.address() as AddressInfo).port}/`);
    await expect
      .poll(() => page.frames().some((candidate) => candidate.url().includes('/settings/')))
      .toBe(true);
    const frame = page.frames().find((candidate) => candidate.url().includes('/settings/'));
    if (!frame) throw new Error('The frame did not load');
    await frame.waitForLoadState();
    expect(await frame.evaluate(() => getComputedStyle(document.documentElement).display)).toBe(
      'none',
    );
  } finally {
    framer.close();
  }
});

test('documents the worker serves forbid framing', async ({ page }) => {
  await page.goto('privacy/');
  await waitUntilControlled(page);
  const policy = await page.evaluate(async () =>
    (await fetch('../settings/')).headers.get('content-security-policy'),
  );
  expect(policy).toContain("frame-ancestors 'none'");
  // Not framed: shown.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).display)).toBe(
    'block',
  );
});
