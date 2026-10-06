/**
 * Stage 0 gate: the service worker makes pages cross-origin isolated, and
 * only the pages that need threads ever reload for it.
 *
 * Each test starts in a fresh browser context, i.e. as a first-time visitor
 * with no service worker installed.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../../mock/index.ts';
import { waitUntilControlled, waitUntilIsolated, watchForProblems } from '../support.ts';

/**
 * That no reload happens can only be seen over time: nothing announces a reload that did not come. The page decides
 * at start (the isolation guard runs once, from its first script), so a couple of seconds after the worker controls
 * it is far longer than a reload would take.
 */
const stayedPut = (page: Page, ms = 2000): Promise<void> => page.waitForTimeout(ms);

/**
 * Counts documents requested by the main frame: 1 for the first load, +1 per reload or navigation. Counts
 * navigation requests rather than `framenavigated`, which also fires for same-document history changes (the
 * OAuth callback removes its single-use code from the address bar with `history.replaceState`), and rather
 * than `load`, which a reload at page start can pre-empt.
 */
function countDocuments(page: Page): () => number {
  let documents = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents += 1;
  });
  return () => documents;
}

const isolated = (page: Page): Promise<boolean> => page.evaluate(() => window.crossOriginIsolated);

test('a page that needs threads reloads exactly once on a first visit, then is isolated', async ({
  page,
}) => {
  const documents = countDocuments(page);
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);
  expect(documents()).toBe(2);

  // No reload loop: the page stays put.
  await stayedPut(page, 3000);
  expect(documents()).toBe(2);
  expect(await isolated(page)).toBe(true);
  await expect(page.getByTestId('page-title')).toHaveText('Diagnostics');
});

test('other pages never reload; the next page they open is isolated', async ({ page }) => {
  const documents = countDocuments(page);
  await page.goto('');
  await waitUntilControlled(page);
  await stayedPut(page);
  expect(documents()).toBe(1);
  expect(await isolated(page)).toBe(false);

  await page.goto('settings/');
  expect(await isolated(page)).toBe(true);
  expect(documents()).toBe(2);
});

test('the OAuth callback never reloads, even on a first visit', async ({ page }) => {
  const documents = countDocuments(page);
  const callback = 'auth/callback/?code=single-use-code&state=abc';
  await page.goto(callback);
  await waitUntilControlled(page);
  await stayedPut(page);

  expect(documents()).toBe(1);
  const navigation = await page.evaluate(
    () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type,
  );
  expect(navigation).toBe('navigate');
});

test('a page the user has started using does not reload for isolation', async ({
  page,
  context,
}) => {
  // A key press before the worker is ready: the page module listens from its start, and on a first visit the
  // worker is still installing the shell when the document has been parsed.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    });
  });
  const documents = countDocuments(page);
  await page.goto('diagnostics/');
  await waitUntilControlled(page);
  await stayedPut(page);

  expect(documents()).toBe(1);
  expect(await isolated(page)).toBe(false);
  // Left for the next navigation, which the worker serves isolated.
  await page.goto('settings/');
  expect(await isolated(page)).toBe(true);
});

test('the isolation reload restores the parameters the tool already consumed', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Tool pages call OpenRouter; WebKit lets those escape the mock.',
  );
  const navigations: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      navigations.push(request.url());
    }
  });
  await page.goto('tools/video-studio/?sample=1');
  await waitUntilIsolated(page);

  expect(navigations).toHaveLength(2);
  expect(new URL(navigations[1] ?? '').searchParams.get('sample')).toBe('1');
});

test('a page opened by Send to never reloads: the hand-over cannot be repeated', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'Tool pages call OpenRouter; WebKit lets those escape the mock.',
  );
  const documents = countDocuments(page);
  await page.goto('tools/video-studio/?receive=hand-over-1');
  await waitUntilControlled(page);
  await stayedPut(page);

  expect(documents()).toBe(1);
});

test('the isolation reload happens at most once per tab', async ({ page, context }) => {
  // As if this tab had already reloaded once without becoming isolated.
  await context.addInitScript(() => {
    sessionStorage.setItem('ortoolbox:isolation-reload', '1');
  });
  const documents = countDocuments(page);
  await page.goto('diagnostics/');
  await waitUntilControlled(page);
  await stayedPut(page);

  expect(documents()).toBe(1);
  expect(await isolated(page)).toBe(false);
});

test('once the worker is in control, every page is isolated from the first byte', async ({
  page,
}) => {
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  const documents = countDocuments(page);
  const problems = await watchForProblems(page);
  // No tool page here: tool pages read the model catalog from openrouter.ai, and WebKit lets requests from a
  // worker-controlled page escape the mock (see the skipped test below). Diagnostics, visited above, is the
  // page that needs threads.
  for (const route of ['', 'settings/', 'privacy/', 'auth/callback/']) {
    await page.goto(route);
    expect(await isolated(page), route).toBe(true);
  }
  await stayedPut(page);

  expect(documents()).toBe(4);
  expect(problems).toEqual([]);
});

test('the diagnostics page reports the worker and the isolation', async ({ page }) => {
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  await expect(page.getByTestId('diag-isolated')).toHaveAttribute('data-value', 'true');
  await expect(page.getByTestId('diag-sab')).toHaveAttribute('data-value', 'true');
  await expect(page.getByTestId('diag-sw-state')).toHaveAttribute('data-value', 'controlling');
  await expect(page.getByTestId('diag-coep-mode')).toHaveAttribute('data-value', 'require-corp');
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
  await page.goto('diagnostics/');
  await waitUntilIsolated(page);

  const status = await page.evaluate(async () => {
    const response = await fetch('https://openrouter.ai/api/v1/models');
    return response.status;
  });

  expect(status).toBe(200);
  expect(mock.calls('/api/v1/models')).toHaveLength(1);
});
