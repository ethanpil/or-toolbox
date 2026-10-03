/**
 * The page shell. Every page's entry module calls `mountPage()` once:
 *
 * ```ts
 * mountPage({ title: 'History', icon: 'clock-history', lead: 'Every run, newest first.', nav: 'history' }, ({ core, main }) => {
 *   main.append(…);
 * });
 * ```
 *
 * It boots the page (service worker, sweep; `isolation: 'required'` for ffmpeg pages), applies the appearance
 * settings and keeps them live, renders the skip link, navbar, `<main id="main">`, footer and the page header
 * (`<h1 data-testid="page-title">`, unless `header: false`), sets `document.title`, and installs what every page
 * needs: toasts' live regions, the command palette (Ctrl/Cmd+K), the leave-page guard, the budget confirmation
 * modal and the auto-lock activity tracker. Tool pages go through `mountTool()`, which calls this.
 */
import { boot } from '../../core/boot';
import { getCore } from '../../core/index';
import type { CoreServices } from '../../core/types';
import type { ToolId } from '../../tools/types';
import { type Child, h } from '../dom';
import { installAnnouncer } from '../feedback/announce';
import { userMessage } from '../../core/errors';
import { installAppearance } from './appearance';
import { budgetConfirm } from './budget-confirm';
import { footer } from './footer';
import { guardedNavigate, installLeaveGuard } from './leave-guard';
import type { NavKey } from './links';
import { navbar } from './navbar';
import { installPaletteShortcut, togglePalette } from './palette';
import { pageHeader } from './page-header';

export { pageHeader } from './page-header';
export type { PageHeaderOptions } from './page-header';

export interface PageOptions {
  /** The `<h1>` and the document title (`<title> · ORtoolbox`; just `ORtoolbox` on Home). */
  title: string;
  /** Bootstrap Icons name for the header's icon tile. */
  icon?: string;
  /** One muted sentence under the title. */
  lead?: Child;
  /** Header buttons on the right. */
  actions?: Child;
  /** Which navbar entry is current. */
  nav?: NavKey;
  /** On tool pages: the tool (marked in the Tools menu). */
  tool?: ToolId;
  /** `'required'` only on pages that need multi-threaded ffmpeg (see boot()). */
  isolation?: 'required';
  /** false: the page renders its own header (with `data-testid="page-title"` on its only `<h1>`). */
  header?: boolean;
  /** A reading-width column (Privacy) instead of the full container. */
  narrow?: boolean;
}

export interface PageContext {
  core: CoreServices;
  /** `<main>`; the header is already in it unless `header: false`. */
  main: HTMLElement;
  /** Navigates in this tab, asking first when results or runs would be lost. Resolves false if the user stayed. */
  navigate: (href: string) => Promise<boolean>;
}

let mounted = false;

export function mountPage(
  options: PageOptions,
  render?: (page: PageContext) => void | Promise<void>,
): PageContext {
  if (mounted) throw new Error('mountPage() runs once per page');
  mounted = true;

  boot(options.isolation ? { isolation: options.isolation } : {});
  const core = getCore();
  installAppearance(core.settings);
  document.title = options.title === 'ORtoolbox' ? 'ORtoolbox' : `${options.title} · ORtoolbox`;

  const app = document.getElementById('app');
  if (!app) throw new Error('Missing <div id="app">');
  app.className = 'or-app d-flex flex-column min-vh-100';

  const main = h('main', {
    id: 'main',
    tabIndex: -1,
    class: [
      'or-main flex-grow-1 py-4 py-lg-5',
      options.narrow ? 'container or-narrow' : 'container-xxl',
    ],
  });
  if (options.header !== false) {
    main.append(
      pageHeader({
        title: options.title,
        ...(options.icon ? { icon: options.icon } : {}),
        ...(options.lead ? { lead: options.lead } : {}),
        ...(options.actions ? { actions: options.actions } : {}),
      }),
    );
  }

  app.replaceChildren(
    h(
      'a',
      { class: 'visually-hidden-focusable or-skip-link', href: '#main' },
      'Skip to main content',
    ),
    navbar(core, {
      ...(options.nav ? { nav: options.nav } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
      onPalette: () => togglePalette(core),
    }),
    main,
    footer(),
  );

  installAnnouncer();
  installPaletteShortcut(core);
  installLeaveGuard(core);
  installActivityTracker(core);
  core.runs.setConfirmHandler(budgetConfirm);

  const page: PageContext = {
    core,
    main,
    navigate: (href) => guardedNavigate(core, href),
  };

  if (render) {
    Promise.resolve()
      .then(() => render(page))
      .catch((error: unknown) => {
        console.error(error);
        main.append(
          h(
            'div',
            { class: 'alert alert-danger', role: 'alert', 'data-testid': 'page-error' },
            h('div', { class: 'fw-semibold' }, 'This page could not load.'),
            userMessage(error),
          ),
        );
      });
  }
  return page;
}

/** Records user activity for the passphrase lock's auto-lock timer (throttled; the core throttles writes too). */
function installActivityTracker(core: CoreServices): void {
  let last = 0;
  const touch = (): void => {
    const now = Date.now();
    if (now - last < 5000) return;
    last = now;
    if (core.keys.lock.enabled()) core.keys.lock.touch();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(type, touch, { capture: true, passive: true });
  }
}
