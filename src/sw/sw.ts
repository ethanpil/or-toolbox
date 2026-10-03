/**
 * The site's single service worker. It does two jobs:
 *
 * 1. Cross-origin isolation. GitHub Pages cannot send response headers, so
 *    this worker adds COOP/COEP/CORP to every same-origin response it serves.
 *    That makes pages `crossOriginIsolated`, which unlocks SharedArrayBuffer
 *    and therefore multi-threaded ffmpeg.wasm. COEP is always `require-corp`:
 *    nothing is hot-linked from other origins, so nothing needs
 *    `credentialless`. (Technique from https://github.com/gzuidhof/coi-serviceworker.)
 *
 * 2. Offline shell. Two caches:
 *    - `ortoolbox-pages-<version>`: the HTML pages and un-hashed public files
 *      of one build, verified byte-for-byte at install.
 *    - `ortoolbox-assets`: content-hashed or versioned files (assets/,
 *      vendor/) of every build, shared. The shell's entry chunks are added at
 *      install; lazy chunks and the ffmpeg cores the first time they are
 *      requested. Entries unused for 60 days are pruned. Because old builds'
 *      chunks stay here, a tab opened before a deploy can still lazy-load the
 *      chunks it has fetched before.
 *
 * Rules that must hold:
 * - Never call `respondWith` for a cross-origin request. OpenRouter calls go
 *   straight from the page to the network.
 * - A broken cache must never break the site: every Cache API call in the
 *   fetch path falls back to the network.
 * - Never force a page to reload. A new worker takes over quietly; the next
 *   page load gets the new shell.
 *
 * Built by vite-plugins/service-worker.ts into an un-hashed `sw.js` at the
 * site base. Registered by src/core/sw-register.ts.
 */

declare const self: ServiceWorkerGlobalScope;

/** The site base as an absolute URL with trailing slash, e.g. https://host/or-toolbox/. */
const SCOPE = self.registration.scope;

/** All cache names start with this, because every site on the same host shares one CacheStorage. */
const CACHE_PREFIX = 'ortoolbox-';
const PAGES_PREFIX = `${CACHE_PREFIX}pages-`;
const PAGES = PAGES_PREFIX + __SW_VERSION__;
const ASSETS = `${CACHE_PREFIX}assets`;

/** Entry in a pages cache recording when its install finished; absent while incomplete. */
const COMPLETE_URL = `${SCOPE}__ortoolbox-install-complete`;
const HOME_URL = `${SCOPE}index.html`;

/** Header stamped on entries of the assets cache: when the file was last served. */
const USED_AT = 'x-ortoolbox-used-at';
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_UNUSED_AFTER_MS = 60 * DAY_MS;

/** Must match ISOLATION_HEADERS in vite-plugins/site.ts (the dev server's copy). */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Runs `work`, turning any failure into `undefined`. For cache calls that must not break a response. */
async function safely<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Install: download and verify the offline shell.
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

async function install(): Promise<void> {
  const pages = await caches.open(PAGES);
  try {
    await eachLimited(__SHELL_PAGES__, (page) => cachePage(pages, page));
    const assets = await caches.open(ASSETS);
    await eachLimited(__SHELL_ASSETS__, (path) => cacheAsset(assets, path));
    await pages.put(COMPLETE_URL, new Response(String(Date.now())));
  } catch (error) {
    // Leave no half-filled cache behind, but never delete a complete one
    // (a reinstall of the same build reuses it).
    if (!(await safely(() => pages.match(COMPLETE_URL)))) {
      await safely(() => caches.delete(PAGES));
    }
    throw error; // fails the install; the browser tries again later
  }
  // Take over as soon as installed instead of waiting for every tab to
  // close. Open pages keep working: their chunks stay in the assets cache.
  await self.skipWaiting();
}

/**
 * Caches one page or public file after checking its bytes against the hash
 * recorded at build time. A mismatch means a stale copy (CDN edge, HTTP
 * cache): retry once bypassing caches, then give up.
 */
async function cachePage(cache: Cache, { path, sha256 }: { path: string; sha256: string }) {
  const url = SCOPE + path;
  for (const attempt of [url, `${url}?sw-version=${__SW_VERSION__}`]) {
    const response = await fetch(attempt, { cache: attempt === url ? 'no-cache' : 'reload' });
    if (!response.ok) throw new Error(`Install: ${path} answered HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if ((await sha256Hex(bytes)) === sha256) {
      const contentType = response.headers.get('content-type');
      await cache.put(
        url,
        new Response(bytes, contentType ? { headers: { 'content-type': contentType } } : {}),
      );
      return;
    }
  }
  throw new Error(
    `Install: ${path} does not match this build (the host still serves an older copy)`,
  );
}

/** Caches one content-hashed file unless any build already cached it (same name, same bytes). */
async function cacheAsset(cache: Cache, path: string): Promise<void> {
  const url = SCOPE + path;
  if (await cache.match(url)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Install: ${path} answered HTTP ${response.status}`);
  await cache.put(url, stamped(response));
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Runs `task` over `items`, a few at a time. */
async function eachLimited<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async (): Promise<void> => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ---------------------------------------------------------------------------
// Activate: drop older builds' pages, prune unused assets, take control.
// ---------------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await safely(deleteOldCaches);
      await safely(pruneAssets);
      // Control pages that are already open. On a first visit this is what
      // lets a page that needs isolation reload once into an isolated document.
      await self.clients.claim();
    })(),
  );
});

