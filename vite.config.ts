import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import { ffmpegAssets, ffmpegAssetsInfo } from './vite-plugins/ffmpeg-assets.ts';
import { htmlHead } from './vite-plugins/html-head.ts';
import { discoverPages } from './vite-plugins/pages.ts';
import { serviceWorker } from './vite-plugins/service-worker.ts';
import { basePath, DEV_PORT, PREVIEW_PORT } from './vite-plugins/site.ts';

const root = import.meta.dirname;

const ffmpeg = ffmpegAssetsInfo(root);
/** Changes whenever an ffmpeg core package is upgraded; names the worker's vendor cache. */
const vendorVersion = createHash('sha256')
  .update(ffmpeg.singleThread.dir + ffmpeg.multiThread.dir)
  .digest('hex')
  .slice(0, 8);

export default defineConfig({
  base: basePath(),

  // Multi-page app: every index.html found under the project root is an entry,
  // and unknown URLs are a 404 rather than falling back to the home page.
  appType: 'mpa',
  input: discoverPages(root).map((page) => page.file),

  define: {
    // Declared in src/env.d.ts.
    __FFMPEG_ASSETS__: JSON.stringify(ffmpeg),
  },

  plugins: [htmlHead(), ffmpegAssets(), serviceWorker({ vendorVersion })],

  css: {
    preprocessorOptions: {
      scss: {
        // Bootstrap 5.3 still uses Sass features that Dart Sass has deprecated
        // (@import, global built-ins, ...). `quietDeps` hides deprecation
        // warnings that originate inside node_modules only; warnings and
        // errors in our own Sass still surface.
        quietDeps: true,
      },
    },
  },

  build: {
    // Never inline assets as data: URLs. The CSP has `font-src 'self'`, and
    // an inlined font would violate it.
    assetsInlineLimit: 0,
  },

  optimizeDeps: {
    // @ffmpeg/ffmpeg starts its worker with `new URL('./worker.js', import.meta.url)`,
    // which breaks if the dev server pre-bundles the package into .vite/deps.
    exclude: ['@ffmpeg/ffmpeg'],
  },

  server: { port: DEV_PORT, strictPort: true },
  preview: { port: PREVIEW_PORT, strictPort: true },
});
