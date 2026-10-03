/**
 * Helpers shared by the e2e specs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
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

/**
 * Collects everything that should never happen on a healthy page: console
 * errors, uncaught exceptions, failed responses and CSP violations. Call
 * before the first `page.goto()`, then assert the returned list is empty.
 *
 * ```ts
 * const problems = await watchForProblems(page);
 * await page.goto('settings/');
 * expect(problems).toEqual([]);
 * ```
 */
export async function watchForProblems(page: Page): Promise<string[]> {
  const problems: string[] = [];

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
    problems.push(
      `request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
    );
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
