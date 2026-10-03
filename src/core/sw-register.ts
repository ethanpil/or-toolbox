/**
 * Registers the service worker (src/sw/sw.ts), and gets pages that need
 * threads cross-origin isolated.
 *
 * The worker adds the COOP/COEP headers that make `crossOriginIsolated` true,
 * but only to documents it serves itself. On a first visit (or after a forced
 * reload) the document came straight from the network, so:
 *
 * - Pages that need isolation (multi-threaded ffmpeg: Diagnostics and Video
 *   studio) reload once as soon as the worker is active. This happens at page
 *   start, before the user has done anything, and at most once per tab
 *   session (sessionStorage guard), so it can never loop.
 * - Every other page only registers the worker. It must never reload: the
 *   OAuth callback, for one, carries a single-use code. The next page the
 *   user opens is served by the worker and isolated anyway.
 *
 * If isolation is still unavailable, ffmpeg uses its single-threaded core.
 * The app must work without any of this: no service worker support, private
 * browsing, registration failure and the dev server (which isolates pages
 * with real headers instead) are all normal.
 */
import { url } from './paths';
import { SS_KEYS } from './storage/local';

/** sessionStorage key set just before the isolation reload. */
const RELOAD_GUARD_KEY = SS_KEYS.isolationReload;

export interface RegisterOptions {
  /** Reload once, at page start, if the page is not yet cross-origin isolated. */
  isolation?: 'required';
}

/**
 * Call once at page start. Never throws and never blocks; does nothing in
 * the dev server or where service workers are unavailable.
 */
export function registerServiceWorker(options: RegisterOptions = {}): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  const reloadForIsolation = options.isolation === 'required' && claimReload();

  navigator.serviceWorker
    .register(url('sw.js'), { scope: url() })
    // Typed as possibly undefined on purpose: Playwright's `serviceWorkers:
    // 'block'` replaces register() with a stub that resolves to nothing.
    .then(async (registration: ServiceWorkerRegistration | undefined) => {
      if (!registration || !reloadForIsolation) return;
      // Once a worker is active, a reload goes through it and comes back isolated.
      await navigator.serviceWorker.ready;
      window.location.reload();
    })
    .catch(() => {
      // Registration refused (private browsing, storage disabled, offline
      // first visit, ...): the app runs without the worker.
    });
}

/**
 * Decides whether this page load may reload for isolation, and if so records
 * that it did. Returns false when the page is already isolated, cannot be,
 * already reloaded once in this tab, or sessionStorage is unusable (without a
 * working guard a reload could repeat forever).
 */
function claimReload(): boolean {
  try {
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
      return false;
    }
    // No isolation concept (old browser) or a framed page: a reload cannot help.
    if (!('crossOriginIsolated' in window) || window.top !== window.self) return false;
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return false;
    sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    return sessionStorage.getItem(RELOAD_GUARD_KEY) === '1';
  } catch {
    return false;
  }
}

export interface ServiceWorkerReport {
  /**
   * - `unsupported`: the browser (or this browsing mode) has no service workers.
   * - `not-registered`: none registered for this site (always the case in the dev server).
   * - `installing` / `waiting` / `active`: lifecycle of the registered worker.
   */
  state: 'unsupported' | 'not-registered' | 'installing' | 'waiting' | 'active';
  /** True if a worker controls this page, i.e. its requests (and headers) go through the worker. */
  controlling: boolean;
}

/** Describes the service worker as this page sees it. For the diagnostics page. */
export async function getServiceWorkerReport(): Promise<ServiceWorkerReport> {
  if (!('serviceWorker' in navigator)) return { state: 'unsupported', controlling: false };
  const registration = await navigator.serviceWorker.getRegistration(url()).catch(() => undefined);
  return {
    state: registration?.active
      ? 'active'
      : registration?.waiting
        ? 'waiting'
        : registration?.installing
          ? 'installing'
          : 'not-registered',
    controlling: navigator.serviceWorker.controller !== null,
  };
}
