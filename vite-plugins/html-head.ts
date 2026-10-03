import type { HtmlTagDescriptor, Plugin } from 'vite';
import { contentSecurityPolicy, devContentSecurityPolicy } from './csp.ts';

const APP_NAME = 'ORtoolbox';
/** Keep in sync with $primary in src/styles/_variables.scss and public/manifest.webmanifest. */
const THEME_COLOR = '#4f46e5';

/**
 * Injects the <head> every page shares, so the HTML entry files stay tiny
 * (a <title>, <div id="app"> and one module script).
 *
 * The hook runs *before* Vite's own HTML handling (`order: 'pre'`), so the
 * root-relative URLs below are rewritten to the configured base and the Sass
 * entry is bundled like any other asset, in dev and in the build alike.
 *
 * The cross-document View Transitions opt-in is not here: it is the CSS rule
 * `@view-transition { navigation: auto }` in src/styles/main.scss (the old
 * <meta name="view-transition"> form no longer exists).
 */
export function htmlHead(): Plugin {
  let policy = contentSecurityPolicy();

  return {
    name: 'ortoolbox:html-head',
    configResolved(config) {
      if (config.command === 'serve') {
        const port = config.server.port;
        policy = devContentSecurityPolicy([`ws://localhost:${port}`, `ws://127.0.0.1:${port}`]);
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const tags: HtmlTagDescriptor[] = [
          { tag: 'meta', attrs: { charset: 'utf-8' } },
          // The policy only governs what the parser meets after this tag, so
          // it comes before every script and stylesheet.
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy } },
          {
            tag: 'meta',
            attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' },
          },
          { tag: 'meta', attrs: { name: 'color-scheme', content: 'light dark' } },
          { tag: 'meta', attrs: { name: 'theme-color', content: THEME_COLOR } },
          { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } },
          { tag: 'link', attrs: { rel: 'icon', href: '/icons/favicon.ico', sizes: '32x32' } },
          { tag: 'link', attrs: { rel: 'icon', href: '/icons/logo.svg', type: 'image/svg+xml' } },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' } },
          // Classic (render-blocking) script: sets data-bs-theme before first
          // paint. External because the CSP forbids inline scripts.
          { tag: 'script', attrs: { src: '/theme-init.js' } },
          { tag: 'link', attrs: { rel: 'stylesheet', href: '/src/styles/main.scss' } },
        ];

        return {
          html: html.replace(/<title>([^<]*)<\/title>/, (_match, title: string) => {
            const page = title.trim();
            const full = page === '' || page === APP_NAME ? APP_NAME : `${page} · ${APP_NAME}`;
            return `<title>${full}</title>`;
          }),
          tags: tags.map((tag) => ({ ...tag, injectTo: 'head-prepend' as const })),
        };
      },
    },
  };
}
