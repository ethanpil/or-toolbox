/**
 * The Content Security Policy, injected as a <meta> tag in production builds
 * only (see html-head.ts). GitHub Pages cannot send headers, so a meta tag is
 * the only option; that means `frame-ancestors`, `report-uri` and `sandbox`
 * are unavailable (browsers ignore them in a meta policy).
 *
 * Every directive is as tight as the app allows. Loosen one only with a
 * comment here saying what needs it, and record the reason in CLAUDE.md.
 */
const DIRECTIVES: Record<string, string[]> = {
  // Anything not listed below (manifest, prefetch, ...) is same-origin only.
  'default-src': ["'self'"],

  // Bundled, self-hosted scripts only: no inline scripts, no eval, no CDNs.
  // 'wasm-unsafe-eval' permits WebAssembly compilation (ffmpeg.wasm, and
  // pdf.js image decoders) without permitting JavaScript eval.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],

  // Workers are bundled files on this origin (ffmpeg's class worker, its
  // pthread workers, later the pdf.js worker). `blob:` is deliberately absent:
  // nothing needs it. See src/core/media/ffmpeg.ts.
  'worker-src': ["'self'"],

  // The static host and OpenRouter are the only network destinations.
  // `blob:` and `data:` let code turn object URLs / data URLs back into
  // bytes with fetch(); they never leave the browser.
  'connect-src': ["'self'", 'https://openrouter.ai', 'blob:', 'data:'],

  // Generated images and video arrive as data URLs, object URLs, or HTTPS
  // links on provider CDNs whose hosts are not known in advance.
  // `data:` also covers the SVGs embedded in Bootstrap's CSS.
  'img-src': ["'self'", 'blob:', 'data:', 'https:'],
  'media-src': ["'self'", 'blob:', 'data:', 'https:'],

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

/** The policy as a single header-style string. */
export function contentSecurityPolicy(): string {
  return Object.entries(DIRECTIVES)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}
