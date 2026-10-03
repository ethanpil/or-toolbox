/**
 * Stage 0 gate: every page of the site loads cleanly and passes axe.
 *
 * "Cleanly" means HTTP 200, its heading rendered, the stylesheet applied, and
 * no console errors, uncaught exceptions, failed requests or CSP violations.
 * Against the production build this is what proves the CSP is not too tight.
 */
import type { Page } from '@playwright/test';
import { TOOL_IDS } from '../../src/tools/types.ts';
import { expect, seedSettings, test } from '../mock/index.ts';
import {
  expectNoSeriousA11yViolations,
  expectStyledWithIcons,
  SITE_PAGES,
  watchForProblems,
} from './support.ts';

const theme = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.documentElement.getAttribute('data-bs-theme'));

test('the site has the expected pages', () => {
  expect(SITE_PAGES.map((page) => page.route)).toEqual(
    [
      '',
      'auth/callback/',
      'diagnostics/',
      'history/',
      'models/',
      'privacy/',
      'settings/',
      'stats/',
      ...TOOL_IDS.map((id) => `tools/${id}/`),
    ].sort((a, b) => a.localeCompare(b)),
  );
});

for (const { route, title } of SITE_PAGES) {
  test(`/${route} loads cleanly and passes axe in light and dark`, async ({ page }) => {
    const problems = await watchForProblems(page);
    await page.emulateMedia({ colorScheme: 'light' });

    const response = await page.goto(route);
    expect(response?.status()).toBe(200);

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByTestId('page-title')).toHaveText(title);
    await expect(page).toHaveTitle(title === 'ORtoolbox' ? title : `${title} · ORtoolbox`);
    const primary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim(),
    );
    expect(primary).toBe('#4f46e5');
    await page.waitForLoadState('networkidle');

    expect(await theme(page)).toBe('light');
    await expectNoSeriousA11yViolations(page);
    // The page follows the operating system while the theme is "system".
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
    await expectNoSeriousA11yViolations(page);

    expect(problems).toEqual([]);
  });
}

test('the icon font is self-hosted and loads', async ({ page }) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url());
  });

  await page.goto('tools/chat/');
  await expectStyledWithIcons(page);

  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
});

test('Home links to every tool', async ({ page }) => {
  await page.goto('');
  for (const id of TOOL_IDS) await expect(page.getByTestId(`tool-link-${id}`)).toBeVisible();

  await page.getByTestId('tool-link-ocr').click();
  await expect(page).toHaveURL(/\/tools\/ocr\/$/);
  await expect(page.getByTestId('page-title')).toHaveText('OCR');

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByTestId('page-title')).toHaveText('Settings');
});

test.describe('theme', () => {
  test('uses the saved theme, and ignores the system while one is saved', async ({
    page,
    context,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await seedSettings(context, { appearance: { theme: 'dark' } });
    await page.goto('');
    expect(await theme(page)).toBe('dark');
    await page.goto('settings/');
    expect(await theme(page)).toBe('dark');

    await page.emulateMedia({ colorScheme: 'light' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await theme(page)).toBe('dark');
  });

  test('follows the system when set to "system" or not set', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('');
    expect(await theme(page)).toBe('dark');

    await seedSettings(context, { appearance: { theme: 'system' } });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('settings/');
    expect(await theme(page)).toBe('light');
  });

  test('ignores corrupt settings', async ({ page, context }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await context.addInitScript(() => {
      localStorage.setItem('ortoolbox:settings', '{not json');
    });
    await page.goto('');
    expect(await theme(page)).toBe('light');
  });
});
