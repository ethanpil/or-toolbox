/**
 * Leave-page guard for in-app navigation. While this page holds results that were not downloaded
 * (`results.pending()`) or runs in progress (`runs.active()`), a click on a link to another page of the site is
 * intercepted and a dialog lists what would be lost, with Download all / Leave anyway / Stay. Reloads, closing
 * the tab and typed URLs are covered by the native `beforeunload` prompt the results service adds.
 *
 * "Leave anyway" discards the pending results first, so the native prompt does not ask a second time; runs are
 * aborted by the runs service when the page goes away.
 *
 * Code that navigates by script (the palette, Home's search) calls `navigate()` so it is guarded too.
 */
import type { CoreServices } from '../../core/types';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { presentError } from '../feedback/errors';
import { plural } from '../format';

export interface LinkClick {
  /** The anchor's resolved URL (`anchor.href`). */
  href: string;
  /** The anchor's `target` attribute ('' when absent). */
  target: string;
  /** The anchor has a `download` attribute. */
  download: boolean;
  /** MouseEvent.button. */
  button: number;
  /** Ctrl, Meta, Shift or Alt was held (the browser opens a new tab or window). */
  modifiers: boolean;
  defaultPrevented: boolean;
}

/**
 * True when this click would navigate this tab to another page of the site, so the guard should run.
 * New tabs, downloads, other origins and same-page fragment links never leave the page.
 */
export function leavesPage(click: LinkClick, here: Pick<Location, 'href'>): boolean {
  if (click.defaultPrevented || click.button !== 0 || click.modifiers || click.download)
    return false;
  if (click.target !== '' && click.target.toLowerCase() !== '_self') return false;
  let target: URL;
  let current: URL;
  try {
    target = new URL(click.href, here.href);
    current = new URL(here.href);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.origin !== current.origin) return false;
  const samePage = target.pathname === current.pathname && target.search === current.search;
  return !(samePage && target.hash !== '');
}

/** What would be lost by leaving now, as short lines ("3 images and 1 video not downloaded", "1 run in progress"). */
export function atStake(core: Pick<CoreServices, 'results' | 'runs'>): string[] {
  const lines: string[] = [];
  const summary = core.results.summary();
  if (summary) lines.push(summary);
  // A run handed off to a job (video) is finished by the job, also after this page is gone.
  const running = core.runs.active().filter((run) => run.jobId === null).length;
  if (running > 0) lines.push(`${plural(running, 'run')} in progress`);
  return lines;
}

let dialogOpen = false;

/**
 * Goes to `href` in this tab, asking first when something would be lost. Resolves false when the user stayed.
 */
export async function guardedNavigate(
  core: Pick<CoreServices, 'results' | 'runs'>,
  href: string,
): Promise<boolean> {
  if (atStake(core).length === 0) {
    location.assign(href);
    return true;
  }
  if (dialogOpen) return false;
  dialogOpen = true;
  try {
    const leave = await askToLeave(core);
    if (!leave) return false;
    for (const result of core.results.pending()) core.results.remove(result.id);
    location.assign(href);
    return true;
  } finally {
    dialogOpen = false;
  }
}

function askToLeave(core: Pick<CoreServices, 'results' | 'runs'>): Promise<boolean> {
  let leave = false;
  const list = h('ul', { class: 'mb-3', 'data-testid': 'leave-guard-list' });
  const intro = h('p', null, 'If you leave this page now, you lose:');
  const note = h(
    'p',
    { class: 'small text-body-secondary mb-0' },
    'Images, audio, video and files exist only in this page until you download them. Text results stay in History.',
  );

  const leaveButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-danger',
      'data-testid': 'leave-guard-leave',
      onclick: () => {
        leave = true;
        modal.hide();
      },
    },
    'Leave anyway',
  );
  const downloadButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-primary',
      'data-testid': 'leave-guard-download',
      onclick: () => {
        downloadButton.disabled = true;
        core.results
          .downloadAll()
          .then(render)
          .catch((error: unknown) => void presentError(error))
          .finally(() => {
            downloadButton.disabled = false;
          });
      },
    },
    'Download all',
  );

  const render = (): void => {
    const lines = atStake(core);
    list.replaceChildren(...lines.map((line) => h('li', null, line)));
    downloadButton.hidden = core.results.pending().length === 0;
    if (lines.length === 0) {
      intro.textContent = 'Everything is downloaded. Nothing will be lost.';
      list.hidden = true;
      leaveButton.textContent = 'Continue';
      leaveButton.className = 'btn btn-primary';
      leaveButton.focus();
    }
  };

  const stay = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary me-auto',
      'data-bs-dismiss': 'modal',
      'data-testid': 'leave-guard-stay',
    },
    'Stay',
  );
  const modal = openModal({
    title: 'Leave this page?',
    icon: 'exclamation-triangle',
    tone: 'warning',
    body: [intro, list, note],
    footer: [stay, downloadButton, leaveButton],
    // Stay is the safe default.
    initialFocus: stay,
    testId: 'leave-guard',
  });
  render();
  return modal.closed.then(() => leave);
}

/** Intercepts in-app link clicks on this page while something is at stake. */
export function installLeaveGuard(core: Pick<CoreServices, 'results' | 'runs'>): void {
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement)) return;
    const click: LinkClick = {
      href: anchor.href,
      target: anchor.getAttribute('target') ?? '',
      download: anchor.hasAttribute('download'),
      button: event.button,
      modifiers: event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
      defaultPrevented: event.defaultPrevented,
    };
    if (!leavesPage(click, location) || atStake(core).length === 0) return;
    event.preventDefault();
    void guardedNavigate(core, anchor.href);
  });
}
