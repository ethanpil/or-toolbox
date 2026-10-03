/**
 * Where the site is served. Shared by the Vite config and the Playwright
 * configs so they can never disagree.
 */

/** Fixed ports so Playwright (and a human) always find the servers in the same place. */
export const DEV_PORT = 5273;
export const PREVIEW_PORT = 4273;

/**
 * The cross-origin isolation headers. In production the service worker adds
 * them (src/sw/sw.ts, which must stay in step); the dev server sends them
 * itself, so dev pages are isolated without a worker. `vite preview` sends
 * none, like GitHub Pages.
 */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * The site lives at https://ethanpil.github.io/or-toolbox/. The same base is
 * used in dev and in the build so links behave identically everywhere.
 * Override with BASE_PATH (e.g. BASE_PATH=/ for a custom domain). Always
 * starts and ends with a slash.
 */
export function basePath(): string {
  const value = process.env.BASE_PATH ?? '/or-toolbox/';
  return `/${value}/`.replace(/\/{2,}/g, '/');
}
