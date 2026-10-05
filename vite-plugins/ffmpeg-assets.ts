import {
  createReadStream,
  cpSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { ISOLATION_HEADERS } from './site.ts';
import { thirdPartyNotices } from './third-party-notices.ts';

/**
 * Self-hosts the ffmpeg.wasm core files.
 *
 * The cores (about 32 MB each) are too large to bundle and must not be
 * fetched from a CDN, so they are served straight out of node_modules:
 * a middleware in dev, a copy into `dist/vendor/ffmpeg/` in the build.
 *
 * The folder name carries the package version, which makes every URL
 * immutable: the service worker can cache these files forever and an
 * upgrade simply uses new URLs.
 *
 * We ship the ESM builds because @ffmpeg/ffmpeg always starts its worker as a
 * module worker, which loads the core with `import()`.
 *
 * The cores are GPL-2.0-or-later, so the build also writes `licenses.txt` at
 * the site root: the third-party notices (third-party-notices.ts), with the
 * cores' license and source pointer.
 */

/** What the browser code needs to know about one core. Mirrors `__FFMPEG_ASSETS__` in src/env.d.ts. */
export interface FfmpegCoreInfo {
  /** Folder relative to the site base, with trailing slash. */
  dir: string;
  /** Exact size of ffmpeg-core.wasm, for download progress (Content-Length is unreliable under gzip). */
  wasmBytes: number;
}

export interface FfmpegAssetsInfo {
  singleThread: FfmpegCoreInfo;
  multiThread: FfmpegCoreInfo;
}

interface CoreSource {
  /** Absolute folder in node_modules holding the files. */
  from: string;
  /** Folder relative to the site base, with trailing slash. */
  dir: string;
  files: string[];
}

function coreSources(root: string): { singleThread: CoreSource; multiThread: CoreSource } {
  const source = (pkg: string, files: string[]): CoreSource => {
    const pkgDir = join(root, 'node_modules', '@ffmpeg', pkg);
    const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      version: string;
    };
    return { from: join(pkgDir, 'dist', 'esm'), dir: `vendor/ffmpeg/${pkg}-${version}/`, files };
  };
  return {
    singleThread: source('core', ['ffmpeg-core.js', 'ffmpeg-core.wasm']),
    multiThread: source('core-mt', ['ffmpeg-core.js', 'ffmpeg-core.wasm', 'ffmpeg-core.worker.js']),
  };
}

/** Value for the `__FFMPEG_ASSETS__` define. */
export function ffmpegAssetsInfo(root: string): FfmpegAssetsInfo {
  const info = (source: CoreSource): FfmpegCoreInfo => ({
    dir: source.dir,
    wasmBytes: statSync(join(source.from, 'ffmpeg-core.wasm')).size,
  });
  const sources = coreSources(root);
  return { singleThread: info(sources.singleThread), multiThread: info(sources.multiThread) };
}

const CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript',
  wasm: 'application/wasm',
};

export function ffmpegAssets(): Plugin {
  let root = '';
  let base = '/';
  let outDir = '';

  return {
    name: 'ortoolbox:ffmpeg-assets',

    configResolved(config) {
      root = config.root;
      base = config.base;
      outDir = join(config.root, config.build.outDir);
    },

    // Dev: serve the files from node_modules at the URLs the build will use,
    // with the isolation headers every other dev response gets (server.headers
    // does not reach a middleware that answers by itself).
    configureServer(server) {
      const sources = Object.values(coreSources(root));
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        for (const source of sources) {
          const prefix = base + source.dir;
          if (!path.startsWith(prefix)) continue;
          const name = path.slice(prefix.length);
          if (!source.files.includes(name)) break;
          const file = join(source.from, name);
          for (const [header, value] of Object.entries(ISOLATION_HEADERS))
            res.setHeader(header, value);
          res.setHeader('Content-Type', CONTENT_TYPES[name.split('.').pop() ?? ''] ?? '');
          res.setHeader('Content-Length', statSync(file).size);
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },

    // Build: copy the files next to the bundle, with the notices that go with them.
    writeBundle() {
      for (const source of Object.values(coreSources(root))) {
        const to = join(outDir, source.dir);
        mkdirSync(to, { recursive: true });
        for (const name of source.files) cpSync(join(source.from, name), join(to, name));
      }
      writeFileSync(join(outDir, 'licenses.txt'), thirdPartyNotices(root));
    },
  };
}
