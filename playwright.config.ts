import { defineConfig, devices, type Project } from '@playwright/test';
import { basePath, PREVIEW_PORT } from './vite-plugins/site.ts';

/**
 * The gate run (`npm run e2e`): Playwright against the production build
 * served by `vite preview`, where the production CSP and the service worker
 * are active. `npm run e2e` builds first; this config only starts the server.
 *
 * Two projects per browser:
 *
 * - `chromium`, `firefox`, `webkit`: the default suite. Service workers are
 *   blocked, so pages behave the same on every load and the app is proven to
 *   work without the worker (and without isolation).
 * - `sw-chromium`, `sw-firefox`, `sw-webkit`: service workers allowed. Runs
 *   only tests/e2e/sw/: cross-origin isolation, the offline shell and
 *   multi-threaded ffmpeg.
 *
 * `E2E_SKIP_BROWSERS=firefox` (comma-separated) leaves a browser's projects
 * out, for machines that cannot run it. CI never sets it.
 *
 * For day-to-day work use `npm run e2e:dev` (playwright.dev.config.ts).
 */

const SW_SPECS = '**/sw/**';

const BROWSERS = [
  { name: 'chromium', device: devices['Desktop Chrome'] },
  { name: 'firefox', device: devices['Desktop Firefox'] },
  { name: 'webkit', device: devices['Desktop Safari'] },
];

const skipped = new Set(
  (process.env.E2E_SKIP_BROWSERS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
);

export const projects: Project[] = BROWSERS.filter(({ name }) => !skipped.has(name)).flatMap(
  ({ name, device }) => [
    { name, use: { ...device }, testIgnore: SW_SPECS },
    { name: `sw-${name}`, use: { ...device, serviceWorkers: 'allow' }, testMatch: SW_SPECS },
  ],
);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  // Read by specs through isDevServer() in tests/e2e/support.ts.
  metadata: { server: 'preview' },

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

  projects,

  webServer: {
    command: 'npm run preview',
    url: `http://localhost:${PREVIEW_PORT}${basePath()}`,
    reuseExistingServer: !process.env.CI,
  },
});
