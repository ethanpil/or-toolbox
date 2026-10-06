/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { ASSETS, cacheKey, createWorker, sha256Hex, type SwManifest } from './worker';

const SCOPE = 'https://host.test/or-toolbox/';

/** An in-memory CacheStorage: enough of the API for the worker. */
class FakeCache {
  readonly entries = new Map<string, { bytes: ArrayBuffer; init: ResponseInit }>();
  private key(request: RequestInfo | URL): string {
    return typeof request === 'string'
      ? request
      : request instanceof URL
        ? request.href
        : request.url;
  }
  match(request: RequestInfo | URL): Promise<Response | undefined> {
    const entry = this.entries.get(this.key(request));
    return Promise.resolve(entry && new Response(entry.bytes.slice(0), entry.init));
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const bytes = await response.arrayBuffer();
    this.entries.set(this.key(request), {
      bytes,
      init: { status: response.status, headers: [...response.headers] },
    });
  }
  delete(request: RequestInfo | URL): Promise<boolean> {
    return Promise.resolve(this.entries.delete(this.key(request)));
  }
  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }
  /** Writes an entry directly, as another site on the host could. */
  poison(url: string, body: string, contentType = 'text/javascript'): void {
    this.entries.set(url, {
      bytes: new TextEncoder().encode(body).buffer,
      init: { status: 200, headers: { 'content-type': contentType } },
    });
  }
  text(url: string): string | undefined {
    const entry = this.entries.get(url);
    return entry && new TextDecoder().decode(entry.bytes);
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();
  open(name: string): Promise<Cache> {
    let cache = this.stores.get(name);
    if (!cache) this.stores.set(name, (cache = new FakeCache()));
    return Promise.resolve(cache as unknown as Cache);
  }
  cache(name: string): FakeCache {
    void this.open(name);
    return this.stores.get(name) as FakeCache;
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
  has(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.has(name));
  }
  match(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

/** The host: path -> body. Records every URL fetched. */
function fakeHost(files: Record<string, string>) {
  const fetched: string[] = [];
  let offline = false;
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    const asked = url.slice(SCOPE.length).split('?')[0] ?? '';
    const path = asked === '' || asked.endsWith('/') ? `${asked}index.html` : asked;
    const body = files[path];
    if (body === undefined) return Promise.resolve(new Response('Not found', { status: 404 }));
    const type = path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript';
    return Promise.resolve(new Response(body, { headers: { 'content-type': type } }));
  };
  return {
    files,
    fetched,
    fetch,
    goOffline: () => {
      offline = true;
    },
  };
}

const sha = (text: string) => sha256Hex(new TextEncoder().encode(text).buffer);

const BUILD = {
  'index.html': '<!doctype html>home',
  'settings/index.html': '<!doctype html>settings',
  'theme-init.js': 'theme()',
  'assets/shell-1.js': 'shell()',
  'assets/lazy-1.js': 'lazy()',
  'vendor/ffmpeg/core-1/ffmpeg-core.wasm': 'wasm-bytes',
};

async function manifestFor(files: Record<string, string>): Promise<SwManifest> {
  const hashes = async (paths: string[]): Promise<Record<string, string>> =>
    Object.fromEntries(
      await Promise.all(
        paths.map(async (p): Promise<[string, string]> => [p, await sha(files[p] ?? '')]),
      ),
    );
  const paths = Object.keys(files);
  const isAsset = (p: string) => p.startsWith('assets/') || p.startsWith('vendor/');
  return {
    version: 'v1',
    pages: await hashes(paths.filter((p) => !isAsset(p))),
    assets: await hashes(paths.filter(isAsset)),
    precache: paths.filter((p) => p.startsWith('assets/')),
    csp: { document: "default-src 'self'; frame-ancestors 'none'", worker: "default-src 'self'" },
  };
}

async function setup(files: Record<string, string> = { ...BUILD }) {
  const host = fakeHost({ ...files });
  const caches = new FakeCacheStorage();
  const manifest = await manifestFor(files);
  const worker = createWorker({
    scope: SCOPE,
    caches,
    fetch: host.fetch,
    manifest,
    now: () => 1000,
  });
  const background: Promise<unknown>[] = [];
  const respond = async (path: string, init?: RequestInit) => {
    const response = await worker.respond(new Request(SCOPE + path, init), (work) =>
      background.push(work),
    );
    await Promise.all(background);
    return response;
  };
  return { host, caches, manifest, worker, respond, pages: caches.cache(worker.pagesCache) };
}

describe('cacheKey', () => {
  it('drops query and fragment and maps directories to their index.html', () => {
    expect(cacheKey(`${SCOPE}history/?tool=ocr#x`)).toBe(`${SCOPE}history/index.html`);
    expect(cacheKey(SCOPE)).toBe(`${SCOPE}index.html`);
    expect(cacheKey(`${SCOPE}assets/a.js?v=1`)).toBe(`${SCOPE}assets/a.js`);
    expect(cacheKey(`${SCOPE}settings`)).toBe(`${SCOPE}settings`);
  });
});

describe('isolate', () => {
  const run = async (
    response: Response,
    destination: RequestDestination = '',
  ): Promise<Response> => {
    const { worker } = await setup();
    return worker.isolate({ destination } as Request, response);
  };

  it('adds the isolation headers to every response', async () => {
    const out = await run(new Response('x', { headers: { 'content-type': 'text/javascript' } }));
    expect(out.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(out.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(out.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(out.headers.get('content-security-policy')).toBeNull();
    expect(await out.text()).toBe('x');
  });

  it('adds the document policy, with frame-ancestors, to HTML', async () => {
    const out = await run(
      new Response('<p>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'document',
    );
    expect(out.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('adds the worker policy to worker scripts', async () => {
    const out = await run(
      new Response('x', { headers: { 'content-type': 'text/javascript' } }),
      'worker',
    );
    expect(out.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('passes opaque responses through and keeps null-body statuses bodiless', async () => {
    const opaque = Response.error();
    expect(await run(opaque)).toBe(opaque);
    const empty = await run(new Response(null, { status: 204 }));
    expect([empty.status, empty.headers.get('cross-origin-embedder-policy')]).toEqual([
      204,
      'require-corp',
    ]);
  });
});

describe('install', () => {
  it('caches every page and the precache list, verified', async () => {
    const { worker, caches, pages } = await setup();
    await worker.install();
    expect([...pages.entries.keys()].sort()).toEqual(
      [
        `${SCOPE}__ortoolbox-install-complete`,
        `${SCOPE}index.html`,
        `${SCOPE}settings/index.html`,
        `${SCOPE}theme-init.js`,
      ].sort(),
    );
    // The skew precache: lazy chunks too, but not the ffmpeg core.
    expect([...caches.cache(ASSETS).entries.keys()].sort()).toEqual([
      `${SCOPE}assets/lazy-1.js`,
      `${SCOPE}assets/shell-1.js`,
    ]);
  });

  it('retries a stale download bypassing caches, then fails without leaving a half cache', async () => {
    const { worker, host, caches } = await setup();
    host.files['settings/index.html'] = 'stale copy';
    await expect(worker.install()).rejects.toThrow(/settings\/index\.html does not match/);
    expect(host.fetched.filter((url) => url.includes('settings/'))).toEqual([
      `${SCOPE}settings/index.html`,
      `${SCOPE}settings/index.html?sw-version=v1`,
    ]);
    expect(await caches.has(worker.pagesCache)).toBe(false);
  });

  it('keeps a verified entry and replaces a poisoned one', async () => {
    const { worker, host, caches } = await setup();
    const assets = caches.cache(ASSETS);
    await assets.put(`${SCOPE}assets/shell-1.js`, new Response('shell()'));
    assets.poison(`${SCOPE}assets/lazy-1.js`, 'steal()');
    await worker.install();
    expect(host.fetched).not.toContain(`${SCOPE}assets/shell-1.js`);
    expect(host.fetched).toContain(`${SCOPE}assets/lazy-1.js`);
    expect(assets.text(`${SCOPE}assets/lazy-1.js`)).toBe('lazy()');
  });
});

describe('respond', () => {
  it('serves a verified entry without the network', async () => {
    const { worker, host, respond } = await setup();
    await worker.install();
    host.fetched.length = 0;
    expect(await (await respond('assets/shell-1.js')).text()).toBe('shell()');
    expect(await (await respond('settings/?x=1')).text()).toBe('<!doctype html>settings');
    expect(host.fetched).toEqual([]);
  });

  it('deletes a poisoned entry at serve time, answers from the network and refills', async () => {
    const { worker, caches, pages, respond } = await setup();
    await worker.install();
    caches.cache(ASSETS).poison(`${SCOPE}assets/shell-1.js`, 'steal()');
    pages.poison(`${SCOPE}index.html`, '<script>steal()</script>', 'text/html');

    expect(await (await respond('assets/shell-1.js')).text()).toBe('shell()');
    expect(await (await respond('')).text()).toBe('<!doctype html>home');
    expect(caches.cache(ASSETS).text(`${SCOPE}assets/shell-1.js`)).toBe('shell()');
    expect(pages.text(`${SCOPE}index.html`)).toBe('<!doctype html>home');
  });

  it('fills the cache on first use only when the network bytes match', async () => {
    const { caches, host, respond } = await setup();
    const wasm = `${SCOPE}vendor/ffmpeg/core-1/ffmpeg-core.wasm`;
    expect(await (await respond('vendor/ffmpeg/core-1/ffmpeg-core.wasm')).text()).toBe(
      'wasm-bytes',
    );
    expect(caches.cache(ASSETS).text(wasm)).toBe('wasm-bytes');

    host.files['assets/lazy-1.js'] = 'tampered()';
    await respond('assets/lazy-1.js');
    expect(caches.cache(ASSETS).entries.has(`${SCOPE}assets/lazy-1.js`)).toBe(false);
  });

  it('never serves a file this build does not list from the cache', async () => {
    const { caches, host, respond } = await setup();
    // An older build's chunk, or one another site planted.
    caches.cache(ASSETS).poison(`${SCOPE}assets/old-1.js`, 'old()');
    const response = await respond('assets/old-1.js');
    expect(response.status).toBe(404);
    expect(host.fetched).toEqual([`${SCOPE}assets/old-1.js`]);
    expect(caches.cache(ASSETS).text(`${SCOPE}assets/old-1.js`)).toBe('old()');
  });

  it('sends Range requests straight to the network', async () => {
    const { worker, host, respond } = await setup();
    await worker.install();
    host.fetched.length = 0;
    await respond('assets/shell-1.js', { headers: { range: 'bytes=0-1' } });
    expect(host.fetched).toEqual([`${SCOPE}assets/shell-1.js`]);
  });

  it('falls back to a verified Home for an unknown page while offline', async () => {
    const { worker, host, pages, respond } = await setup();
    await worker.install();
    host.goOffline();
    const navigate = new Request(`${SCOPE}no-such-page/`);
    Object.defineProperty(navigate, 'mode', { value: 'navigate' });
    const answer = () => worker.respond(navigate, () => undefined);
    expect(await (await answer()).text()).toBe('<!doctype html>home');

    pages.poison(`${SCOPE}index.html`, 'evil', 'text/html');
    await expect(answer()).rejects.toThrow('Failed to fetch');
    await expect(respond('assets/unknown.js')).rejects.toThrow('Failed to fetch');
  });
});

describe('activate', () => {
  it('prunes asset entries this build does not list and older pages caches', async () => {
    const { worker, caches } = await setup();
    await worker.install();
    const assets = caches.cache(ASSETS);
    assets.poison(`${SCOPE}assets/old-1.js`, 'old()');
    await caches
      .cache('ortoolbox-pages-old')
      .put(`${SCOPE}__ortoolbox-install-complete`, new Response('500'));
    await caches
      .cache('ortoolbox-pages-newer')
      .put(`${SCOPE}__ortoolbox-install-complete`, new Response('2000'));
    caches.cache('ortoolbox-pages-installing');
    caches.cache('ortoolbox-old-layout');
    caches.cache('another-site');

    await worker.activate();

    expect([...assets.entries.keys()].sort()).toEqual([
      `${SCOPE}assets/lazy-1.js`,
      `${SCOPE}assets/shell-1.js`,
    ]);
    expect((await caches.keys()).sort()).toEqual(
      [
        'another-site',
        ASSETS,
        'ortoolbox-pages-installing',
        'ortoolbox-pages-newer',
        worker.pagesCache,
      ].sort(),
    );
  });

  it('never writes to cached entries to record use', async () => {
    const { worker, caches, respond } = await setup();
    await worker.install();
    const assets = caches.cache(ASSETS);
    const before = assets.entries.get(`${SCOPE}assets/shell-1.js`);
    await respond('assets/shell-1.js');
    await worker.activate();
    expect(assets.entries.get(`${SCOPE}assets/shell-1.js`)).toBe(before);
  });
});
