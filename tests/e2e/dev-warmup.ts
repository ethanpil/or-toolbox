/**
 * Global setup for the dev-server run (playwright.dev.config.ts). On a cold dev server Vite discovers and
 * pre-bundles dependencies during the first page loads and then reloads those pages, which makes the first
 * specs time out mid-navigation (most visibly the dev hook specs, whose `page.evaluate` lands in the reload).
 * Visiting one page of each kind first lets Vite settle before any test starts. Playwright starts the
 * webServer before global setup, so the server is up here.
 */
import { type Browser, chromium, firefox, type FullConfig, webkit } from '@playwright/test';

const PAGES = [
  '',
  'settings/',
  'models/',
  'history/',
  'stats/',
  'tools/chat/',
  'tools/image-generation/',
];

export default async function warmUp(config: FullConfig): Promise<void> {
  const baseURL = config.projects.find((project) => project.use.baseURL)?.use.baseURL;
  if (!baseURL) return;
  // Whichever browser this machine has (a CI job installs only the one it tests).
  let browser: Browser | null = null;
  for (const type of [chromium, firefox, webkit]) {
    browser = await type.launch().catch(() => null);
    if (browser) break;
  }
  if (!browser) return;
  try {
    const page = await browser.newPage();
    for (const path of PAGES) {
      // Twice: the first visit may trigger Vite's "optimized dependencies changed" reload.
      for (let pass = 0; pass < 2; pass++) {
        await page.goto(new URL(path, baseURL).href, { waitUntil: 'load', timeout: 180_000 });
        await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
      }
    }
  } finally {
    await browser.close();
  }
}
