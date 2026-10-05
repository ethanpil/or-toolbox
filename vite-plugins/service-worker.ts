import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Manifest, type Plugin } from 'vite';
import type { SwManifest } from '../src/sw/worker.ts';
import { documentHeaderPolicy, workerPolicy } from './csp.ts';

/**
 * Builds the single service worker (src/sw/sw.ts) into an un-hashed `sw.js`
 * at the root of the output folder, after the main build has written
 * everything else, and gives it the build's manifest (`__SW_MANIFEST__`):
 *
 * - `pages`: the HTML pages and the un-hashed public files (theme-init.js,
 *   web manifest, icons), each with the SHA-256 of its bytes. All installed.
 * - `assets`: every file under assets/ and vendor/ with its SHA-256. The
 *   worker serves nothing from its caches that is not in this list with
 *   these exact bytes (CacheStorage is shared with every other site on the
 *   host, so its contents are untrusted).
 * - `precache`: the assets installed up front: each page's entry chunk with
 *   its static-import closure, CSS and fonts (from Vite's build manifest),
 *   plus every lazy JS/CSS chunk under assets/ up to PRECACHE_MAX_BYTES. So
 *   a tab whose pages come from the cache after a deploy can still lazy-load
 *   its chunks, which the host no longer has, and the tools work offline.
 *   The rest (pdf.js's 1.2 MB worker, its wasm, fonts and CMaps, which only
 *   some PDFs need; the ffmpeg cores under vendor/) is cached the first time
 *   it is requested.
 * - `version`: a hash over all of the above. Any change to the site changes
 *   sw.js, which is how browsers notice an update.
 * - `csp`: the Content-Security-Policy headers from csp.ts.
 *
 * Production builds only: the dev server has no service worker.
 */

/** Lazy JS/CSS chunks under assets/ at most this large are installed up front (about 2 MB in all). */
export const PRECACHE_MAX_BYTES = 512 * 1024;

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
export function eagerAssets(manifest: Manifest): string[] {
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

/** Builds the worker's manifest from the files in `outDir` and Vite's build manifest. */
export function swManifest(outDir: string, viteManifest: Manifest): SwManifest {
  const sha256 = (path: string): string =>
    createHash('sha256')
      .update(readFileSync(join(outDir, path)))
      .digest('hex');
  const files = listFiles(outDir).sort();

  const pages = Object.fromEntries(
    files
      .filter((path) => path.endsWith('.html') || isPublicShellFile(path))
      .map((path) => [path, sha256(path)]),
  );
  const assetPaths = files.filter(
    (path) => path.startsWith('assets/') || path.startsWith('vendor/'),
  );
  const assets = Object.fromEntries(assetPaths.map((path) => [path, sha256(path)]));
  const eager = new Set(eagerAssets(viteManifest));
  const precache = assetPaths.filter(
    (path) =>
      eager.has(path) ||
      (path.startsWith('assets/') &&
        /\.(m?js|css)$/.test(path) &&
        statSync(join(outDir, path)).size <= PRECACHE_MAX_BYTES),
  );
  const csp = { document: documentHeaderPolicy(), worker: workerPolicy() };

  const version = createHash('sha256')
    .update(JSON.stringify({ pages, assets, precache, csp }))
    .digest('hex')
    .slice(0, 16);
  return { version, pages, assets, precache, csp };
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
      const viteManifest = JSON.parse(
        readFileSync(join(manifestDir, 'manifest.json'), 'utf8'),
      ) as Manifest;
      rmSync(manifestDir, { recursive: true });

      const manifest = swManifest(outDir, viteManifest);

      // A nested, self-contained build: one classic script, no code splitting.
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: { __SW_MANIFEST__: JSON.stringify(manifest) },
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
        `sw.js: version ${manifest.version}; ${Object.keys(manifest.pages).length} pages and public files, ` +
          `${Object.keys(manifest.assets).length} assets (${manifest.precache.length} installed up front)`,
      );
    },
  };
}
