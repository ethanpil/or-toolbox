import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { HtmlTagDescriptor, Plugin } from 'vite';
import { contentSecurityPolicy, devContentSecurityPolicy } from './csp.ts';
import { pageDescription, toolIdOf } from './descriptions.ts';

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
 * It also adds what differs per page: the meta description (vite-plugins/descriptions.ts), and a tool page's own
 * stylesheet, `src/styles/tools/<tool id>.scss`, when there is one (the shared stylesheet holds the rest). A second
 * hook, after Vite has bundled, preloads the icon font.
 *
 * The cross-document View Transitions opt-in is not here: it is the CSS rule
 * `@view-transition { navigation: auto }` in src/styles/main.scss (the old
 * <meta name="view-transition"> form no longer exists).
 */
export function htmlHead(): Plugin[] {
  let policy = contentSecurityPolicy();
  let root = process.cwd();
  let base = '/';

  const head: Plugin = {
    name: 'ortoolbox:html-head',
    configResolved(config) {
      root = config.root;
      base = config.base;
      if (config.command === 'serve') {
        const port = config.server.port;
        policy = devContentSecurityPolicy([`ws://localhost:${port}`, `ws://127.0.0.1:${port}`]);
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // `tools/chat/` for tools/chat/index.html, '' for the root one.
        const dir = relative(root, dirname(ctx.filename)).replaceAll(sep, '/');
        const route = dir === '' ? '' : `${dir}/`;
        const toolId = toolIdOf(route);
        const toolStyles =
          toolId !== null && existsSync(join(root, 'src', 'styles', 'tools', `${toolId}.scss`))
            ? [
                {
                  tag: 'link',
                  attrs: { rel: 'stylesheet', href: `/src/styles/tools/${toolId}.scss` },
                },
              ]
            : [];
        const tags: HtmlTagDescriptor[] = [
          { tag: 'meta', attrs: { charset: 'utf-8' } },
          // The policy only governs what the parser meets after this tag, so
          // it comes before every script and stylesheet.
          { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy } },
          {
            tag: 'meta',
            attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' },
          },
          { tag: 'meta', attrs: { name: 'description', content: pageDescription(root, route) } },
          // The OAuth return page carries a single-use code in its address and has nothing to index.
          ...(route === 'auth/callback/'
            ? [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }]
            : []),
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
          ...toolStyles,
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

  // The icon font is named in the stylesheet, so the browser would learn of it only after fetching and parsing
  // the CSS, and the icons would appear late (font-display is block). The bundle knows its hashed name; a
  // preload starts the download beside the CSS. `crossorigin` is required for fonts even from the same origin,
  // or the preload is not reused. Build only: the dev server has no hashed name.
  const preloadIconFont: Plugin = {
    name: 'ortoolbox:preload-icon-font',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const font = Object.keys(ctx.bundle ?? {}).find((name) =>
          /(^|\/)bootstrap-icons-subset-[^/]*\.woff2$/.test(name),
        );
        if (font === undefined) return [];
        return [
          {
            tag: 'link',
            attrs: {
              rel: 'preload',
              as: 'font',
              type: 'font/woff2',
              href: `${base}${font}`,
              crossorigin: '',
            },
            injectTo: 'head',
          },
        ];
      },
    },
  };

  return [head, preloadIconFont];
}
