/**
 * Stage 0 gate: the service worker makes pages cross-origin isolated.
 *
 * Each test starts in a fresh browser context, i.e. as a first-time visitor
 * with no service worker installed.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../../mock/index.ts';
import { waitUntilIsolated, watchForProblems } from '../support.ts';

/** Counts documents loaded in the main frame: 1 for the first load, +1 per reload or navigation. */
function countDocuments(page: Page): () => number {
  let documents = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) documents += 1;
  });
  return () => documents;
}

/**
 * Automatic reloads a first visit needs before it is isolated: one where the
 * browser honours `COEP: credentialless`, two where the worker has to fall
 * back to `require-corp`.
 */
const FIRST_VISIT_RELOADS: Record<string, number> = { chromium: 1, firefox: 1, webkit: 2 };

test('a first visit becomes isolated after the automatic reload, and never reloads again', async ({
  page,
  browserName,
}) => {
  const documents = countDocuments(page);

  await page.goto('');
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(false);

  await waitUntilIsolated(page);
  const afterIsolation = documents();
  expect(afterIsolation - 1).toBe(FIRST_VISIT_RELOADS[browserName]);

  // No reload loop: the page stays put.
  await page.waitForTimeout(3000);
  expect(documents()).toBe(afterIsolation);
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  await expect(page.getByTestId('page-title')).toHaveText('ORtoolbox');
});

test('later pages are isolated from the first byte, with no reload', async ({ page }) => {
  await page.goto('');
  await waitUntilIsolated(page);

  const documents = countDocuments(page);
  const problems = await watchForProblems(page);
  for (const route of ['settings/', 'tools/video-studio/', 'diagnostics/']) {
    await page.goto(route);
    expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  }
  await page.waitForTimeout(2000);

  expect(documents()).toBe(3);
  expect(problems).toEqual([]);
});

test('the diagnostics page reports the worker and the isolation', async ({ page, browserName }) => {
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  await expect(page.getByTestId('diag-isolated')).toHaveAttribute('data-value', 'true');
  await expect(page.getByTestId('diag-sab')).toHaveAttribute('data-value', 'true');
  await expect(page.getByTestId('diag-sw-state')).toHaveAttribute('data-value', 'controlling');
  await expect(page.getByTestId('diag-coep-mode')).toHaveAttribute(
    'data-value',
    browserName === 'webkit' ? 'require-corp' : 'credentialless',
  );
});

test('the worker leaves OpenRouter requests alone, so mocks still apply', async ({
  page,
  mock,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Playwright cannot intercept requests from a page controlled by a service worker in WebKit ' +
      '(the request bypasses context.route). Specs in tests/e2e/sw/ must not call OpenRouter.',
  );
  await page.goto('');
  await waitUntilIsolated(page);

  const status = await page.evaluate(async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    return response.status;
  });

  expect(status).toBe(200);
  expect(mock.calls('/api/v1/models')).toHaveLength(1);
});

test('a user who is already interacting is not interrupted by the reload', async ({
  page,
  browserName,
}) => {
  // A real click can lose the race against a fast worker install, so press a
  // key the moment the page registers the worker (sw-register.ts starts
  // listening for input just before that call). First document only.
  await page.addInitScript(() => {
    const container = navigator.serviceWorker;
    const register = container.register.bind(container);
    container.register = (...args: Parameters<ServiceWorkerContainer['register']>) => {
      if (!sessionStorage.getItem('test:pressed')) {
        sessionStorage.setItem('test:pressed', '1');
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      }
      return register(...args);
    };
  });
  const documents = countDocuments(page);
  await page.goto('');

  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForTimeout(2000);
  expect(documents()).toBe(1);

  // The next page they open comes through the worker. Where the browser
  // honours COEP credentialless it is isolated straight away; elsewhere the
  // remaining reload (switching to require-corp) happens on that page.
  await page.goto('settings/');
  await waitUntilIsolated(page);
  expect(documents() - 2).toBe(FIRST_VISIT_RELOADS[browserName]! - 1);
});
