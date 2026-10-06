import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

/**
 * Unit tests: `*.test.ts` next to the code under src/ (jsdom), plus the lint
 * rule tests in tests/lint/ and the build plugins' tests in vite-plugins/
 * (Node). Everything else (base, defines, plugins)
 * comes from vite.config.ts.
 *
 * jsdom rather than happy-dom because DOMPurify (src/ui/markdown.ts) is only
 * considered safe on jsdom, and the sanitiser tests must mean something.
 *
 * IndexedDB is not part of jsdom. Tests that need it start with
 * `import 'fake-indexeddb/auto';`.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // Vitest serves modules from '/', so give url() the site's real base.
      env: { BASE_URL: viteConfig.base ?? '/' },
      include: ['src/**/*.test.ts', 'tests/lint/**/*.test.ts', 'vite-plugins/**/*.test.ts'],
      // Lets Bootstrap's late transition timers land before each file's jsdom is torn down.
      setupFiles: ['src/vitest-setup.ts'],
    },
  }),
);
