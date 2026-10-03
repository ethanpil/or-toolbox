/**
 * The Content Security Policy, injected as a <meta> tag into every page by
 * html-head.ts. GitHub Pages cannot send headers, so a meta tag is the only
 * option; that means `frame-ancestors`, `report-uri` and `sandbox` are
 * unavailable (browsers ignore them in a meta policy).
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

/** The production policy as a single header-style string. */
export function contentSecurityPolicy(): string {
  return serialise(DIRECTIVES);
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
