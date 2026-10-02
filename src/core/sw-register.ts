/**
 * Registers the service worker (src/sw/sw.ts) and gets the page
 * cross-origin isolated.
 *
 * The worker adds the COOP/COEP headers that make `crossOriginIsolated` true,
 * but headers only take effect on documents the worker itself served. So:
 *
 * - First visit: the document came from the network without headers. Once
 *   the worker is active the page reloads once and is isolated.
 * - Later visits: the worker serves the document; isolated from the first byte.
 * - Browsers that ignore `COEP: credentialless` stay un-isolated after that
 *   reload. The worker is told to use `require-corp` and the page reloads a
 *   second and last time. The worker remembers the mode, so this happens once
 *   per browser profile.
 *
 * Reloads are counted in sessionStorage and capped, so a browser that can
 * never be isolated cannot end up in a reload loop; it just runs un-isolated
 * (ffmpeg then uses its single-threaded core).
 *
 * The app must work without any of this: no service worker support, private
 * browsing, registration failure and the dev server are all normal.
 */
import type { WorkerRequest, WorkerStatus } from '../sw/protocol';
import { url } from './paths';

/** sessionStorage key: how many automatic reloads this tab has done since it was last isolated. */
const RELOAD_GUARD_KEY = 'ortoolbox:sw-reloads';
/** One reload to get under the worker's control, one to change COEP mode. Never more. */
const MAX_RELOADS = 2;

/**
 * Call once at page start. Never throws and never blocks; does nothing in
 * the dev server or where service workers are unavailable.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // An automatic reload must not throw away something the user has started
  // typing. If they interact before the worker is ready we skip the reload;
  // the next page they open is isolated anyway.
  let userInteracted = false;
  const noteInteraction = (): void => {
    userInteracted = true;
  };
  window.addEventListener('pointerdown', noteInteraction, { once: true, capture: true });
  window.addEventListener('keydown', noteInteraction, { once: true, capture: true });

  navigator.serviceWorker
    .register(url('sw.js'), { scope: url() })
    // Typed as possibly undefined on purpose: Playwright's `serviceWorkers:
    // 'block'` replaces register() with a stub that resolves to nothing.
    .then(async (registration: ServiceWorkerRegistration | undefined) => {
      if (registration) await ensureIsolated(() => userInteracted);
    })
    .catch(() => {
      // Registration refused (private browsing, storage disabled, offline
      // first visit, ...): the app runs without the worker.
    });
}

async function ensureIsolated(userInteracted: () => boolean): Promise<void> {
  if (window.crossOriginIsolated) {
    clearReloadCount();
    return;
  }
  // Browsers without the concept can never be isolated; a framed page cannot
  // become isolated on its own.
  if (!('crossOriginIsolated' in window)) return;
  if (window.top !== window.self) return;

  const reloads = readReloadCount();
  if (reloads === null || reloads >= MAX_RELOADS) return;

  const controller = navigator.serviceWorker.controller;
  const status = controller ? await askWorker(controller, { type: 'GET_STATUS' }) : null;

  if (controller && status?.servedDocument) {
    // The worker served this document with its headers and the browser still
    // did not isolate it: the COEP mode is not supported here.
    if (status.coepMode === 'require-corp') return; // nothing left to try
    const changed = await askWorker(controller, { type: 'SET_COEP_MODE', mode: 'require-corp' });
    if (changed?.coepMode !== 'require-corp') return;
  } else {
    // The document did not come through the worker (first visit, or a forced
    // reload). Wait until a worker is active; the reload then goes through it.
    await navigator.serviceWorker.ready;
  }

  if (userInteracted()) return;
  // Only reload if the count was really stored: without a working guard a
  // reload could repeat forever.
  if (!writeReloadCount(reloads + 1)) return;
  window.location.reload();
}

/** Sends a request to the worker and resolves with its answer, or null if it does not answer in time. */
function askWorker(worker: ServiceWorker, request: WorkerRequest): Promise<WorkerStatus | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      resolve(null);
    }, 3000);
    channel.port1.onmessage = (event: MessageEvent<WorkerStatus>) => {
      window.clearTimeout(timeout);
      resolve(event.data);
    };
    worker.postMessage(request, [channel.port2]);
  });
}

// --- reload guard -----------------------------------------------------------

/** Null means sessionStorage is unusable, in which case we never reload. */
function readReloadCount(): number | null {
  try {
    return Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? '0') || 0;
  } catch {
    return null;
  }
}

function writeReloadCount(count: number): boolean {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(count));
    return sessionStorage.getItem(RELOAD_GUARD_KEY) === String(count);
  } catch {
    return false;
  }
}

function clearReloadCount(): void {
  try {
    sessionStorage.removeItem(RELOAD_GUARD_KEY);
  } catch {
    // Nothing to clear.
  }
}

// --- status for the diagnostics page ---------------------------------------

export interface ServiceWorkerReport {
  /**
   * - `unsupported`: the browser (or this browsing mode) has no service workers.
   * - `not-registered`: none registered for this site (always the case in the dev server).
   * - `installing` / `waiting` / `active`: lifecycle of the registered worker.
   */
  state: 'unsupported' | 'not-registered' | 'installing' | 'waiting' | 'active';
  /** True if a worker controls this page, i.e. its requests go through the worker. */
  controlling: boolean;
  /** The controlling worker's own answer; null if nothing controls the page or it did not answer. */
  worker: WorkerStatus | null;
}

/** Describes the service worker as this page sees it. */
export async function getServiceWorkerReport(): Promise<ServiceWorkerReport> {
  if (!('serviceWorker' in navigator)) {
    return { state: 'unsupported', controlling: false, worker: null };
  }
  let registration: ServiceWorkerRegistration | undefined;
  try {
    registration = await navigator.serviceWorker.getRegistration(url());
  } catch {
    registration = undefined;
  }
  const controller = navigator.serviceWorker.controller;
  return {
    state: registration?.active
      ? 'active'
      : registration?.waiting
        ? 'waiting'
        : registration?.installing
          ? 'installing'
          : 'not-registered',
    controlling: controller !== null,
    worker: controller ? await askWorker(controller, { type: 'GET_STATUS' }) : null,
  };
}