/** When a pages cache finished installing, or null if it never did. */
async function completedAt(name: string): Promise<number | null> {
  const marker = await (await caches.open(name)).match(COMPLETE_URL);
  return marker ? Number(await marker.text()) : null;
}

async function deleteOldCaches(): Promise<void> {
  const mine = (await completedAt(PAGES)) ?? Date.now();
  for (const name of await caches.keys()) {
    if (!name.startsWith(CACHE_PREFIX) || name === PAGES || name === ASSETS) continue;
    if (name.startsWith(PAGES_PREFIX)) {
      // Only complete caches of builds installed before this one. An
      // incomplete cache may belong to a newer worker installing right now.
      const finished = await completedAt(name);
      if (finished !== null && finished < mine) await caches.delete(name);
    } else {
      await caches.delete(name); // a layout this worker does not use
    }
  }
}

/** Deletes asset entries not used for a long time, except those of the current shell. */
async function pruneAssets(): Promise<void> {
  const cache = await caches.open(ASSETS);
  const shell = new Set(__SHELL_ASSETS__.map((path) => SCOPE + path));
  const cutoff = Date.now() - PRUNE_UNUSED_AFTER_MS;
  for (const request of await cache.keys()) {
    if (shell.has(request.url)) continue;
    const usedAt = Number((await cache.match(request))?.headers.get(USED_AT));
    if (!(usedAt > cutoff)) await cache.delete(request);
  }
}

// ---------------------------------------------------------------------------
// Fetch: serve same-origin GETs, with the isolation headers added.
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;
  // Cross-origin (OpenRouter) and anything outside our base path: not ours,
  // let the browser handle it natively.
  if (!request.url.startsWith(SCOPE)) return;
  // Chromium DevTools issues such requests; fetch() would reject them.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(
    respond(request, (work) => {
      event.waitUntil(work);
    }).then(isolate),
  );
});

/**
 * @param keepAlive keeps the worker running for background cache writes.
 */
async function respond(
  request: Request,
  keepAlive: (work: Promise<unknown>) => void,
): Promise<Response> {
  // Media seeking sends Range requests, which a cached full response cannot answer.
  if (request.headers.has('range')) return fetch(request);

  const url = cacheKey(request.url);
  if (url.startsWith(`${SCOPE}assets/`) || url.startsWith(`${SCOPE}vendor/`)) {
    return fromAssets(request, url, keepAlive);
  }

  const cached = await safely(async () => (await caches.open(PAGES)).match(url));
  if (cached) return cached;
  try {
    return await fetch(request);
  } catch (error) {
    // Offline, and the page is not in the shell under this exact URL: try the
    // same path as a directory, then fall back to Home.
    if (request.mode === 'navigate') {
      const fallback = await safely(async () => {
        const pages = await caches.open(PAGES);
        return (await pages.match(`${url}/index.html`)) ?? (await pages.match(HOME_URL));
      });
      if (fallback) return fallback;
    }
    throw error;
  }
}

/** Cache first; on a miss, fetch and keep a copy. These URLs never change content. */
async function fromAssets(
  request: Request,
  url: string,
  keepAlive: (work: Promise<unknown>) => void,
): Promise<Response> {
  const cached = await safely(async () => (await caches.open(ASSETS)).match(url));
  if (cached) {
    // Record the use (at most daily) so pruning keeps what is still needed.
    if (!(Number(cached.headers.get(USED_AT)) > Date.now() - DAY_MS)) {
      keepAlive(
        safely(async () => {
          const cache = await caches.open(ASSETS);
          const fresh = await cache.match(url);
          if (fresh) await cache.put(url, stamped(fresh));
        }),
      );
    }
    return cached;
  }

  const response = await fetch(request);
  if (response.status === 200 && response.type === 'basic') {
    const copy = response.clone();
    keepAlive(safely(async () => (await caches.open(ASSETS)).put(url, stamped(copy))));
  }
  return response;
}

/** The URL a request is cached under: no query, no fragment, directories as their index.html. */
function cacheKey(requestUrl: string): string {
  const url = new URL(requestUrl);
  return url.origin + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : '');
}

/** A copy of `response` stamped with the current time (see USED_AT). */
function stamped(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(USED_AT, String(Date.now()));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Statuses for which the Response constructor refuses a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Returns the response with the cross-origin isolation headers added. */
function isolate(response: Response): Response {
  // Status 0 is an opaque response, e.g. the redirect a navigation receives
  // when the host adds a trailing slash. It cannot be copied; pass it through.
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
