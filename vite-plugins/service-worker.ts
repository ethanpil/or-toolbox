import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Manifest, type Plugin } from 'vite';

/**
 * Builds the single service worker (src/sw/sw.ts) into an un-hashed `sw.js`
 * at the root of the output folder, after the main build has written
 * everything else, and tells it what the offline shell is.
 *
 * The shell is what every page needs to start, nothing more:
 *
 * - `__SHELL_PAGES__`: the HTML pages and the un-hashed public files
 *   (theme-init.js, web manifest, icons). Their names do not change between
 *   builds, so each comes with a SHA-256 of its bytes; the worker checks the
 *   bytes it downloads against it, so a stale CDN copy can never be cached
 *   under the new version.
 * - `__SHELL_ASSETS__`: each page's entry chunk with its static-import
 *   closure, CSS and fonts, taken from Vite's build manifest. These names
 *   carry a content hash, so they are immutable.
 * - `__SW_VERSION__`: a hash over all of the above. Any change to the site
 *   changes sw.js, which is how browsers notice an update.
 *
 * Lazy chunks and the ffmpeg cores are not in the shell; the worker caches
 * them the first time they are requested.
 *
 * Production builds only: the dev server has no service worker.
 */

export interface ShellPage {
  /** Path relative to the site base, e.g. `settings/index.html`. */
  path: string;
  sha256: string;
}

/** Un-hashed files copied from public/ that belong in the shell. */
function isPublicShellFile(path: string): boolean {
  return path === 'theme-init.js' || path === 'manifest.webmanifest' || path.startsWith('icons/');
}

/** Every file under `dir`, relative to it, with forward slashes. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(dir, path) : [path];
  });
}

/** Entry chunks of every page plus everything they load before running: static imports, CSS, fonts. */
function eagerAssets(manifest: Manifest): string[] {
  const files = new Set<string>();
  const visit = (key: string): void => {
    const chunk = manifest[key];
    if (!chunk || files.has(chunk.file)) return;
    files.add(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) files.add(file);
    for (const imported of chunk.imports ?? []) visit(imported);
  };
  for (const [key, chunk] of Object.entries(manifest)) if (chunk.isEntry) visit(key);
  return [...files].sort();
}

export function serviceWorker(): Plugin {
  let root = '';
  let outDir = '';
  let failed = false;

  return {
    name: 'ortoolbox:service-worker',
    apply: 'build',

    configResolved(config) {
      root = config.root;
      outDir = join(config.root, config.build.outDir);
    },

    buildEnd(error) {
      failed = error !== undefined;
    },

    async closeBundle() {
      if (failed) return;

      // Read Vite's manifest, then remove it: it is a build artefact, not part of the site.
      const manifestDir = join(outDir, '.vite');
      const manifest = JSON.parse(
        readFileSync(join(manifestDir, 'manifest.json'), 'utf8'),
      ) as Manifest;
      rmSync(manifestDir, { recursive: true });

      const sha256 = (path: string): string =>
        createHash('sha256')
          .update(readFileSync(join(outDir, path)))
          .digest('hex');

      const pages: ShellPage[] = listFiles(outDir)
        .filter((path) => path.endsWith('.html') || isPublicShellFile(path))
        .sort()
        .map((path) => ({ path, sha256: sha256(path) }));
      const assets = eagerAssets(manifest);

      const version = createHash('sha256')
        .update(JSON.stringify(pages))
        .update(JSON.stringify(assets))
        .digest('hex')
        .slice(0, 16);

      // A nested, self-contained build: one classic script, no code splitting.
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: {
          __SW_VERSION__: JSON.stringify(version),
          __SHELL_PAGES__: JSON.stringify(pages),
          __SHELL_ASSETS__: JSON.stringify(assets),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          lib: {
            entry: join(root, 'src/sw/sw.ts'),
            formats: ['iife'],
            name: 'ortoolboxServiceWorker',
            fileName: () => 'sw.js',
          },
        },
      });

      this.info(
        `sw.js: version ${version}; shell = ${pages.length} pages and public files, ${assets.length} assets`,
      );
    },
  };
}
