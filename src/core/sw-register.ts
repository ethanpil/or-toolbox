/**
 * Registers the service worker (src/sw/sw.ts), and gets pages that need
 * threads cross-origin isolated.
 *
 * The worker adds the COOP/COEP headers that make `crossOriginIsolated` true,
 * but only to documents it serves itself. On a first visit (or after a forced
 * reload) the document came straight from the network, so:
 *
 * - Pages that need isolation (multi-threaded ffmpeg: Diagnostics and Video
 *   studio) reload once when the worker is active, but only if the user has
 *   not started using the page yet: no key press, click, input, paste or drop,
 *   and no results or held work in the page. Otherwise the reload is left out
 *   and the next page the user opens is isolated. The reload restores the
 *   page's original address first, so parameters the page already consumed
 *   and removed (`?run=`, `?prompt=`, `?sample=`) apply again. A page opened
 *   by Send to (`?receive=`) never reloads: the hand-over cannot be repeated.
 *   At most once per tab session (sessionStorage guard), so it never loops.
 * - Every other page only registers the worker. It must never reload: the
 *   OAuth callback, for one, carries a single-use code. The next page the
 *   user opens is served by the worker and isolated anyway.
 *
 * If isolation is still unavailable, ffmpeg uses its single-threaded core.
 * The app must work without any of this: no service worker support, private
 * browsing, registration failure and the dev server (which isolates pages
 * with real headers instead) are all normal.
 */
import { getCore } from './index';
import { url } from './paths';
import { installStaleBuildOffer } from './stale-build';
import { SS_KEYS } from './storage/local';

/** sessionStorage key set just before the isolation reload. */
const RELOAD_GUARD_KEY = SS_KEYS.isolationReload;

/** Events that mean the user has started using the page. */
const INTERACTIONS = ['keydown', 'pointerdown', 'input', 'paste', 'drop'] as const;

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
  installStaleBuildOffer();
  if (!('serviceWorker' in navigator)) return;

  const isolation = options.isolation === 'required' ? prepareIsolationReload() : null;

  navigator.serviceWorker
    .register(url('sw.js'), { scope: url() })
    // Typed as possibly undefined on purpose: Playwright's `serviceWorkers:
    // 'block'` replaces register() with a stub that resolves to nothing.
    .then(async (registration: ServiceWorkerRegistration | undefined) => {
      if (!registration || !isolation) return;
      // Once a worker is active, a reload goes through it and comes back isolated.
      await navigator.serviceWorker.ready;
      isolation.reloadIfUnused();
    })
    .catch(() => {
      // Registration refused (private browsing, storage disabled, offline
      // first visit, ...): the app runs without the worker.
    })
    .finally(() => isolation?.stopWatching());
}

/**
 * Returns null when this page load may not reload for isolation: it is
 * already isolated, cannot be (old browser, framed), already reloaded once in
 * this tab, cannot keep the guard (without it a reload could repeat forever),
 * or was opened by Send to. Otherwise starts watching for the user and
 * remembers the address as it is now, before the page consumes its parameters.
 */
function prepareIsolationReload(): { reloadIfUnused(): void; stopWatching(): void } | null {
  try {
    if (window.crossOriginIsolated) {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
      return null;
    }
    if (!('crossOriginIsolated' in window) || window.top !== window.self) return null;
    if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return null;
    if (new URL(window.location.href).searchParams.has('receive')) return null;
  } catch {
    return null;
  }

  const address = window.location.href;
  let used = false;
  const onUse = (): void => {
    used = true;
  };
  for (const type of INTERACTIONS) window.addEventListener(type, onUse, { capture: true });
  const stopWatching = (): void => {
    for (const type of INTERACTIONS) window.removeEventListener(type, onUse, { capture: true });
  };

  return {
    stopWatching,
    reloadIfUnused() {
      stopWatching();
      if (used || holdsWork()) return;
      try {
        sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
        if (sessionStorage.getItem(RELOAD_GUARD_KEY) !== '1') return;
      } catch {
        return;
      }
      window.history.replaceState(window.history.state, '', address);
      window.location.reload();
    },
  };
}

/** True if the page has results not downloaded or work a tool holds. */
function holdsWork(): boolean {
  try {
    const { results } = getCore();
    return results.pending().length > 0 || results.holds().length > 0;
  } catch {
    return true; // cannot tell: do not risk it
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
