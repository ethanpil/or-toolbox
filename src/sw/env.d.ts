/**
 * Compile-time constants injected into the worker by
 * vite-plugins/service-worker.ts after the main build has finished.
 */

/** Hash of the offline shell. Names the pages cache; changes with every deploy. */
declare const __SW_VERSION__: string;

/** HTML pages and un-hashed public files, relative to the scope, with the SHA-256 of their bytes. */
declare const __SHELL_PAGES__: { path: string; sha256: string }[];

/** Content-hashed files every page loads eagerly (entry chunks, their imports, CSS, fonts). */
declare const __SHELL_ASSETS__: string[];
