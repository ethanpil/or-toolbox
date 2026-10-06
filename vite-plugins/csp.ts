/**
 * The Content Security Policy. Three consumers, one table:
 *
 * - html-head.ts injects it as a <meta> tag into every page. That covers the
 *   first visit, before the service worker controls the page, but a meta
 *   policy cannot carry `frame-ancestors` and does not reach workers.
 * - The service worker (src/sw/) adds it as a real header to the documents it
 *   serves, plus `frame-ancestors 'none'` (`documentHeaderPolicy`), and to
 *   worker scripts (`workerPolicy`), so pdf.js, ffmpeg and the image worker
 *   run under it too. GitHub Pages cannot send headers itself.
 *
 * One table serves both the build and the dev server. The dev policy adds
 * only what Vite's hot reload needs, so CSP violations show up in
 * `npm run e2e:dev` too.
 *
 * Every directive is as tight as the app allows. Loosen one only with a
 * comment here saying what needs it, and record the reason in CLAUDE.md.
 */
const DIRECTIVES: Record<string, string[]> = {
  // Anything not listed below (manifest, prefetch, ...) is same-origin only.
  'default-src': ["'self'"],

  // Bundled, self-hosted scripts only: no inline scripts, no eval, no CDNs.
  // 'wasm-unsafe-eval' permits WebAssembly compilation without permitting
  // JavaScript eval. ffmpeg compiles inside workers (which do not inherit a
  // meta policy), so Chromium and WebKit do not need it today; it is kept for
  // Firefox (unverified) and for libraries that compile wasm on the page.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],

  // Workers are bundled files on this origin (ffmpeg's class worker, its
  // pthread workers, later the pdf.js worker). No `blob:` workers.
  'worker-src': ["'self'"],

  // The static host and OpenRouter are the only network destinations.
  // `blob:` and `data:` let code turn object URLs / data URLs back into
  // bytes with fetch() (the ffmpeg core is handed over as a blob: URL).
  'connect-src': ["'self'", 'https://openrouter.ai', 'blob:', 'data:'],

  // Media is never hot-linked: results arrive as base64 or are fetched from
  // openrouter.ai into Blobs, then shown through object URLs. `data:` also
  // covers the SVGs embedded in Bootstrap's CSS.
  'img-src': ["'self'", 'blob:', 'data:'],
  'media-src': ["'self'", 'blob:', 'data:'],

  // Stylesheets are bundled files. No inline <style> and no style=""
  // attributes; styles set through the CSSOM (element.style.x = ...) are not
  // restricted by CSP, which is what Bootstrap/Popper and h() use.
  'style-src': ["'self'"],

  // The Bootstrap Icons font is bundled (never inlined as a data: URL; see
  // build.assetsInlineLimit in vite.config.ts).
  'font-src': ["'self'"],

  // No plugins, no <base> tag, no frames.
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-src': ["'none'"],

  // Sign-in with OpenRouter is a top-level navigation, not a form post.
  'form-action': ["'self'"],
};

/** The production policy as a single header-style string (the <meta> tag). */
export function contentSecurityPolicy(): string {
  return serialise(DIRECTIVES);
}

/**
 * The header the service worker adds to every HTML document it serves: the
 * meta policy plus `frame-ancestors 'none'`, which only works as a header.
 * Nothing frames this site (a framed page could be clickjacked into a paid
 * run through `?prompt=`/`?model=`).
 */
export function documentHeaderPolicy(): string {
  return serialise({ ...DIRECTIVES, 'frame-ancestors': ["'none'"] });
}

/**
 * The header the service worker adds to worker scripts (pdf.js, ffmpeg's
 * class and pthread workers, the image worker). A worker does not inherit the
 * page's meta policy; it takes its policy from its own script's response.
 * Same table, minus the directives that only mean something in a document.
 * The workers need exactly what the pages need: same-origin scripts and
 * nested workers, wasm compilation ('wasm-unsafe-eval'), and fetch() of
 * blob:/data: URLs (the ffmpeg core arrives as a blob: URL).
 */
export function workerPolicy(): string {
  const documentOnly = new Set(['base-uri', 'form-action', 'frame-src']);
  return serialise(
    Object.fromEntries(Object.entries(DIRECTIVES).filter(([name]) => !documentOnly.has(name))),
  );
}

/**
 * The dev server's policy: the production one plus what Vite needs for hot
 * reload, namely inline <style> elements (CSS updates, error overlay) and the
 * HMR WebSocket.
 */
export function devContentSecurityPolicy(hmrOrigins: string[]): string {
  return serialise({
    ...DIRECTIVES,
    'style-src': [...(DIRECTIVES['style-src'] ?? []), "'unsafe-inline'"],
    'connect-src': [...(DIRECTIVES['connect-src'] ?? []), ...hmrOrigins],
  });
}

function serialise(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
