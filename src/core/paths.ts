/**
 * URL helper. The site is served from a sub-path (`/or-toolbox/` on GitHub
 * Pages), so a root-relative link like `/settings/` would leave the site.
 * Every internal link and asset URL goes through `url()`.
 */

/**
 * Turns a path relative to the site root into a URL path that works under
 * the configured base.
 *
 * ```ts
 * url()                    // '/or-toolbox/'
 * url('settings/')         // '/or-toolbox/settings/'
 * url('/tools/chat/?x=1')  // '/or-toolbox/tools/chat/?x=1'
 * ```
 *
 * Page links should keep their trailing slash (`'settings/'`, not
 * `'settings'`): static hosts redirect the slash-less form.
 */
export function url(path = ''): string {
  // BASE_URL always starts and ends with a slash.
  return import.meta.env.BASE_URL + path.replace(/^\/+/, '');
}
