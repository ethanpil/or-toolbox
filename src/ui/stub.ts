/**
 * STAGE 0 PLACEHOLDER — delete this file in Stage 2.
 *
 * A bare page frame (navbar + heading) so that every route renders and is
 * navigable before the real shell exists. The real shell (navbar with theme
 * toggle, palette, toasts) and `mountTool()` replace it; nothing outside the
 * page entry files (src/pages/*.ts, src/tools/<id>/main.ts) depends on it.
 */
import { url } from '../core/paths';
import type { ToolManifest } from '../tools/types';
import { type Child, h } from './dom';

const NAV_LINKS: readonly (readonly [label: string, path: string])[] = [
  ['Settings', 'settings/'],
  ['Models', 'models/'],
  ['History', 'history/'],
  ['Stats', 'stats/'],
  ['Privacy', 'privacy/'],
  ['Diagnostics', 'diagnostics/'],
];

function navbar(): HTMLElement {
  const link = ([label, path]: readonly [string, string]): HTMLElement => {
    const current = location.pathname === url(path);
    return h(
      'li',
      { class: 'nav-item' },
      h(
        'a',
        {
          class: ['nav-link', current && 'active'],
          href: url(path),
          'aria-current': current ? 'page' : null,
        },
        label,
      ),
    );
  };

  return h(
    'header',
    { class: 'navbar navbar-expand bg-body-tertiary border-bottom' },
    h(
      'nav',
      { class: 'container flex-wrap', 'aria-label': 'Main' },
      h(
        'a',
        { class: 'navbar-brand d-flex align-items-center gap-2', href: url() },
        h('img', { src: url('icons/logo.svg'), alt: '', width: 28, height: 28 }),
        'ORtoolbox',
      ),
      h('ul', { class: 'navbar-nav flex-wrap' }, NAV_LINKS.map(link)),
    ),
  );
}

/** Renders the page frame into `#app`: navbar, an `<h1>` with the title, then `content`. */
export function renderStubPage(title: Child, ...content: Child[]): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('Missing <div id="app">');
  app.replaceChildren(
    navbar(),
    h(
      'main',
      { class: 'container py-4' },
      h('h1', { class: 'h2 mb-3', 'data-testid': 'page-title' }, title),
      content,
    ),
  );
}

/** A notice saying when the real page arrives. */
export function placeholder(stage: string): HTMLElement {
  return h(
    'div',
    { class: 'alert alert-secondary', role: 'note', 'data-testid': 'placeholder' },
    `Placeholder. This page is built in ${stage}.`,
  );
}

/** The placeholder page of a tool. */
export function renderToolStub(tool: ToolManifest): void {
  renderStubPage(
    [h('i', { class: `bi bi-${tool.icon} me-2`, 'aria-hidden': 'true' }), tool.name],
    h('p', { class: 'lead' }, tool.description),
    placeholder('a later stage'),
  );
}
