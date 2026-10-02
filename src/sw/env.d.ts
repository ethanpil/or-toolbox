/**
 * Compile-time constants injected into the worker by
 * vite-plugins/service-worker.ts after the main build has finished.
 */

/** Hash of the offline shell's contents. Names the precache; changes with every deploy. */
declare const __SW_VERSION__: string;

/** Changes when the self-hosted ffmpeg cores are upgraded. Names the vendor cache. */
declare const __VENDOR_VERSION__: string;

/** The offline shell: build output paths relative to the worker's scope. */
declare const __PRECACHE_URLS__: string[];
