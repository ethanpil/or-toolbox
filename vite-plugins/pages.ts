import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A page of the site: one `index.html` entry somewhere under the project root. */
export interface Page {
  /** URL path relative to the base, e.g. `''` (Home), `'settings/'`, `'tools/chat/'`. */
  route: string;
  /** HTML entry relative to the project root with forward slashes, e.g. `'tools/chat/index.html'`. */
  file: string;
}

/** Top-level folders that never contain pages. Dot-folders are skipped as well. */
const NOT_PAGES = new Set([
  'node_modules',
  'dist',
  'src',
  'public',
  'tests',
  'docs',
  'scripts',
  'vite-plugins',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

/**
 * Finds every `index.html` under `root`. Adding a page is just adding a folder
 * with an `index.html` in it: the build, the dev server and the route tests
 * all use this list.
 */
export function discoverPages(root: string): Page[] {
  const pages: Page[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skip = entry.name.startsWith('.') || (dir === '' && NOT_PAGES.has(entry.name));
        if (!skip) walk(dir === '' ? entry.name : `${dir}/${entry.name}`);
      } else if (entry.name === 'index.html') {
        const route = dir === '' ? '' : `${dir}/`;
        pages.push({ route, file: `${route}index.html` });
      }
    }
  };

  walk('');
  return pages.sort((a, b) => a.route.localeCompare(b.route));
}
