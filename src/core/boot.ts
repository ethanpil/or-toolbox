/**
 * Runs once at the start of every page, before the page's own code.
 *
 * Everything that must happen on all pages belongs here (Stage 1 adds storage
 * migrations and the cross-tab bus). Keep it small: it is on the critical
 * path of every page load.
 */
import { registerServiceWorker } from './sw-register';

export function boot(): void {
  registerServiceWorker();
}
