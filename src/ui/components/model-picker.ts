/**
 * `modelPicker()`: a modal to choose a model for one capability. Favourites and recently used models come first
 * (`settings.models.favourites` / `recent`), every row shows the free badge or price, context size and id, and a
 * star toggles the favourite (persisted at once). The list honours free-only mode (`models.forCapability`).
 * Resolves the chosen model id, or null when cancelled.
 *
 * ```ts
 * const id = await modelPicker(core, { capability: 'text', selected: current });
 * ```
 */
import type { Capability, CoreServices, ModelInfo } from '../../core/types';
import { CAPABILITY_LABELS } from '../../core/models/defaults';
import { h, replace } from '../dom';
import { presentError } from '../feedback/errors';
import { openModal } from '../feedback/modal';
import { formatContext, formatModelPrice } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { rank } from '../shell/palette-search';
import { settingsUrl } from '../shell/links';
import { emptyState } from './empty-state';

export interface ModelPickerOptions {
  capability: Capability;
  /** The current choice, marked in the list. */
  selected?: string | null;
  title?: string;
}

const MAX_ROWS = 80;

export function modelPicker(
  core: CoreServices,
  options: ModelPickerOptions,
): Promise<string | null> {
  let chosen: string | null = null;
  let models: ModelInfo[] | null = null;
  const searchId = uid('model-search');
  const capabilityLabel = CAPABILITY_LABELS[options.capability];

  const search = h('input', {
    id: searchId,
    type: 'search',
    class: 'form-control',
    placeholder: 'Search by name, provider or id',
    autocomplete: 'off',
    spellcheck: false,
    'data-testid': 'model-search',
  });
  const results = h('div', { class: 'or-model-results', 'data-testid': 'model-results' });
  const status = h('div', { class: 'visually-hidden', role: 'status' });

  const isFavourite = (id: string): boolean => core.settings.get().models.favourites.includes(id);

  const toggleFavourite = (model: ModelInfo, button: HTMLButtonElement): void => {
    const next = !isFavourite(model.id);
    try {
      core.settings.update((draft) => {
        draft.models.favourites = next
          ? [...draft.models.favourites, model.id]
          : draft.models.favourites.filter((id) => id !== model.id);
      });
    } catch (error) {
      void presentError(error);
      return;
    }
    button.setAttribute('aria-pressed', String(next));
    button.replaceChildren(icon(next ? 'star-fill' : 'star'));
    status.textContent = next
      ? `${model.name} added to favourites.`
      : `${model.name} removed from favourites.`;
  };

  const row = (model: ModelInfo): HTMLElement => {
    const selected = model.id === options.selected;
    const favourite = isFavourite(model.id);
    const context = formatContext(model.contextLength);
    const star = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-link or-star',
        'aria-pressed': String(favourite),
        'aria-label': `Favourite: ${model.name}`,
        'data-testid': 'model-favourite',
        onclick: () => toggleFavourite(model, star),
      },
      icon(favourite ? 'star-fill' : 'star'),
    );
    return h(
      'div',
      { class: ['list-group-item d-flex align-items-center gap-2 p-0', selected && 'or-selected'] },
      h(
        'button',
        {
          type: 'button',
          class: 'or-model-option btn text-start flex-grow-1 min-w-0 px-3 py-2',
          'aria-current': selected ? 'true' : null,
          'data-testid': `model-option-${model.id}`,
          onclick: () => {
            chosen = model.id;
            modal.hide();
          },
        },
        h(
          'span',
          { class: 'd-flex align-items-center gap-2' },
          h('span', { class: 'fw-semibold text-truncate' }, model.name),
          model.isFree && h('span', { class: 'badge rounded-pill text-bg-success' }, 'Free'),
          selected && h('span', { class: 'badge rounded-pill text-bg-primary' }, 'Current'),
        ),
        h(
          'span',
          { class: 'd-block small text-body-secondary text-truncate' },
          [model.isFree ? null : formatModelPrice(model), context, model.id]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      star,
    );
  };

  const section = (title: string, items: ModelInfo[]): HTMLElement[] =>
    items.length === 0
      ? []
      : [
          h('h3', { class: 'or-section-label mt-3 mb-2' }, title),
          h('div', { class: 'list-group' }, items.map(row)),
        ];

  const render = (): void => {
    if (!models) return;
    const settings = core.settings.get();
    if (models.length === 0) {
      results.replaceChildren(
        emptyState({
          icon: 'cpu',
          title: settings.freeOnly
            ? `No free ${capabilityLabel} models`
            : `No ${capabilityLabel} models`,
          text: settings.freeOnly
            ? 'Free-only mode is on, and OpenRouter has no free model for this yet.'
            : 'The model catalog has none for this capability right now.',
          action: settings.freeOnly
            ? h(
                'a',
                { class: 'btn btn-outline-primary btn-sm', href: settingsUrl('models') },
                'Free-only settings',
              )
            : undefined,
          compact: true,
          testId: 'model-empty',
        }),
      );
      status.textContent = 'No models available.';
      return;
    }
    const query = search.value.trim();
    if (query) {
      const matches = rank(
        models.map((model) => ({
          label: model.name,
          detail: model.id,
          keywords: model.author,
          model,
        })),
        query,
      ).map((entry) => entry.model);
      if (matches.length === 0) {
        results.replaceChildren(
          emptyState({
            icon: 'search',
            title: `No models match “${query}”`,
            compact: true,
            testId: 'model-empty',
          }),
        );
      } else {
        replace(
          results,
          ...section('Matches', matches.slice(0, MAX_ROWS)),
          matches.length > MAX_ROWS
            ? h(
                'p',
                { class: 'small text-body-secondary mt-2 mb-0' },
                `Showing ${MAX_ROWS} of ${matches.length}. Keep typing to narrow it down.`,
              )
            : null,
        );
      }
      status.textContent = `${matches.length} models found.`;
      return;
    }
    const byId = new Map(models.map((model) => [model.id, model]));
    const pick = (ids: readonly string[]): ModelInfo[] =>
      ids.map((id) => byId.get(id)).filter((model): model is ModelInfo => model !== undefined);
    const favourites = pick(settings.models.favourites);
    const recent = pick(settings.models.recent).filter((model) => !isFavourite(model.id));
    const shownIds = new Set([...favourites, ...recent].map((model) => model.id));
    const rest = [...models]
      .filter((model) => !shownIds.has(model.id))
      .sort((a, b) => Number(b.isFree) - Number(a.isFree) || a.name.localeCompare(b.name));
    replace(
      results,
      ...section('Favourites', favourites),
      ...section('Recently used', recent),
      ...section('All models', rest.slice(0, MAX_ROWS)),
      rest.length > MAX_ROWS
        ? h(
            'p',
            { class: 'small text-body-secondary mt-2 mb-0' },
            `Showing ${MAX_ROWS} of ${rest.length}. Search to find the others.`,
          )
        : null,
    );
    status.textContent = `${models.length} models.`;
  };

  const skeleton = (): HTMLElement =>
    h(
      'div',
      { class: 'list-group placeholder-glow mt-3', 'aria-hidden': 'true' },
      [0, 1, 2, 3, 4].map(() =>
        h(
          'div',
          { class: 'list-group-item py-3' },
          h('span', { class: 'placeholder col-5 d-block mb-2' }),
          h('span', { class: 'placeholder placeholder-sm col-8 d-block' }),
        ),
      ),
    );

  const load = (): void => {
    results.replaceChildren(skeleton());
    status.textContent = 'Loading models…';
    core.models
      .forCapability(options.capability)
      .then((list) => {
        models = list;
        render();
      })
      .catch(() => {
        results.replaceChildren(
          emptyState({
            icon: 'wifi-off',
            title: 'The model list could not be loaded',
            text: 'Check your connection and try again.',
            action: h(
              'button',
              { type: 'button', class: 'btn btn-sm btn-outline-primary', onclick: load },
              'Try again',
            ),
            compact: true,
            testId: 'model-error',
          }),
        );
        status.textContent = 'The model list could not be loaded.';
      });
  };

  search.addEventListener('input', render);
  // Arrow keys move between the choices (the star buttons stay reachable with Tab).
  const moveFocus = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const choices = [...results.querySelectorAll<HTMLButtonElement>('.or-model-option')];
    if (choices.length === 0) return;
    const index = choices.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      index === -1
        ? event.key === 'ArrowDown'
          ? 0
          : choices.length - 1
        : Math.min(choices.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    choices[next]?.focus();
    event.preventDefault();
  };

  const modal = openModal({
    title: options.title ?? `Choose a ${capabilityLabel} model`,
    icon: 'cpu',
    size: 'lg',
    scrollable: true,
    body: [
      h('label', { class: 'visually-hidden', htmlFor: searchId }, 'Search models'),
      h('div', { class: 'or-sticky-search' }, search),
      results,
      status,
    ],
    footer: [
      h('a', { class: 'btn btn-link me-auto', href: settingsUrl('models') }, 'Default models'),
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Cancel',
      ),
    ],
    initialFocus: search,
    testId: 'model-picker',
  });
  modal.body.addEventListener('keydown', moveFocus);
  load();
  return modal.closed.then(() => chosen);
}
