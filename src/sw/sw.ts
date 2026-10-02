/**
 * The site's single service worker. It does two jobs:
 *
 * 1. Cross-origin isolation. GitHub Pages cannot send response headers, so
 *    this worker adds COOP/COEP/CORP to every same-origin response it serves.
 *    That makes pages `crossOriginIsolated`, which unlocks SharedArrayBuffer
 *    and therefore multi-threaded ffmpeg.wasm. (Technique from
 *    https://github.com/gzuidhof/coi-serviceworker.)
 *
 * 2. Offline shell. The built HTML/JS/CSS/fonts are precached at install and
 *    served cache-first. The large ffmpeg cores are cached the first time
 *    they are requested, never up front.
 *
 * Rules that must hold:
 * - Never call `respondWith` for a cross-origin request. OpenRouter calls go
 *   straight from the page to the network (and Playwright's request mocking
 *   keeps working).
 * - Never force a page to reload. A new worker takes over quietly; pages
 *   already open keep running and the next page load gets the new shell.
 *
 * Built by vite-plugins/service-worker.ts into an un-hashed `sw.js` at the
 * site base. Registered by src/core/sw-register.ts.
 */
import type { CoepMode, WorkerRequest, WorkerStatus } from './protocol';

declare const self: ServiceWorkerGlobalScope;

/** The site base as an absolute URL with trailing slash, e.g. https://host/or-toolbox/. */
const SCOPE = self.registration.scope;

/** All cache names start with this, because every site on the same host shares one CacheStorage. */
const CACHE_PREFIX = 'ortoolbox-';
const PRECACHE_PREFIX = `${CACHE_PREFIX}precache-`;
/** The offline shell of this build. */
const PRECACHE = PRECACHE_PREFIX + __SW_VERSION__;
/** Large vendor files (ffmpeg cores), filled on first use. Their URLs contain the package version. */
const VENDOR_CACHE = `${CACHE_PREFIX}vendor-${__VENDOR_VERSION__}`;
/** Small worker state that must survive the worker being stopped and restarted. */
const META_CACHE = `${CACHE_PREFIX}meta`;

const VENDOR_URL = `${SCOPE}vendor/`;
const HOME_URL = `${SCOPE}index.html`;
const COEP_MODE_URL = `${SCOPE}__coep-mode`;

// ---------------------------------------------------------------------------
// Install: download the offline shell.
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precacheAll();
      // Take over as soon as installed instead of waiting for every tab to
      // close. Safe because activation keeps the previous build's files
      // around for pages that are still open (see `deleteOldCaches`).
      await self.skipWaiting();
    })(),
  );
});

/** Fills the precache, a few files at a time. Any failure fails the install; the browser retries later. */
async function precacheAll(): Promise<void> {
  const cache = await caches.open(PRECACHE);
  const queue = [...__PRECACHE_URLS__];
  const worker = async (): Promise<void> => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      await precacheOne(cache, path);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

async function precacheOne(cache: Cache, path: string): Promise<void> {
  const url = SCOPE + path;
  // Files under assets/ have a content hash in their name, so a copy from the
  // previous build's cache or from the HTTP cache is byte-identical.
  const immutable = path.startsWith('assets/');
  if (immutable) {
    const existing = await caches.match(url);
    if (existing) return cache.put(url, existing);
  }
  // Everything else (HTML, icons, manifest) keeps its name between builds and
  // must be revalidated with the server.
  const response = await fetch(url, { cache: immutable ? 'default' : 'no-cache' });
  if (!response.ok) throw new Error(`Precache failed for ${path}: HTTP ${response.status}`);
  return cache.put(url, response);
}

// ---------------------------------------------------------------------------
// Activate: drop caches of older builds and take control of open pages.
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await deleteOldCaches();
      // Control pages that are already open. On a first visit this is what
      // lets the page reload once into an isolated document.
      await self.clients.claim();
    })(),
  );
});

/**
 * Keeps this build's caches plus the precache of the build before it. A page
 * that was opened before the update still loads its lazy chunks from that
 * older precache (the host has already replaced those files).
 */
async function deleteOldCaches(): Promise<void> {
  const names = await caches.keys(); // in creation order
  const previous = names
    .filter((name) => name.startsWith(PRECACHE_PREFIX) && name !== PRECACHE)
    .at(-1);
  const keep = new Set([PRECACHE, VENDOR_CACHE, META_CACHE, previous]);
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX) && !keep.has(name))
      .map((name) => caches.delete(name)),
  );
}

