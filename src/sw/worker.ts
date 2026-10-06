/**
 * The service worker's logic, free of `self` so unit tests can drive it with
 * a fake CacheStorage and fetch (worker.test.ts). src/sw/sw.ts wires it to the
 * worker's events.
 *
 * Trust: CacheStorage is shared by every site on the host
 * (`ethanpil.github.io/*`), so any sibling project page can write into these
 * caches. Nothing read from them is trusted: every entry is checked against
 * the SHA-256 the build recorded in this worker's own script (`SwManifest`)
 * on install, on every fill and again every time it is served. A mismatch
 * deletes the entry and the request goes to the network. Files this build
 * does not list (an older build's chunks) are never served from the cache.
 */

export interface SwManifest {
  /** Hash of the whole manifest. Names the pages cache; changes with every deploy. */
  version: string;
  /** HTML pages and un-hashed public files (path relative to the scope -> SHA-256). All installed. */
  pages: Record<string, string>;
  /** Every file under assets/ and vendor/ (path -> SHA-256). */
  assets: Record<string, string>;
  /** The assets installed up front: the pages' eager closure plus the small lazy chunks. */
  precache: string[];
  /** Content-Security-Policy headers (built from vite-plugins/csp.ts). */
  csp: { document: string; worker: string };
}

export interface WorkerEnv {
  /** The site base as an absolute URL with trailing slash, e.g. https://host/or-toolbox/. */
  scope: string;
  caches: CacheStorage;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  manifest: SwManifest;
  now?: () => number;
}

/** All cache names start with this, because every site on the same host shares one CacheStorage. */
export const CACHE_PREFIX = 'ortoolbox-';
export const PAGES_PREFIX = `${CACHE_PREFIX}pages-`;
export const ASSETS = `${CACHE_PREFIX}assets`;

/** Must match ISOLATION_HEADERS in vite-plugins/site.ts (the dev server's copy). */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Statuses for which the Response constructor refuses a body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Runs `work`, turning any failure into `undefined`. For cache calls that must not break a response. */
async function safely<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The URL a request is cached under: no query, no fragment, directories as their index.html. */
export function cacheKey(requestUrl: string): string {
  const url = new URL(requestUrl);
  return url.origin + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : '');
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

/** A cacheable copy of a response with the given body: status and content type only. */
function copyWith(bytes: ArrayBuffer, response: Response): Response {
  const contentType = response.headers.get('content-type');
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: contentType ? { 'content-type': contentType } : {},
  });
}

