import { defineConfig } from '@playwright/test';
import gate from './playwright.config.ts';
import { basePath, DEV_PORT } from './vite-plugins/site.ts';

/**
 * The development run (`npm run e2e:dev -- <spec>`): the same specs against
 * the Vite dev server, reusing one that is already running. Fast, and safe to
 * run while others work, because it never touches `dist/`.
 *
 * The dev server has no service worker and no CSP meta tag, so the `sw-*`
 * projects do not exist here and CSP problems only show up in `npm run e2e`.
 */

const baseURL = `http://localhost:${DEV_PORT}${basePath()}`;

export default defineConfig({
  ...gate,
  use: { ...gate.use, baseURL },
  projects: gate.projects?.filter((project) => !project.name?.startsWith('sw-')),
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
  },
});
