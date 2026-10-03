/**
 * Settings → Default models: the model each capability uses (shipped default unless changed; change with the
 * model picker, reset per row) and the global free-only switch with what it costs: which capabilities have no
 * free model, which tools it blocks, and how many free requests were used today.
 */
import { CAPABILITY_INFO } from '../../core/models/capabilities';
import type { Capability, CoreServices } from '../../core/types';
import { tools } from '../../tools/registry';
import { CAPABILITIES } from '../../tools/types';
import { accountFreeDaily } from '../../ui/components/key-balance';
import { modelPicker } from '../../ui/components/model-picker';
import { switchField } from '../../ui/components/switch-field';
import { type Child, h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { formatInt, formatModelPrice, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { saveSettings } from '../../ui/settings-actions';
import { modelsUrl } from '../../ui/shell/links';
import { capabilityDefault, freeOnlyImpact, freeOnlyModel } from './logic';
import { card, rerender, type SectionView } from './ui';

const usedBy = (capability: Capability): string =>
  tools
    .filter((tool) => tool.capabilities.includes(capability))
    .map((tool) => tool.name)
    .join(', ');

export function modelsSection(core: CoreServices): SectionView {
  const rows = h('ul', {
    class: 'list-group list-group-flush border-top',
    'aria-label': 'Default model per capability',
  });
  const impactSlot = h('div', { 'data-testid': 'free-only-impact' });
  const freeToday = h('span', { 'data-testid': 'free-requests-today' }, '…');
  const accountSlot = h('span', { 'data-testid': 'free-daily-account' });

  /** Fills in the model's name and price once the catalog answers (ids alone are shown until then). */
  const describeModel = (id: string, target: HTMLElement): void => {
    void core.models
      .get(id)
      .then((model) => {
        if (!model || !target.isConnected) return;
        target.replaceChildren(
          h('span', { class: 'fw-semibold' }, model.name),
          h('span', { class: 'text-body-secondary' }, ` · ${formatModelPrice(model)}`),
        );
      })
      .catch(() => undefined);
  };

  const choose = async (capability: Capability): Promise<void> => {
    const current = capabilityDefault(core.settings.get(), capability);
    const chosen = await modelPicker(core, {
      capability,
      selected: current.model,
      title: `Default ${CAPABILITY_INFO[capability].title.toLowerCase()} model`,
    });
    if (!chosen || chosen === current.model) return;
    if (
      saveSettings(core, (draft) => {
        // Choosing the shipped model again means "follow the shipped default" (it may change in an update).
        if (chosen === current.shipped) delete draft.defaultModels[capability];
        else draft.defaultModels[capability] = chosen;
      })
    ) {
      announce(`${CAPABILITY_INFO[capability].title} now uses ${chosen}.`);
    }
  };

  const reset = (capability: Capability): void => {
    if (saveSettings(core, (draft) => delete draft.defaultModels[capability])) {
      announce(`${CAPABILITY_INFO[capability].title} uses the shipped default again.`);
    }
  };

  const row = (capability: Capability): HTMLElement => {
    const settings = core.settings.get();
    const info = CAPABILITY_INFO[capability];
    const current = capabilityDefault(settings, capability);
    const detail = h('span', { class: 'small' });
    describeModel(current.model, detail);
    const freeModel = settings.freeOnly ? freeOnlyModel(settings, capability) : undefined;
    return h(
      'li',
      { class: 'list-group-item px-0 py-3', 'data-testid': `default-model-${capability}` },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-start gap-3' },
        h(
          'span',
          { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' },
          icon(info.icon),
        ),
        h(
          'div',
          { class: 'flex-grow-1 min-w-0' },
          h(
            'div',
            { class: 'd-flex flex-wrap align-items-center gap-2' },
            h('span', { class: 'fw-semibold' }, info.title),
            current.custom
              ? h(
                  'span',
                  {
                    class: 'badge rounded-pill text-bg-primary',
                    'data-testid': 'default-model-custom',
                  },
                  'Your choice',
                )
              : h('span', { class: 'badge rounded-pill text-bg-secondary' }, 'Shipped default'),
          ),
          h(
            'div',
            { class: 'font-monospace small text-break mt-1', 'data-testid': 'default-model-id' },
            current.model,
          ),
          detail,
          current.custom &&
            h(
              'div',
              { class: 'small text-body-secondary' },
              'Shipped default: ',
              h('span', { class: 'font-monospace' }, current.shipped),
            ),
          freeModel !== undefined &&
            h(
              'div',
              {
                class: ['small mt-1', freeModel ? 'text-success-emphasis' : 'text-danger-emphasis'],
                'data-testid': 'default-model-free',
              },
              icon(freeModel ? 'gift' : 'slash-circle', 'me-1'),
              freeModel
                ? ['Free-only mode uses ', h('span', { class: 'font-monospace' }, freeModel)]
                : 'No free model: blocked in free-only mode',
            ),
          h('div', { class: 'small text-body-secondary mt-1' }, `Used by ${usedBy(capability)}`),
        ),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-primary',
              'aria-label': `Change the ${info.title.toLowerCase()} model`,
              'data-testid': 'default-model-change',
              'data-focus-key': `model:${capability}:change`,
              onclick: () =>
                void choose(capability).catch((error: unknown) => void presentError(error)),
            },
            'Change',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary',
              'aria-label': `Reset the ${info.title.toLowerCase()} model to the shipped default`,
              disabled: !current.custom && settings.defaultModels[capability] === undefined,
              'data-testid': 'default-model-reset',
              'data-focus-key': `model:${capability}:reset`,
              onclick: () => reset(capability),
            },
            'Reset',
          ),
        ),
      ),
    );
  };

  const renderImpact = (): void => {
    const settings = core.settings.get();
    const impact = freeOnlyImpact(settings, CAPABILITIES, tools);
    const on = settings.freeOnly;
    const parts: Child[] = [];
    if (impact.capabilities.length > 0) {
      parts.push(
        h(
          'div',
          { class: ['alert d-flex gap-3 mb-0', on ? 'alert-warning' : 'alert-secondary'] },
          icon('slash-circle', 'fs-5 lh-1 mt-1'),
          h(
            'div',
            null,
            h(
              'div',
              { class: 'fw-semibold mb-1' },
              `No free model for ${impact.capabilities.map((cap) => CAPABILITY_INFO[cap].title.toLowerCase()).join(', ')}`,
            ),
            h(
              'div',
              null,
              on
                ? 'These tools cannot run while free-only mode is on: '
                : 'With free-only mode on, these tools could not run: ',
              h(
                'span',
                { 'data-testid': 'free-only-blocked-tools' },
                impact.tools.map((tool) => tool.name).join(', '),
              ),
              '.',
            ),
          ),
        ),
      );
    }
    rerender(impactSlot, parts);
  };

  const loadFreeCounts = (): void => {
    core.stats
      .freeRequestsToday()
      .then((count) => {
        freeToday.textContent = plural(count, 'free-model request');
      })
      .catch(() => {
        freeToday.textContent = 'Free-model requests';
      });
    void accountFreeDaily(core).then((daily) => {
      accountSlot.replaceChildren(
        daily
          ? ` OpenRouter reports ${formatInt(daily.used)} of ${formatInt(daily.limit)} used on your account (${formatInt(daily.remaining)} left; its counter can lag).`
          : '',
      );
    });
  };

  const freeOnly = switchField({
    label: 'Free-only mode',
    help: 'Only free models (ids ending in “:free”) can run. Each capability switches to its best free model, pickers hide paid ones, and nothing you run costs money.',
    checked: core.settings.get().freeOnly,
    testId: 'free-only-switch',
    onChange: (checked, input) => {
      if (
        saveSettings(core, (draft) => {
          draft.freeOnly = checked;
        })
      ) {
        announce(checked ? 'Free-only mode is on.' : 'Free-only mode is off.');
      } else {
        input.checked = !checked;
      }
    },
  });

  const render = (): void => {
    rerender(rows, CAPABILITIES.map(row));
    renderImpact();
    freeOnly.input.checked = core.settings.get().freeOnly;
  };

  const element = h(
    'div',
    null,
    card(
      {
        title: 'Free-only mode',
        icon: 'gift',
        text: 'Free models cost nothing but are rate-limited, and some capabilities have none.',
        testId: 'free-only-card',
      },
      freeOnly.element,
      h('div', { class: 'mt-3' }, impactSlot),
      h(
        'p',
        { class: 'small text-body-secondary mt-3 mb-0' },
        icon('speedometer2', 'me-1'),
        freeToday,
        ' from this browser today.',
        accountSlot,
        ' Free models allow 20 requests a minute and 50 a day (1,000 a day once you have bought $10 of credits).',
      ),
    ),
    card(
      {
        title: 'Default model per capability',
        icon: 'cpu',
        text: 'Tools use these unless you pin a model for a tool (below, or from its model chip). ORtoolbox ships cheap, fast defaults.',
        actions: h(
          'a',
          {
            class: 'btn btn-sm btn-outline-secondary',
            href: modelsUrl(),
            'data-testid': 'browse-models',
          },
          icon('grid', 'me-1'),
          'Browse models',
        ),
        testId: 'default-models',
      },
      rows,
    ),
  );

  core.settings.subscribe((next, prev) => {
    if (
      next.freeOnly !== prev.freeOnly ||
      JSON.stringify(next.defaultModels) !== JSON.stringify(prev.defaultModels) ||
      JSON.stringify(next.tools) !== JSON.stringify(prev.tools)
    ) {
      render();
    }
  });
  core.stats.subscribe(loadFreeCounts);
  core.bus.on('models-refreshed', render);
  render();

  return { element, onShow: loadFreeCounts };
}
