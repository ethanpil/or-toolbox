/**
 * Compile-time constant injected into the worker by
 * vite-plugins/service-worker.ts after the main build has finished.
 */
import type { SwManifest } from './worker';

declare global {
  /** What this build is made of, with the SHA-256 of every file (see SwManifest in worker.ts). */
  const __SW_MANIFEST__: SwManifest;
}
