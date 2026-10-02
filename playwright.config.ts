import { spawnSync } from 'node:child_process';
import { defineConfig, devices, firefox, type Project } from '@playwright/test';
import { basePath, PREVIEW_PORT } from './vite-plugins/site.ts';

/**
 * The gate run (`npm run e2e`): Playwright against the production build
 * served by `vite preview`, where the CSP meta tag and the service worker are
 * active. `npm run e2e` builds first; this config only starts the server.
 *
 * Two groups of projects:
 *
 * - `chromium`, `firefox`, `webkit`: the default suite. Service workers are
 *   blocked, so pages behave the same on every load and the app is proven to
 *   work without the worker.
 * - `sw-*`: service workers allowed. Runs only tests/e2e/sw/, the specs about
 *   cross-origin isolation, the offline shell and multi-threaded ffmpeg.
 *
 * For day-to-day work use `npm run e2e:dev` (playwright.dev.config.ts).
 */

const SW_SPECS = '**/sw/**';

/**
 * Playwright's own Firefox build (155 Nightly with Playwright 1.63) does not
 * start on some Windows 10 machines: Windows reports "side-by-side
 * configuration is incorrect" (dependent assembly `mozglue` not found). Rather
 * than fail every Firefox test there, leave those projects out and say so.
 * Never on CI, where a broken browser must fail the run. The result is passed
 * to worker processes through the environment, so the probe runs once.
 */
function firefoxCanStart(): boolean {
  if (process.env.CI) return true;
  process.env.ORTOOLBOX_FIREFOX_STARTS ??= String(
    spawnSync(firefox.executablePath(), ['--version'], { timeout: 30_000 }).error === undefined,
  );
  return process.env.ORTOOLBOX_FIREFOX_STARTS === 'true';
}

const projects: Project[] = [
  { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: SW_SPECS },
  { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: SW_SPECS },
  { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: SW_SPECS },
  {
    name: 'sw-chromium',
    use: { ...devices['Desktop Chrome'], serviceWorkers: 'allow' },
    testMatch: SW_SPECS,
  },
  {
    name: 'sw-firefox',
    use: { ...devices['Desktop Firefox'], serviceWorkers: 'allow' },
    testMatch: SW_SPECS,
  },
  {
    name: 'sw-webkit',
    use: { ...devices['Desktop Safari'], serviceWorkers: 'allow' },
    testMatch: SW_SPECS,
  },
];

const firefoxOk = firefoxCanStart();
if (!firefoxOk && !process.env.TEST_WORKER_INDEX) {
  console.warn(
    `\n[playwright.config] Skipping the Firefox projects: Playwright's Firefox (${firefox.executablePath()}) ` +
      'does not start on this machine. Run it by hand to see why. CI still runs Firefox.\n',
  );
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    // Specs navigate with paths relative to the site base: page.goto('settings/').
    baseURL: `http://localhost:${PREVIEW_PORT}${basePath()}`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    // Backstop for "no test may reach the real API": everything except
    // localhost goes to a proxy that does not exist, so a request the
    // OpenRouter mock fails to intercept errors out instead of leaving the
    // machine. (Needed in practice: WebKit does not let Playwright intercept
    // requests from a page controlled by a service worker.)
    proxy: { server: 'http://127.0.0.1:9', bypass: 'localhost,127.0.0.1' },
  },

  projects: projects.filter((project) => firefoxOk || !project.name?.includes('firefox')),

  webServer: {
    command: 'npm run preview',
    url: `http://localhost:${PREVIEW_PORT}${basePath()}`,
    reuseExistingServer: !process.env.CI,
  },
});