export function createWorker(env: WorkerEnv) {
  const { scope, caches, manifest } = env;
  const fetch = env.fetch;
  const now = env.now ?? Date.now;
  const PAGES = PAGES_PREFIX + manifest.version;
  /** Entry in a pages cache recording when its install finished; absent while incomplete. */
  const COMPLETE_URL = `${scope}__ortoolbox-install-complete`;
  const HOME_URL = `${scope}index.html`;

  /** The cache and expected hash for a URL this build knows, or null. */
  const lookup = (url: string): { cache: string; sha256: string } | null => {
    if (!url.startsWith(scope)) return null;
    const path = url.slice(scope.length);
    const asset = Object.hasOwn(manifest.assets, path) ? manifest.assets[path] : undefined;
    if (asset !== undefined) return { cache: ASSETS, sha256: asset };
    const page = Object.hasOwn(manifest.pages, path) ? manifest.pages[path] : undefined;
    if (page !== undefined) return { cache: PAGES, sha256: page };
    return null;
  };

  /**
   * The cached entry for `url` if its bytes match `sha256`. A mismatching
   * entry (poisoned, or corrupted) is deleted. Never throws.
   */
  const verifiedMatch = async (
    cacheName: string,
    url: string,
    sha256: string,
  ): Promise<Response | undefined> =>
    safely(async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url);
      if (!cached) return undefined;
      const bytes = await cached.arrayBuffer();
      if ((await sha256Hex(bytes)) === sha256) return copyWith(bytes, cached);
      await cache.delete(url);
      return undefined;
    });

  /**
   * Caches one file after checking its bytes against the build's hash. A
   * mismatch means a stale copy (CDN edge, HTTP cache): retry once bypassing
   * caches, then give up. A matching entry already cached is kept.
   */
  const install1 = async (cacheName: string, path: string, sha256: string): Promise<void> => {
    const url = scope + path;
    if (await verifiedMatch(cacheName, url, sha256)) return;
    const cache = await caches.open(cacheName);
    for (const attempt of [url, `${url}?sw-version=${manifest.version}`]) {
      const response = await fetch(attempt, { cache: attempt === url ? 'no-cache' : 'reload' });
      if (!response.ok) throw new Error(`Install: ${path} answered HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      if ((await sha256Hex(bytes)) === sha256) {
        await cache.put(url, copyWith(bytes, response));
        return;
      }
    }
    throw new Error(
      `Install: ${path} does not match this build (the host still serves an older copy)`,
    );
  };

  /** Downloads and verifies the offline shell. Throws (failing the install) if any file is missing or wrong. */
  const install = async (): Promise<void> => {
    const pages = await caches.open(PAGES);
    try {
      await eachLimited(Object.entries(manifest.pages), ([path, sha256]) =>
        install1(PAGES, path, sha256),
      );
      await eachLimited(manifest.precache, async (path) => {
        const sha256 = manifest.assets[path];
        if (sha256 === undefined) throw new Error(`Install: ${path} has no recorded hash`);
        await install1(ASSETS, path, sha256);
      });
      await pages.put(COMPLETE_URL, new Response(String(now())));
    } catch (error) {
      // Leave no half-filled cache behind, but never delete a complete one
      // (a reinstall of the same build reuses it).
      if (!(await safely(() => pages.match(COMPLETE_URL)))) {
        await safely(() => caches.delete(PAGES));
      }
      throw error; // fails the install; the browser tries again later
    }
  };

  /** When a pages cache finished installing, or null if it never did. */
  const completedAt = async (name: string): Promise<number | null> => {
    const marker = await (await caches.open(name)).match(COMPLETE_URL);
    return marker ? Number(await marker.text()) : null;
  };

  /** Drops older builds' pages caches and caches of layouts this worker does not use. */
  const deleteOldCaches = async (): Promise<void> => {
    const mine = (await completedAt(PAGES)) ?? now();
    for (const name of await caches.keys()) {
      if (!name.startsWith(CACHE_PREFIX) || name === PAGES || name === ASSETS) continue;
      if (name.startsWith(PAGES_PREFIX)) {
        // Only complete caches of builds installed before this one. An
        // incomplete cache may belong to a newer worker installing right now.
        const finished = await completedAt(name);
        if (finished !== null && finished < mine) await caches.delete(name);
      } else {
        await caches.delete(name);
      }
    }
  };

  /**
   * Deletes asset entries this build does not list. They could never be
   * served again (nothing to verify them against), so they only take space.
   * Files that did not change between builds keep their name and hash, so
   * they stay (the 32 MB ffmpeg cores, most vendor chunks).
   */
  const pruneAssets = async (): Promise<void> => {
    const cache = await caches.open(ASSETS);
    for (const request of await cache.keys()) {
      const path = request.url.startsWith(scope) ? request.url.slice(scope.length) : '';
      if (!Object.hasOwn(manifest.assets, path)) await cache.delete(request);
    }
  };

  /** Activation clean-up. Never throws. */
  const activate = async (): Promise<void> => {
    await safely(deleteOldCaches);
    await safely(pruneAssets);
  };

  /**
   * Fetches a file this build lists and, if its bytes match, keeps a copy.
   * The response itself streams to the page; the check runs on a copy.
   */
  const fetchAndFill = async (
    request: Request,
    url: string,
    known: { cache: string; sha256: string },
    keepAlive: (work: Promise<unknown>) => void,
  ): Promise<Response> => {
    const response = await fetch(request);
    // Opaque responses have status 0; the hash check is what decides.
    if (response.status === 200) {
      const copy = response.clone();
      keepAlive(
        safely(async () => {
          const bytes = await copy.arrayBuffer();
          if ((await sha256Hex(bytes)) !== known.sha256) return;
          await (await caches.open(known.cache)).put(url, copyWith(bytes, copy));
        }),
      );
    }
    return response;
  };

  /**
   * Answers a same-origin GET under the scope (headers not yet isolated).
   *
   * @param keepAlive keeps the worker running for background cache writes.
   */
  const respond = async (
    request: Request,
    keepAlive: (work: Promise<unknown>) => void,
  ): Promise<Response> => {
    // Media seeking sends Range requests, which a cached full response cannot answer.
    if (request.headers.has('range')) return fetch(request);

    const url = cacheKey(request.url);
    const known = lookup(url);
    if (known) {
      const cached = await verifiedMatch(known.cache, url, known.sha256);
      if (cached) return cached;
    }
    try {
      return known ? await fetchAndFill(request, url, known, keepAlive) : await fetch(request);
    } catch (error) {
      // Offline, and the page is not in the shell under this exact URL: try the
      // same path as a directory, then fall back to Home.
      if (request.mode === 'navigate') {
        for (const candidate of [`${url}/index.html`, HOME_URL]) {
          const page = lookup(candidate);
          const fallback = page && (await verifiedMatch(page.cache, candidate, page.sha256));
          if (fallback) return fallback;
        }
      }
      throw error;
    }
  };

  /**
   * Returns the response with the cross-origin isolation headers added, and
   * the Content-Security-Policy header on documents and worker scripts.
   */
  const isolate = (request: Request, response: Response): Response => {
    // Status 0 is an opaque response, e.g. the redirect a navigation receives
    // when the host adds a trailing slash. It cannot be copied; pass it through.
    if (response.status === 0) return response;

    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
    if (request.destination === 'worker' || request.destination === 'sharedworker') {
      headers.set('Content-Security-Policy', manifest.csp.worker);
    } else if (/^text\/html\b/i.test(headers.get('content-type') ?? '')) {
      headers.set('Content-Security-Policy', manifest.csp.document);
    }
    return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  return { install, activate, respond, isolate, pagesCache: PAGES };
}
