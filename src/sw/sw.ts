/**
 * The site's single service worker. It does three jobs:
 *
 * 1. Cross-origin isolation. GitHub Pages cannot send response headers, so
 *    this worker adds COOP/COEP/CORP to every same-origin response it serves.
 *    That makes pages `crossOriginIsolated`, which unlocks SharedArrayBuffer
 *    and therefore multi-threaded ffmpeg.wasm. COEP is always `require-corp`:
 *    nothing is hot-linked from other origins, so nothing needs
 *    `credentialless`. (Technique from https://github.com/gzuidhof/coi-serviceworker.)
 *
 * 2. Content-Security-Policy headers (from vite-plugins/csp.ts): on documents,
 *    with `frame-ancestors 'none'`, and on worker scripts, which a page's meta
 *    policy does not reach.
 *
 * 3. Offline shell, verified. Two caches:
 *    - `ortoolbox-pages-<version>`: the HTML pages and un-hashed public files
 *      of one build.
 *    - `ortoolbox-assets`: files under assets/ and vendor/. The pages' eager
 *      closure and the small lazy chunks are added at install; the ffmpeg
 *      cores and the large pdf.js files the first time they are requested.
 *      Shared between builds, so unchanged files are not downloaded again;
 *      entries the current build does not list are deleted at activation.
 *    Every entry is checked against the SHA-256 recorded in this script at
 *    install, at every fill and every time it is served (see worker.ts: other
 *    sites on the host can write these caches).
 *
 * Rules that must hold:
 * - Never call `respondWith` for a cross-origin request. OpenRouter calls go
 *   straight from the page to the network.
 * - A broken cache must never break the site: every Cache API call in the
 *   fetch path falls back to the network.
 * - Never force a page to reload. A new worker takes over quietly; the next
 *   page load gets the new shell. A tab still running an older build gets a
 *   404 for a lazy chunk the host no longer has, and offers a reload
 *   (src/core/stale-build.ts).
 *
 * Built by vite-plugins/service-worker.ts into an un-hashed `sw.js` at the
 * site base. Registered by src/core/sw-register.ts.
 */
import { createWorker } from './worker';

declare const self: ServiceWorkerGlobalScope;

const worker = createWorker({
  scope: self.registration.scope,
  caches,
  fetch: (input, init) => fetch(input, init),
  manifest: __SW_MANIFEST__,
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await worker.install();
      // Take over as soon as installed instead of waiting for every tab to close.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await worker.activate();
      // Control pages that are already open. On a first visit this is what
      // lets a page that needs isolation reload once into an isolated document.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  // Cross-origin (OpenRouter) and anything outside our base path: not ours,
  // let the browser handle it natively.
  if (!request.url.startsWith(self.registration.scope)) return;
  // Chromium DevTools issues such requests; fetch() would reject them.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    worker
      .respond(request, (work) => {
        event.waitUntil(work);
      })
      .then((response) => worker.isolate(request, response)),
  );
});
