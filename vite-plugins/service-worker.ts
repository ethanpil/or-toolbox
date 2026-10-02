import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, type Plugin } from 'vite';

/**
 * Builds the single service worker (src/sw/sw.ts) into an un-hashed `sw.js`
 * at the root of the output folder, after the main build has written
 * everything else.
 *
 * The worker needs to know what the build produced, so this plugin lists the
 * output files and hands them to the worker as compile-time constants
 * (declared in src/sw/env.d.ts):
 *
 * - `__PRECACHE_URLS__`  the offline shell: HTML, JS, CSS, fonts, icons.
 * - `__SW_VERSION__`     a hash of those files' contents. Any change to the
 *                        site changes sw.js, which is how browsers notice an
 *                        update, and names the new cache.
 * - `__VENDOR_VERSION__` names the cache for the large vendor files, which
 *                        are cached on first use and never precached.
 *
 * Production builds only: the dev server has no service worker.
 */

/** Not part of the offline shell. */
function isPrecached(file: string): boolean {
  if (file === 'sw.js' || file === '.nojekyll') return false;
  // ffmpeg cores: ~65 MB, fetched only when a tool needs them.
  if (file.startsWith('vendor/')) return false;
  if (file.endsWith('.map')) return false;
  // Every supported browser takes the .woff2; the .woff is a CSS fallback only.
  if (file.endsWith('.woff')) return false;
  return true;
}

/** Every file under `dir`, relative to it, with forward slashes. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? listFiles(dir, path) : [path];
  });
}

export function serviceWorker(options: { vendorVersion: string }): Plugin {
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

      const precache = listFiles(outDir).filter(isPrecached).sort();
      const hash = createHash('sha256');
      for (const file of precache) {
        hash
          .update(file)
          .update('\0')
          .update(readFileSync(join(outDir, file)))
          .update('\0');
      }
      const version = hash.digest('hex').slice(0, 16);

      // A nested, self-contained build: one classic script, no code splitting.
      await build({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        define: {
          __SW_VERSION__: JSON.stringify(version),
          __VENDOR_VERSION__: JSON.stringify(options.vendorVersion),
          __PRECACHE_URLS__: JSON.stringify(precache),
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

      this.info(`sw.js: version ${version}, ${precache.length} files in the offline shell`);
    },
  };
}
