/**
 * Helpers shared by the e2e specs.
 */
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { discoverPages } from '../../vite-plugins/pages.ts';
import { basePath } from '../../vite-plugins/site.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const DIST = join(ROOT, 'dist');

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

/**
 * Collects everything that should never happen on a healthy page: console
 * errors, uncaught exceptions, failed responses and CSP violations. Call
 * before `page.goto()`, then assert the returned list is empty.
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

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/**
 * Serves the production build (`dist/`) the way a static host does (no
 * special headers, directories serve their index.html), on a port of its own.
 * `stop()` takes the host down, which is how the offline tests go offline:
 * Playwright's `context.setOffline()` cannot be used because in WebKit it
 * also fails requests the service worker answers from its cache.
 */
export async function serveBuild(): Promise<{ baseURL: string; stop: () => Promise<void> }> {
  const base = basePath();
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://host').pathname);
    const relative = pathname.startsWith(base) ? pathname.slice(base.length) : null;
    const file =
      relative === null
        ? null
        : resolve(DIST, relative + (pathname.endsWith('/') ? 'index.html' : ''));
    if (!file?.startsWith(DIST) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    });
    createReadStream(file).pipe(response);
  });

  // 127.0.0.1 counts as a secure context, so service workers are allowed.
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}${base}`,
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Resolves once the page reports `crossOriginIsolated`, riding out the automatic reload. */
export async function waitUntilIsolated(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.crossOriginIsolated, null, { timeout });
}
