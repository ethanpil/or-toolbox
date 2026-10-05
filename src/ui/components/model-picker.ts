/**
 * `modelPicker()`: a modal to choose a model for one capability. Favorites and recently used models come first
 * (`settings.models.favorites` / `recent`), every row shows the free badge or price, context size and id, and a
 * star toggles the favorite (persisted at once). The list honours free-only mode (`models.forCapability`).
 * Resolves the chosen model id, or null when cancelled.
 *
 * ```ts
 * const id = await modelPicker(core, { capability: 'text', selected: current });
 * ```
 */
import { CAPABILITY_INFO } from '../../core/models/capabilities';
import type { Capability, CoreServices, ModelInfo } from '../../core/types';
import { debounce, SEARCH_DEBOUNCE_MS } from '../../core/util';
import { h, replace } from '../dom';
import { openModal } from '../feedback/modal';
import { formatContext, formatModelPrice } from '../format';
import { uid } from '../id';
import { toggleFavoriteModel } from '../settings-actions';
import { rankBy, type SearchItem } from '../shell/palette-search';
import { settingsUrl } from '../shell/links';
import { emptyState } from './empty-state';
import { listSkeleton, loadInto } from './load-into';
import { setStarred, starButton } from './star-button';

export interface ModelPickerOptions {
  capability: Capability;
  /** The current choice, marked in the list. */
  selected?: string | null;
  title?: string;
}

const MAX_ROWS = 80;

/** What the search box matches in a model: the name, then the id, then the author. */
const searchable = (model: ModelInfo): SearchItem => ({
  label: model.name,
  detail: model.id,
  keywords: model.author,
});

export function modelPicker(
  core: CoreServices,
  options: ModelPickerOptions,
): Promise<string | null> {
  let chosen: string | null = null;
  let models: ModelInfo[] | null = null;
  const searchId = uid('model-search');
  const capabilityLabel = CAPABILITY_INFO[options.capability].label;
  const help = CAPABILITY_INFO[options.capability].help;
  const helpId = uid('model-help');

  const search = h('input', {
    id: searchId,
    type: 'search',
    class: 'form-control',
    placeholder: 'Search by name, provider or id',
    'aria-describedby': help ? helpId : null,
    autocomplete: 'off',
    spellcheck: false,
    'data-testid': 'model-search',
  });
  const results = h('div', { class: 'or-model-results', 'data-testid': 'model-results' });
  const status = h('div', { class: 'visually-hidden', role: 'status' });

  const isFavorite = (id: string): boolean => core.settings.get().models.favorites.includes(id);

  const toggleFavorite = (model: ModelInfo, button: HTMLButtonElement): void => {
    const next = toggleFavoriteModel(core, model.id);
    if (next === null) return;
    setStarred(button, next);
    status.textContent = next
      ? `${model.name} added to favorites.`
      : `${model.name} removed from favorites.`;
  };

  const row = (model: ModelInfo): HTMLElement => {
    const selected = model.id === options.selected;
    const favorite = isFavorite(model.id);
    const context = formatContext(model.contextLength);
    const star = starButton({
      pressed: favorite,
      label: `Favorite: ${model.name}`,
      testId: 'model-favorite',
      onToggle: () => toggleFavorite(model, star),
    });
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
      const matches = rankBy(models, query, searchable);
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
    const favorites = pick(settings.models.favorites);
    const recent = pick(settings.models.recent).filter((model) => !isFavorite(model.id));
    const shownIds = new Set([...favorites, ...recent].map((model) => model.id));
    const rest = [...models]
      .filter((model) => !shownIds.has(model.id))
      .sort((a, b) => Number(b.isFree) - Number(a.isFree) || a.name.localeCompare(b.name));
    replace(
      results,
      ...section('Favorites', favorites),
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

  const load = (): void => {
    void loadInto(
      results,
      async () => {
        models = await core.models.forCapability(options.capability);
        render();
      },
      {
        skeleton: listSkeleton(5, 'list-group mt-3'),
        status: (text) => (status.textContent = text),
        messages: { loading: 'Loading models…', failed: 'The model list could not be loaded.' },
        error: {
          icon: 'wifi-off',
          title: 'The model list could not be loaded',
          text: 'Check your connection and try again.',
          compact: true,
          testId: 'model-error',
        },
        retry: load,
      },
    );
  };

  /** True while typed text has not been searched yet. */
  let stale = false;
  const renderSoon = debounce(() => {
    stale = false;
    render();
  }, SEARCH_DEBOUNCE_MS);
  search.addEventListener('input', () => {
    stale = true;
    renderSoon();
  });
  // Arrow keys move between the choices (the star buttons stay reachable with Tab).
  const moveFocus = (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    // Typing straight into an arrow key must act on the results of what was typed, not on the ones before.
    if (stale) {
      renderSoon.cancel();
      stale = false;
      render();
    }
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
      help &&
        h(
          'p',
          { id: helpId, class: 'form-text mt-2 mb-0', 'data-testid': 'model-picker-help' },
          help,
        ),
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
  return modal.closed.then(() => {
    renderSoon.cancel();
    return chosen;
  });
}
