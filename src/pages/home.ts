import { boot } from '../core/boot';
import { url } from '../core/paths';
import { toolsInCategory } from '../tools/registry';
import { TOOL_CATEGORIES, type ToolCategory } from '../tools/types';
import { h } from '../ui/dom';
import { placeholder, renderStubPage } from '../ui/stub';

const CATEGORY_NAMES: Record<ToolCategory, string> = {
  documents: 'Documents',
  audio: 'Audio',
  images: 'Images',
  video: 'Video',
  reasoning: 'Reasoning',
};

boot();
renderStubPage(
  'ORtoolbox',
  h('p', { class: 'lead' }, 'AI tools that run in your browser, on your own OpenRouter key.'),
  placeholder('Stage 2'),
  TOOL_CATEGORIES.map((category) =>
    h(
      'section',
      { class: 'mb-4', 'data-testid': `category-${category}` },
      h('h2', { class: 'h5' }, CATEGORY_NAMES[category]),
      h(
        'div',
        { class: 'list-group' },
        toolsInCategory(category).map((tool) =>
          h(
            'a',
            {
              class: 'list-group-item list-group-item-action d-flex gap-3',
              href: url(`tools/${tool.id}/`),
              'data-testid': `tool-link-${tool.id}`,
            },
            h('i', { class: `bi bi-${tool.icon} fs-4`, 'aria-hidden': 'true' }),
            h(
              'span',
              null,
              h('span', { class: 'd-block fw-semibold' }, tool.name),
              h('span', { class: 'd-block text-body-secondary' }, tool.description),
            ),
          ),
        ),
      ),
    ),
  ),
);
