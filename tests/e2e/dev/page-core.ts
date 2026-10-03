/**
 * For the dev-only specs: open a page and reach the core instance the page itself runs (imported from /src, which
 * only the dev server serves).
 */
import type { Page, Request } from '@playwright/test';
import type { CoreServices } from '../../../src/core/types';
import { basePath } from '../../../vite-plugins/site.ts';
import { expect } from '../../mock/index.ts';

declare global {
  interface Window {
    __core?: CoreServices;
  }
}

const CORE_PATH = `${basePath()}src/core/index.ts`;

/**
 * Opens `path`, waits until the shell has mounted it, and puts the page's own core on `window.__core`.
 *
 * The title is drawn in the same task that installs the leave guard and the budget confirmation, so it is the
 * signal that the page is ready. The core must be the module instance the app runs: once a core file has been
 * edited, Vite serves it as `index.ts?t=<time>`, and importing the plain URL would start a second core (its own
 * results, runs and no confirmation handler) that the page never sees. So this imports exactly the URL the page
 * loaded.
 */
export async function openWithCore(page: Page, path: string, title: string): Promise<void> {
  let coreUrl: string | null = null;
  const onRequest = (request: Request): void => {
    const { pathname, search } = new URL(request.url());
    if (pathname === CORE_PATH) coreUrl ??= `${pathname}${search}`;
  };
  page.on('request', onRequest);
  await page.goto(path);
  await expect(page.getByTestId('page-title')).toHaveText(title);
  page.off('request', onRequest);
  if (!coreUrl) throw new Error(`${path} did not load ${CORE_PATH}`);
  await page.evaluate(async (href) => {
    const module = (await import(/* @vite-ignore */ href)) as { getCore: () => CoreServices };
    window.__core = module.getCore();
  }, coreUrl);
}
