import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `<meta name="description">` of every page (search engines and link previews show it).
 *
 * A tool page uses its manifest's one-line `description` plus a closing sentence that says what the site is, so
 * the text is long enough to be useful in a result. A platform page has an entry in `PLATFORM_DESCRIPTIONS`,
 * keyed by its route (see `Page.route` in pages.ts). `pageDescription()` throws for a page that has neither, so
 * a new page cannot ship without a description: the build stops and tests/lint/html-head.test.ts fails.
 */

const TOOL_TAIL = 'Part of ORtoolbox: AI tools in your browser, using your own OpenRouter key.';

const PLATFORM_DESCRIPTIONS: Record<string, string> = {
  '': 'ORtoolbox is a toolbox of AI tools that run in your browser on OpenRouter: chat, OCR, images, speech, music and video. No account, no server.',
  'settings/':
    'Keys, default models, budgets, appearance, security and backup for ORtoolbox. Everything is stored in this browser only.',
  'models/':
    'Browse and filter every OpenRouter model by price, capability and your own usage, and pick the ones your tools use.',
  'history/':
    'Past runs of every ORtoolbox tool, kept as text in this browser only. Search, filter, re-run or delete them.',
  'stats/':
    'Spend, requests and tokens by day, model and key, from the ledger ORtoolbox keeps in this browser.',
  'privacy/':
    'What ORtoolbox keeps in your browser and what it sends to OpenRouter. There is no server and no account.',
  'diagnostics/':
    'Checks whether this browser has what ORtoolbox needs for video and audio work, such as cross-origin isolation and the service worker.',
  'auth/callback/': 'Finishing sign-in with OpenRouter.',
};

/** The tool id of a route such as `tools/chat/`, else null. */
export function toolIdOf(route: string): string | null {
  return /^tools\/([a-z0-9-]+)\/$/.exec(route)?.[1] ?? null;
}

/** The description for the page at `route` (`''`, `'settings/'`, `'tools/chat/'`, …). */
export function pageDescription(root: string, route: string): string {
  const id = toolIdOf(route);
  if (id === null) {
    const text = PLATFORM_DESCRIPTIONS[route];
    if (text === undefined) {
      throw new Error(
        `No meta description for the page "${route}": add it to vite-plugins/descriptions.ts.`,
      );
    }
    return text;
  }
  const file = join(root, 'src', 'tools', id, 'manifest.json');
  if (!existsSync(file)) throw new Error(`The page "${route}" has no manifest at ${file}.`);
  const { description } = JSON.parse(readFileSync(file, 'utf8')) as { description?: unknown };
  if (typeof description !== 'string' || description === '') {
    throw new Error(`The manifest of "${id}" has no description.`);
  }
  return `${description} ${TOOL_TAIL}`;
}
