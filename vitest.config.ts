import { defineConfig } from 'vitest/config';
import { ffmpegAssetsInfo } from './vite-plugins/ffmpeg-assets.ts';

/**
 * Unit tests: `*.test.ts` next to the code under src/, in a jsdom window.
 *
 * jsdom rather than happy-dom because DOMPurify (src/ui/markdown.ts) is only
 * considered safe on jsdom, and the sanitiser tests must mean something.
 *
 * IndexedDB is not part of jsdom. Tests that need it start with
 * `import 'fake-indexeddb/auto';`.
 */
export default defineConfig({
  define: {
    __FFMPEG_ASSETS__: JSON.stringify(ffmpegAssetsInfo(import.meta.dirname)),
  },
  test: {
    environment: 'jsdom',
    // Vitest serves modules from '/', so give url() the real sub-path to work with.
    env: { BASE_URL: '/or-toolbox/' },
    include: ['src/**/*.test.ts'],
  },
});
