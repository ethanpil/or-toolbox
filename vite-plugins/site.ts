/**
 * Where the site is served. Shared by the Vite config and the Playwright
 * configs so they can never disagree.
 */

/** Fixed ports so Playwright (and a human) always find the servers in the same place. */
export const DEV_PORT = 5273;
export const PREVIEW_PORT = 4273;

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
