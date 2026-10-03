/**
 * Privacy: what ORtoolbox stores, where, and what leaves the browser, in plain language. Keep it in step with
 * CLAUDE.md ("Shared origin", storage rules) and the CSP when either changes.
 */
import { type Child, h } from '../ui/dom';
import { icon } from '../ui/icon';
import { mountPage } from '../ui/shell/index';
import {
  OPENROUTER_KEYS_URL,
  OPENROUTER_PRIVACY_URL,
  OPENROUTER_ZDR_URL,
  settingsUrl,
} from '../ui/shell/links';

const external = (href: string, text: string): HTMLElement =>
  h(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer' },
    text,
    h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'),
  );

const section = (id: string, iconName: string, title: string, ...body: Child[]): HTMLElement =>
  h(
    'section',
    { class: 'card shadow-sm mb-4', 'aria-labelledby': id },
    h(
      'div',
      { class: 'card-body p-4' },
      h(
        'h2',
        { id, class: 'h5 d-flex align-items-center gap-2 mb-3' },
        h('span', { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' }, icon(iconName)),
        title,
      ),
      body,
    ),
  );

mountPage(
  {
    title: 'Privacy',
    icon: 'shield-check',
    lead: 'ORtoolbox has no server and no accounts. What you run goes to OpenRouter and the model provider; everything else stays in this browser.',
    nav: 'privacy',
    narrow: true,
  },
  ({ main }) => {
    main.append(
      section(
        'privacy-local',
        'laptop',
        'No ORtoolbox server',
        h(
          'p',
          null,
          'The site is a set of static files. Once loaded, every tool runs on your device. There is no ORtoolbox server that could see your data, no analytics, no tracking and no cookies.',
        ),
        h(
          'p',
          { class: 'mb-0' },
          'Nothing syncs between devices. To move your settings, use ',
          h('a', { href: settingsUrl('backup') }, 'backup and restore'),
          '.',
        ),
      ),
      section(
        'privacy-network',
        'arrow-left-right',
        'What leaves your browser',
        h(
          'p',
          null,
          'When you run a tool, your prompt and any files you added to that run are sent to OpenRouter, which passes them to the provider of the model you chose. Apart from that, only two kinds of traffic happen:',
        ),
        h(
          'ul',
          null,
          h(
            'li',
            null,
            h('strong', null, 'Requests to OpenRouter'),
            ' (openrouter.ai): runs, key checks and the model list. Requests made with your key also say which app sent them: the site address (',
            h('code', null, 'HTTP-Referer'),
            '), the name ORtoolbox (',
            h('code', null, 'X-OpenRouter-Title'),
            ') and, for some tools, a category (',
            h('code', null, 'X-OpenRouter-Categories'),
            '). OpenRouter uses these for its app listings.',
          ),
          h(
            'li',
            null,
            h('strong', null, 'The site’s own files'),
            ' from the static host (GitHub Pages), like any website.',
          ),
        ),
        h(
          'p',
          { class: 'mb-0' },
          'The site’s security policy blocks every other destination: scripts, fonts and images are all served from this site, and model output can never load anything from another host.',
        ),
      ),
      section(
        'privacy-storage',
        'database',
        'What is stored where',
        h(
          'div',
          { class: 'table-responsive position-relative' },
          h(
            'table',
            { class: 'table align-middle mb-0' },
            h(
              'thead',
              null,
              h('tr', null, h('th', { scope: 'col' }, 'Where'), h('th', { scope: 'col' }, 'What')),
            ),
            h(
              'tbody',
              null,
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, 'Local storage'),
                h(
                  'td',
                  null,
                  'Settings, favourites and your API keys (keys encrypted when the passphrase lock is on).',
                ),
              ),
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, 'IndexedDB'),
                h(
                  'td',
                  null,
                  'Text-only history of runs (prompts, settings and text results), recent and saved prompts, each tool’s own saved work (such as a video sequence), the video job queue, the cached model list and spending stats.',
                ),
              ),
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, 'Session storage'),
                h(
                  'td',
                  null,
                  'The unlocked key while the passphrase lock is open, and the short-lived sign-in state of “Connect with OpenRouter”. Cleared when the tab closes.',
                ),
              ),
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, 'Memory only'),
                h(
                  'td',
                  null,
                  'Images, audio, video and files you upload or generate. They are never written to disk by the site; download them before you leave the page.',
                ),
              ),
            ),
          ),
        ),
        h(
          'p',
          { class: 'mt-3' },
          'History and recent prompts are deleted after the retention period you choose; starred runs, saved prompts and spending stats are kept until you delete them. You can delete any of it, or everything, in ',
          h('a', { href: settingsUrl('data') }, 'Settings → Data'),
          '.',
        ),
        h(
          'p',
          { class: 'mb-0' },
          'The passphrase lock encrypts your API keys only. History, prompts and settings are stored unencrypted, readable by anyone who can use this browser profile.',
        ),
      ),
      section(
        'privacy-keys',
        'key',
        'Your API keys',
        h(
          'ul',
          { class: 'mb-0' },
          h(
            'li',
            null,
            'Keys are shown masked (sk-or-…a1b2), never written to history or logs, never put in a URL, and sent only to openrouter.ai.',
          ),
          h(
            'li',
            null,
            'Backups leave keys out unless you opt in, and then they are encrypted with a passphrase you choose.',
          ),
          h(
            'li',
            null,
            'The optional ',
            h('a', { href: settingsUrl('security') }, 'passphrase lock'),
            ' encrypts keys at rest (AES-GCM) and locks them again after a period of inactivity.',
          ),
          h(
            'li',
            null,
            'Safest of all: give each key a credit limit in ',
            external(OPENROUTER_KEYS_URL, 'your OpenRouter key list'),
            ', so a leaked key can only spend that much.',
          ),
        ),
      ),
      h(
        'div',
        { class: 'alert alert-warning d-flex gap-3 mb-4', 'data-testid': 'shared-origin-warning' },
        icon('exclamation-triangle-fill', 'fs-4 lh-1'),
        h(
          'div',
          null,
          h('h2', { class: 'h6 mb-1' }, 'A note on github.io'),
          h(
            'p',
            { class: 'mb-0' },
            'On ethanpil.github.io, every project site shares one origin, so another page on that address could read what ORtoolbox stores in this browser. Turn on the passphrase lock, or use a key with a small credit limit. On a custom domain this risk does not exist.',
          ),
        ),
      ),
      section(
        'privacy-openrouter',
        'building',
        'What OpenRouter and the providers do with your requests',
        h(
          'p',
          null,
          'OpenRouter forwards each request to the provider of the model you chose. How they handle that data is set by their policies, not by ORtoolbox.',
        ),
        h(
          'ul',
          null,
          h(
            'li',
            null,
            h('strong', null, 'Free models'),
            ' are often offered by providers that log prompts or use them for training. Do not send anything private to a free model.',
          ),
          h(
            'li',
            null,
            h('strong', null, '“Prefer providers that do not retain data”'),
            ', a per-key setting, asks OpenRouter to route only to providers that keep nothing. It is not applied to free models (none qualify) or to image and video generation, so those requests go out without it.',
          ),
        ),
        h(
          'ul',
          { class: 'mb-0' },
          h('li', null, external(OPENROUTER_PRIVACY_URL, 'OpenRouter privacy policy')),
          h(
            'li',
            null,
            external(OPENROUTER_ZDR_URL, 'Zero data retention'),
            ': how OpenRouter limits requests to providers that keep nothing.',
          ),
        ),
      ),
    );
  },
);
