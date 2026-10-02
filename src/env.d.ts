/// <reference types="vite/client" />

/**
 * Compile-time constants injected by `define` in vite.config.ts (and
 * vitest.config.ts). They are replaced with literals in the bundle.
 */

/** Where the self-hosted ffmpeg cores live. Produced by vite-plugins/ffmpeg-assets.ts. */
declare const __FFMPEG_ASSETS__: {
  singleThread: { dir: string; wasmBytes: number };
  multiThread: { dir: string; wasmBytes: number };
};
