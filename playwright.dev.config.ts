import { defineConfig } from '@playwright/test';
import gate, { projects } from './playwright.config.ts';
import { basePath, DEV_PORT } from './vite-plugins/site.ts';

/**
 * The development run (`npm run e2e:dev -- <spec>`): the same specs against
 * the Vite dev server, reusing one that is already running. Fast, and safe to
 * run while others work, because it never touches `dist/`.
 *
 * The dev server has no service worker, so the `sw-*` projects do not exist
 * here. It does send the isolation headers itself and serves a CSP built
 * from the same directives as production, so CSP violations and isolation
 * problems show up here too.
 */

const baseURL = `http://localhost:${DEV_PORT}${basePath()}`;

export default defineConfig({
  ...gate,
  metadata: { server: 'dev' },
  use: { ...gate.use, baseURL },
  projects: projects.filter((project) => !project.name?.startsWith('sw-')),
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
  },
});
