/**
 * Settings → Tool bindings: one row per tool with the key and model it is pinned to (or "Default key" /
 * "Default for <capability>"), a reset, and a link to the tool. The same bindings the tool header's key and
 * model chips write (`settings.tools[id].keyId` / `.model`); the tool's saved options are left alone.
 */
import type { CoreServices, ToolManifest } from '../../core/types';
import { tools } from '../../tools/registry';
import { CAPABILITY_INFO } from '../../core/models/capabilities';
import { dataTable } from '../../ui/components/data-table';
import { modelPicker } from '../../ui/components/model-picker';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { icon } from '../../ui/icon';
import { setToolBinding } from '../../ui/settings-actions';
import { toolUrl } from '../../ui/shell/links';
import { capabilityDefault } from './logic';
import { card, rerender, type SectionView } from './ui';

export function toolsSection(core: CoreServices): SectionView {
  const body = h('tbody');

  const setKey = (tool: ToolManifest, keyId: string): void => {
    setToolBinding(core, tool.id, { keyId });
  };

  const chooseModel = async (tool: ToolManifest): Promise<void> => {
    const capability = tool.capabilities[0]!;
    const resolved = core.models.resolve(tool.id, capability);
    const chosen = await modelPicker(core, {
      capability,
      selected: resolved.model,
      title: `Model for ${tool.name}`,
    });
    if (!chosen) return;
    if (setToolBinding(core, tool.id, { model: chosen })) {
      announce(`${tool.name} now uses ${chosen}.`);
    }
  };

  const reset = (tool: ToolManifest): void => {
    if (setToolBinding(core, tool.id, { keyId: null, model: null })) {
      announce(`${tool.name} uses the default key and model again.`);
    }
  };

  const row = (tool: ToolManifest): HTMLElement => {
    const settings = core.settings.get();
    const binding = settings.tools[tool.id] ?? {};
    const keys = core.keys.list();
    const defaultKey = keys.find((key) => key.isDefault);
    const capability = tool.capabilities[0]!;
    const pinnedKey = keys.some((key) => key.id === binding.keyId) ? binding.keyId : undefined;

    const keyCell =
      keys.length === 0
        ? h('span', { class: 'text-body-secondary small' }, 'No keys yet')
        : h(
            'select',
            {
              class: 'form-select form-select-sm',
              'aria-label': `Key for ${tool.name}`,
              'data-testid': 'tool-key',
              'data-focus-key': `tool:${tool.id}:key`,
              onchange: (event: Event) => setKey(tool, (event.target as HTMLSelectElement).value),
            },
            h('option', { value: '' }, `Default key${defaultKey ? ` (${defaultKey.name})` : ''}`),
            keys.map((key) => h('option', { value: key.id }, `${key.name} (${key.masked})`)),
          );
    if (keyCell instanceof HTMLSelectElement) keyCell.value = pinnedKey ?? '';

    const model = binding.model;
    const fallback = capabilityDefault(settings, capability).model;
    return h(
      'tr',
      { 'data-testid': `tool-row-${tool.id}` },
      h(
        'th',
        { scope: 'row', class: 'fw-normal' },
        h(
          'a',
          { class: 'd-inline-flex align-items-center gap-2 text-nowrap', href: toolUrl(tool.id) },
          icon(tool.icon, 'text-primary-emphasis'),
          tool.name,
        ),
      ),
      h('td', { class: 'or-tool-key' }, keyCell),
      h(
        'td',
        { class: 'or-tool-model' },
        h(
          'div',
          { class: 'd-flex align-items-center gap-2' },
          h(
            'div',
            { class: 'min-w-0 flex-grow-1', 'data-testid': 'tool-model' },
            model
              ? h('span', { class: 'font-monospace small text-break' }, model)
              : h(
                  'span',
                  { class: 'small' },
                  h(
                    'span',
                    { class: 'text-body-secondary' },
                    `Default for ${CAPABILITY_INFO[capability].title.toLowerCase()}`,
                  ),
                  h(
                    'span',
                    { class: 'd-block font-monospace text-body-secondary text-break' },
                    fallback,
                  ),
                ),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary text-nowrap',
              'aria-label': `Choose the model for ${tool.name}`,
              'data-testid': 'tool-model-change',
              'data-focus-key': `tool:${tool.id}:model`,
              onclick: () =>
                void chooseModel(tool).catch((error: unknown) => void presentError(error)),
            },
            'Change',
          ),
        ),
      ),
      h(
        'td',
        { class: 'text-end' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary',
            'aria-label': `Reset ${tool.name} to the default key and model`,
            title: 'Reset to defaults',
            disabled: !binding.keyId && !binding.model,
            'data-testid': 'tool-reset',
            'data-focus-key': `tool:${tool.id}:reset`,
            onclick: () => reset(tool),
          },
          icon('arrow-counterclockwise'),
        ),
      ),
    );
  };

  const render = (): void => rerender(body, tools.map(row));

  const element = card(
    {
      title: 'Key and model per tool',
      icon: 'tools',
      text: 'Pin a key or a model to one tool; everything else follows the defaults. A tool’s own model chip sets the same thing.',
      testId: 'tool-bindings',
    },
    dataTable({
      scrollerLabel: 'Key and model per tool',
      class: 'table align-middle mb-0 or-bindings',
      head: ['Tool', 'Key', 'Model', h('span', { class: 'visually-hidden' }, 'Reset')],
      numericFrom: 3,
      body,
    }),
  );

  core.settings.subscribe((next, prev) => {
    if (
      JSON.stringify(next.tools) !== JSON.stringify(prev.tools) ||
      JSON.stringify(next.defaultModels) !== JSON.stringify(prev.defaultModels) ||
      next.defaultKeyId !== prev.defaultKeyId
    ) {
      render();
    }
  });
  core.keys.subscribe(render);
  render();
  return { element };
}