// ---------------------------------------------------------------------------
// Fetch: serve same-origin GETs, with the isolation headers added.
// ---------------------------------------------------------------------------

/**
 * Ids of the pages whose document this worker served (with isolation
 * headers). Lets a page that is not isolated find out whether a reload could
 * help. In memory only: a restarted worker answers "not served", and the page
 * then simply reloads once.
 */
const servedDocuments = new Set<string>();

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  // Cross-origin (OpenRouter, provider CDNs) and anything outside our base
  // path: not ours, let the browser handle it natively.
  if (!request.url.startsWith(SCOPE)) return;
  // Chromium DevTools issues such requests; fetch() would reject them.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  if (request.mode === 'navigate' && event.resultingClientId) {
    if (servedDocuments.size > 200) servedDocuments.clear();
    servedDocuments.add(event.resultingClientId);
  }

  event.respondWith(
    findResponse(request, (work) => {
      event.waitUntil(work);
    }).then(isolate),
  );
});

/**
 * Cache first, then network.
 * @param keepAlive keeps the worker running for background work (cache writes).
 */
async function findResponse(
  request: Request,
  keepAlive: (work: Promise<unknown>) => void,
): Promise<Response> {
  const url = cacheKey(request.url);
  const navigation = request.mode === 'navigate';
  const precache = await caches.open(PRECACHE);

  // 1. The offline shell of this build.
  const precached = await precache.match(url);
  if (precached) return precached;

  // 2. Any other cache: vendor files, and hashed assets of the previous build
  //    for pages opened before an update. Not for documents, which must
  //    always come from the current build.
  if (!navigation) {
    const cached = await caches.match(url);
    if (cached) return cached;
  }

  // 3. The network.
  try {
    const response = await fetch(request);
    if (response.status === 200 && url.startsWith(VENDOR_URL)) {
      const copy = response.clone();
      keepAlive(
        caches
          .open(VENDOR_CACHE)
          .then((cache) => cache.put(url, copy))
          // Out of quota: the file is simply downloaded again next time.
          .catch(() => undefined),
      );
    }
    return response;
  } catch (error) {
    // 4. Offline, and the page is not in the shell under this exact URL:
    //    try the same path as a directory, then fall back to Home.
    if (navigation) {
      const fallback =
        (await precache.match(`${url}/index.html`)) ?? (await precache.match(HOME_URL));
      if (fallback) return fallback;
    }
    throw error;
  }
}

/** The URL a request is cached under: no query, no fragment, directories as their index.html. */
function cacheKey(requestUrl: string): string {
  const url = new URL(requestUrl);
  return url.origin + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : '');
}

/** Statuses for which the Response constructor refuses a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Returns the response with the cross-origin isolation headers added. */
async function isolate(response: Response): Promise<Response> {
  // Status 0 is an opaque response, e.g. the redirect a navigation receives
  // when the host adds a trailing slash. It cannot be copied; pass it through.
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', await coepMode());
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------------------
// COEP mode. Persisted, because the worker is stopped whenever it is idle.
// ---------------------------------------------------------------------------

let cachedCoepMode: Promise<CoepMode> | undefined;

function coepMode(): Promise<CoepMode> {
  cachedCoepMode ??= (async (): Promise<CoepMode> => {
    const stored = await (await caches.open(META_CACHE)).match(COEP_MODE_URL);
    return stored && (await stored.text()) === 'require-corp' ? 'require-corp' : 'credentialless';
  })();
  return cachedCoepMode;
}

async function setCoepMode(mode: CoepMode): Promise<void> {
  await (await caches.open(META_CACHE)).put(COEP_MODE_URL, new Response(mode));
  cachedCoepMode = Promise.resolve(mode);
}

// ---------------------------------------------------------------------------
// Messages from pages. See protocol.ts.
// ---------------------------------------------------------------------------

self.addEventListener('message', (event) => {
  const request = event.data as WorkerRequest | undefined;
  const port = event.ports[0];
  if (!request || !port) return;

  event.waitUntil(
    (async () => {
      if (
        request.type === 'SET_COEP_MODE' &&
        (request.mode === 'credentialless' || request.mode === 'require-corp')
      ) {
        await setCoepMode(request.mode);
      }
      const status: WorkerStatus = {
        version: __SW_VERSION__,
        coepMode: await coepMode(),
        precached: __PRECACHE_URLS__.length,
        servedDocument: event.source instanceof Client && servedDocuments.has(event.source.id),
      };
      port.postMessage(status);
    })(),
  );
});
