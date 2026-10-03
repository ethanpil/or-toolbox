/**
 * TEMPORARY — the stand-in instance for tools that are not built yet. Each tool's builder replaces
 * `mountTool(getTool(id), comingSoon)` in src/tools/<id>/main.ts with the real setup; delete this file when the
 * last tool is built. It keeps the framework honest meanwhile: the header, chips, Prompts panel, Settings drawer,
 * drop zone and drop/paste overlay all work on every tool page.
 */
import { dropZone } from '../components/drop-zone';
import { emptyState } from '../components/empty-state';
import { append, h } from '../dom';
import { uid } from '../id';
import type { ToolContext, ToolInstance } from './types';

export function comingSoon(ctx: ToolContext): ToolInstance {
  const { manifest, ui } = ctx;
  const promptId = uid('prompt');
  const prompt = h('textarea', {
    id: promptId,
    class: 'form-control',
    rows: 6,
    placeholder: 'What should it do?',
    'data-testid': 'stub-prompt',
  });
  const files = h('ul', {
    class: 'list-unstyled small mb-0',
    'aria-label': 'Added files',
    'data-testid': 'stub-files',
  });
  const addFiles = (list: File[]): void => {
    files.append(...list.map((file) => h('li', null, file.name)));
  };

  append(
    ui.input,
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: promptId }, 'Prompt'),
      prompt,
    ),
    manifest.accepts.length > 0
      ? dropZone({ accept: manifest.accepts, multiple: true, onFiles: addFiles, compact: true })
      : null,
    files,
  );
  ui.runner({ run: () => Promise.resolve() }).setDisabled('Coming in a later stage');
  ui.output.append(
    emptyState({
      icon: 'cone-striped',
      title: `${manifest.name} is coming soon`,
      text: 'This tool arrives in a later stage. The prompts panel, settings drawer and model picker already work.',
      testId: 'coming-soon',
    }),
  );
  ui.drawer.append(
    h('p', { class: 'text-body-secondary mb-0' }, 'Settings for this tool arrive with it.'),
  );

  return {
    getState: () => ({ prompt: prompt.value, settings: {} }),
    applyState: (state) => {
      prompt.value = state.prompt;
    },
    onFiles: addFiles,
    sample: () => {
      prompt.value = `A sample for ${manifest.name}.`;
    },
  };
}
