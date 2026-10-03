/**
 * Runs once at the start of every page, before the page's own code.
 *
 * Everything that must happen on all pages belongs here (Stage 1 adds storage
 * migrations and the cross-tab bus). Keep it small: it is on the critical
 * path of every page load.
 */
import { registerServiceWorker } from './sw-register';

export interface BootOptions {
  /**
   * `'required'` for pages that need SharedArrayBuffer (multi-threaded
   * ffmpeg): on a first visit they reload once to become cross-origin
   * isolated. Only Diagnostics and Video studio use it; never set it on a
   * page that holds state in its URL (the OAuth callback).
   */
  isolation?: 'required';
}

export function boot(options: BootOptions = {}): void {
  registerServiceWorker(options);
}
