/**
 * Helpers shared by the e2e specs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type Request, type TestInfo } from '@playwright/test';
import { preview } from 'vite';
import { discoverPages } from '../../vite-plugins/pages.ts';
import { basePath, PREVIEW_PORT } from '../../vite-plugins/site.ts';

const ROOT = join(import.meta.dirname, '..', '..');

export interface SitePage {
  /** Path relative to the site base: `''` for Home, `'settings/'`, `'tools/chat/'`. */
  route: string;
  /** The page's own title, i.e. the `<title>` of its HTML entry before the " · ORtoolbox" suffix. */
  title: string;
}

/** Every page of the site, found the same way the build finds them. */
export const SITE_PAGES: SitePage[] = discoverPages(ROOT).map(({ route, file }) => {
  const title = /<title>([^<]*)<\/title>/.exec(readFileSync(join(ROOT, file), 'utf8'))?.[1];
  if (!title) throw new Error(`${file} has no <title>`);
  return { route, title };
});

/** True when the run targets the dev server (playwright.dev.config.ts), which isolates pages with real headers. */
export function isDevServer(testInfo: TestInfo): boolean {
  return testInfo.config.metadata.server === 'dev';
}

export interface WatchOptions {
  /**
   * URL paths (exact, e.g. `'/api/v1/chat/completions'`) of requests the app aborts on purpose: Stop cancels the
   * requests in flight, and the API client cancels a stream once it has read `data: [DONE]`, which Chromium can
   * report before it has seen the end of the body. Their abort is not a problem; any other failure of them still
   * is.
   */
  allowAborted?: readonly string[];
}

/** How each engine reports a request the page aborted: Chromium, Firefox, WebKit. */
const ABORTED = new Set(['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled']);

/**
 * Collects everything that should never happen on a healthy page: console
 * errors, uncaught exceptions, failed responses and CSP violations. Call
 * before the first `page.goto()`, then assert the returned list is empty.
 *
 * Always ignored: an abort (`ABORTED`) of an `<audio>`/`<video>` read of a
 * `blob:` URL (the element cancels range reads it no longer needs: after the
 * metadata, on a seek), and of the site's own files (the app never aborts
 * them; the browser does when a page leaves at once, as the OAuth callback
 * does: Firefox drops the logo, WebKit the icon font preload). Aborts the app
 * causes itself (requests to OpenRouter) are opt-in per test through
 * `allowAborted`.
 *
 * ```ts
 * const problems = await watchForProblems(page, { allowAborted: ['/api/v1/chat/completions'] });
 * await page.goto('tools/chat/');
 * expect(problems).toEqual([]);
 * ```
 */
export async function watchForProblems(
  page: Page,
  { allowAborted = [] }: WatchOptions = {},
): Promise<string[]> {
  const problems: string[] = [];
  const expectedAbort = (request: Request): boolean =>
    ['localhost', '127.0.0.1'].includes(new URL(request.url()).hostname) ||
    (request.url().startsWith('blob:')
      ? request.resourceType() === 'media'
      : allowAborted.includes(new URL(request.url()).pathname));

  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown';
    if (ABORTED.has(errorText) && expectedAbort(request)) return;
    problems.push(`request failed: ${request.url()} (${errorText})`);
  });

  // Browsers word CSP console messages differently (or not at all), so report
  // violations ourselves, in one format, through the channel captured above.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(
        `CSP violation: ${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`,
      );
    });
  });

  return problems;
}

/** Resolves once the page reports `crossOriginIsolated`, riding out an automatic reload. */
export async function waitUntilIsolated(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.crossOriginIsolated, null, { timeout });
}

/** Resolves once a service worker controls the page. */
export async function waitUntilControlled(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout });
}

/** Asserts the stylesheet (our primary colour) and the self-hosted icon font are in effect. */
export async function expectStyledWithIcons(page: Page): Promise<void> {
  const primary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
  );
  expect(primary).toBe('#4f46e5');
  const iconFont = await page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check('16px bootstrap-icons');
  });
  expect(iconFont).toBe(true);
}

/** Every URL in this origin's caches whose cache name starts with `cachePrefix`. */
export function cachedUrls(page: Page, cachePrefix = 'ortoolbox-'): Promise<string[]> {
  return page.evaluate(async (prefix) => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(prefix)) continue;
      for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    }
    return urls;
  }, cachePrefix);
}

/**
 * Clicks one of the diagnostics page's ffmpeg buttons and waits for the
 * result. Returns the core that ran; fails the test if the run failed.
 */
export async function runFfmpegSmokeTest(
  page: Page,
  button: 'diag-ffmpeg-run' | 'diag-ffmpeg-run-single',
): Promise<string | null> {
  // By keyboard: the path where keeping focus on the button matters (and
  // WebKit does not focus buttons on click).
  await page.getByTestId(button).focus();
  await page.keyboard.press('Enter');
  const status = page.getByTestId('diag-ffmpeg-status');
  // Downloads and compiles a 32 MB WebAssembly module, then encodes video.
  await expect(status).toHaveAttribute('data-value', /passed|failed/, { timeout: 150_000 });
  await expect(status).toHaveAttribute('data-value', 'passed');
  await expect(page.getByTestId('diag-ffmpeg-output')).not.toHaveAttribute('data-value', '');
  await expect(page.getByTestId('diag-ffmpeg-preview').locator('video')).toBeVisible();
  return page.getByTestId('diag-ffmpeg-core').getAttribute('data-value');
}

/** Runs axe (WCAG 2.2 A/AA) and fails on serious or critical violations. */
export async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  // A toast fading in is half transparent, and axe would measure its text at that contrast. Bootstrap drops
  // `showing` when the fade starts, not when it ends, so wait for every toast on screen to be fully opaque.
  await page.waitForFunction(
    () =>
      document.querySelector('.toast.showing, .toast.hiding') === null &&
      [...document.querySelectorAll('.toast.show')].every(
        (toast) => getComputedStyle(toast).opacity === '1',
      ),
  );
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious).toEqual([]);
}

/**
 * A private `vite preview` of the build on a port of its own, which a test
 * can shut down to take the host offline. (Playwright's
 * `context.setOffline()` is not usable for this: in WebKit it also fails the
 * requests the service worker would answer from its cache.)
 */
export async function startPrivatePreview(
  testInfo: TestInfo,
): Promise<{ baseURL: string; stop: () => Promise<void> }> {
  const port = PREVIEW_PORT + 10 + testInfo.parallelIndex;
  const server = await preview({
    configFile: join(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    preview: { host: '127.0.0.1', port, strictPort: true },
  });
  let stopped = false;
  return {
    // 127.0.0.1 counts as a secure context, so service workers are allowed.
    baseURL: `http://127.0.0.1:${port}${basePath()}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
      await server.close();
    },
  };
}
