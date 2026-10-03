/**
 * Settings: keys, default models, tool bindings, budgets, appearance, passphrase lock, data, and backup. One
 * panel per `SETTINGS_SECTIONS` entry, each a `<section>` whose id is the section id, chosen from the side
 * navigation or the URL hash (`settings/#budgets`; the palette, error messages and onboarding link there). A
 * hash change focuses the section's heading, so screen readers announce it. Sections load their numbers when
 * first shown and follow changes from other tabs. The section modules live in src/pages/settings/.
 */
import { h } from '../ui/dom';
import { icon } from '../ui/icon';
import { mountPage } from '../ui/shell/index';
import { SETTINGS_SECTIONS, type SettingsSection } from '../ui/shell/links';
import { appearanceSection } from './settings/appearance';
import { backupSection } from './settings/backup';
import { budgetsSection } from './settings/budgets';
import { dataSection } from './settings/data';
import { keysSection } from './settings/keys';
import { sectionFromHash } from './settings/logic';
import { modelsSection } from './settings/models';
import { securitySection } from './settings/security';
import { toolsSection } from './settings/tools';
import type { SectionView } from './settings/ui';

const LEADS: Record<SettingsSection, string> = {
  keys: 'Your OpenRouter keys, what is left on them, and which one tools use by default.',
  models: 'The model each kind of task uses, and free-only mode.',
  tools: 'Pin a key or a model to a single tool.',
  budgets: 'Limits that ask first, or stop a run, before it spends too much.',
  appearance: 'Theme, accent colour, density and motion.',
  security: 'Encrypt your keys in this browser with a passphrase.',
  data: 'What ORtoolbox keeps in this browser, and deleting it.',
  backup: 'Save everything to a file, or restore from one.',
};

mountPage(
  {
    title: 'Settings',
    icon: 'gear',
    lead: 'Keys, default models, budgets, appearance and your data. Everything stays in this browser.',
    nav: 'settings',
  },
  ({ core, main }) => {
    const builders: Record<SettingsSection, () => SectionView> = {
      keys: () => keysSection(core),
      models: () => modelsSection(core),
      tools: () => toolsSection(core),
      budgets: () => budgetsSection(core),
      appearance: () => appearanceSection(core),
      security: () => securitySection(core),
      data: () => dataSection(core),
      backup: () => backupSection(core),
    };

    const sections = SETTINGS_SECTIONS.map((info) => {
      const view = builders[info.id]();
      const headingId = `${info.id}-title`;
      const heading = h('h2', { id: headingId, class: 'h4 mb-1', tabIndex: -1 }, info.label);
      const panel = h(
        'section',
        {
          id: info.id,
          class: 'or-settings-panel',
          'aria-labelledby': headingId,
          hidden: true,
          'data-testid': `settings-section-${info.id}`,
        },
        h(
          'div',
          { class: 'd-flex align-items-center gap-3 mb-4' },
          h(
            'span',
            { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' },
            icon(info.icon),
          ),
          h(
            'div',
            { class: 'min-w-0' },
            heading,
            h('p', { class: 'text-body-secondary mb-0' }, LEADS[info.id]),
          ),
        ),
        view.element,
      );
      const link = h(
        'a',
        {
          class: 'nav-link d-flex align-items-center gap-2',
          href: `#${info.id}`,
          'data-testid': `settings-nav-${info.id}`,
          onclick: (event: MouseEvent) => {
            // Same hash again: no hashchange fires, so show (and focus) the section here.
            if (location.hash === `#${info.id}`) {
              event.preventDefault();
              show(info.id, true);
            }
          },
        },
        icon(info.icon, 'or-settings-nav-icon'),
        info.label,
      );
      return { info, view, heading, panel, link };
    });

    function show(id: SettingsSection, focus: boolean): void {
      for (const section of sections) {
        const active = section.info.id === id;
        section.panel.hidden = !active;
        section.link.classList.toggle('active', active);
        if (active) section.link.setAttribute('aria-current', 'true');
        else section.link.removeAttribute('aria-current');
      }
      const section = sections.find((entry) => entry.info.id === id)!;
      section.view.onShow?.();
      if (focus) section.heading.focus();
    }

    main.append(
      h(
        'div',
        { class: 'row g-4' },
        h(
          'div',
          { class: 'col-lg-3' },
          h(
            'nav',
            { class: 'card shadow-sm or-settings-nav', 'aria-label': 'Settings sections' },
            h(
              'ul',
              { class: 'nav nav-pills flex-lg-column gap-1 p-2' },
              sections.map((section) => h('li', { class: 'nav-item' }, section.link)),
            ),
          ),
        ),
        h(
          'div',
          { class: 'col-lg-9 min-w-0' },
          sections.map((section) => section.panel),
        ),
      ),
    );

    const initial = sectionFromHash(location.hash);
    show(initial ?? 'keys', false);
    if (initial) {
      // The browser tried to scroll to the hash before the page existed; on narrow screens the navigation sits
      // above the panel, so bring the section into view.
      const heading = sections.find((entry) => entry.info.id === initial)!.heading;
      if (heading.getBoundingClientRect().top > window.innerHeight / 2)
        heading.scrollIntoView({ block: 'start' });
    }
    window.addEventListener('hashchange', () => {
      // Back to the bare URL shows the first section, as a fresh visit does. Other fragments (the skip link's
      // #main) are not sections and change nothing.
      const id = location.hash === '' ? SETTINGS_SECTIONS[0]!.id : sectionFromHash(location.hash);
      if (id) show(id, true);
    });
  },
);
