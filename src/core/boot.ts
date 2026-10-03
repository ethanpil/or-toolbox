/**
 * Runs once at the start of every page, before the page's own code.
 *
 * Everything that must happen on all pages belongs here. Keep it small: it is
 * on the critical path of every page load. Core services (and with them the
 * settings migrations and the cross-tab bus) are created on first use of
 * `getCore()`.
 */
import { getCore } from './index';
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
  // Retention pruning is cheap and runs at most once a day (history service bookkeeping); keep it off the
  // critical path. Job polling is resumed by the tool page once its handlers are registered.
  const idle = globalThis.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 2000));
  idle(
    () =>
      void getCore()
        .history.prune()
        .catch(() => undefined),
  );
}
