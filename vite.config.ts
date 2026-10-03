import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import { ffmpegAssets, ffmpegAssetsInfo } from './vite-plugins/ffmpeg-assets.ts';
import { htmlHead } from './vite-plugins/html-head.ts';
import { discoverPages } from './vite-plugins/pages.ts';
import { serviceWorker } from './vite-plugins/service-worker.ts';
import { basePath, DEV_PORT, ISOLATION_HEADERS, PREVIEW_PORT } from './vite-plugins/site.ts';

const root = import.meta.dirname;

export default defineConfig({
  base: basePath(),

  // Multi-page app: every index.html found under the project root is an entry,
  // and unknown URLs are a 404 rather than falling back to the home page.
  appType: 'mpa',
  input: discoverPages(root).map((page) => page.file),

  define: {
    // Declared in src/env.d.ts.
    __FFMPEG_ASSETS__: JSON.stringify(ffmpegAssetsInfo(root)),
  },

  plugins: [htmlHead(), ffmpegAssets(), serviceWorker()],

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
    // .vite/manifest.json tells the service-worker plugin which chunks each
    // page loads eagerly (the offline shell). The plugin deletes it afterwards.
    manifest: true,
  },

  optimizeDeps: {
    // @ffmpeg/ffmpeg starts its worker with `new URL('./worker.js', import.meta.url)`,
    // which breaks if the dev server pre-bundles the package into .vite/deps.
    exclude: ['@ffmpeg/ffmpeg'],
  },

  // The dev server isolates pages itself (no service worker in dev).
  server: {
    port: DEV_PORT,
    strictPort: true,
    headers: ISOLATION_HEADERS,
    // Git worktrees used for parallel work link node_modules to the main checkout; allow its real path too.
    fs: { allow: [searchForWorkspaceRoot(root), realpathSync(resolve(root, 'node_modules'))] },
  },
  // `vite preview` behaves like GitHub Pages: no special headers (it would
  // otherwise inherit server.headers), so isolation comes from the worker.
  preview: { port: PREVIEW_PORT, strictPort: true, headers: {} },
});
