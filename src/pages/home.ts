/**
 * Home: search first (filters the tools as you type; Enter opens the best match; `/` focuses it), the first-run
 * onboarding, Favourites (starred tools), the five latest runs, then every tool by category. A tool card shows
 * a "Free" badge when its primary capability currently resolves to a free model.
 */
import type { RunRecord, Settings } from '../core/types';
import { getTool, tools } from '../tools/registry';
import { TOOL_CATEGORIES, type ToolId, type ToolManifest } from '../tools/types';
import { emptyState } from '../ui/components/empty-state';
import { type Child, h, replace } from '../ui/dom';
import { announce } from '../ui/feedback/announce';
import { presentError } from '../ui/feedback/errors';
import { modalOpen } from '../ui/feedback/modal';
import { formatDateTime, formatRelativeTime, formatUsd, plural } from '../ui/format';
import { icon } from '../ui/icon';
import { uid } from '../ui/id';
import { mountPage } from '../ui/shell/index';
import { CATEGORY_INFO, historyUrl, toolUrl } from '../ui/shell/links';
import { togglePalette } from '../ui/shell/palette';
import { rank } from '../ui/shell/palette-search';
import { onboarding } from './onboarding';

mountPage({ title: 'ORtoolbox', nav: 'home', header: false }, ({ core, main, navigate }) => {
  const searchId = uid('tool-search');
  const search = h('input', {
    id: searchId,
    type: 'search',
    class: 'form-control form-control-lg or-search-input',
    placeholder: `Search ${tools.length} tools, e.g. “transcribe” or “invoice”`,
    autocomplete: 'off',
    spellcheck: false,
    'aria-keyshortcuts': '/',
    'data-testid': 'home-search',
  });

  const isFavourite = (id: ToolId): boolean => core.settings.get().favouriteTools.includes(id);
  const toggleFavourite = (tool: ToolManifest): void => {
    try {
      core.settings.update((draft) => {
        draft.favouriteTools = draft.favouriteTools.includes(tool.id)
          ? draft.favouriteTools.filter((id) => id !== tool.id)
          : [...draft.favouriteTools, tool.id];
      });
      announce(
        isFavourite(tool.id)
          ? `${tool.name} added to favourites.`
          : `${tool.name} removed from favourites.`,
      );
    } catch (error) {
      void presentError(error);
    }
  };

  const isFreeTool = (tool: ToolManifest): boolean => {
    const model = core.models.resolve(tool.id, tool.capabilities[0]!).model;
    return model !== null && core.models.isFree(model);
  };

  const card = (tool: ToolManifest, testPrefix: string): HTMLElement => {
    const starred = isFavourite(tool.id);
    return h(
      'div',
      { class: 'col' },
      h(
        'div',
        {
          class: 'card h-100 shadow-sm or-tool-card',
          'data-testid': `${testPrefix}card-${tool.id}`,
        },
        h(
          'div',
          { class: 'card-body d-flex gap-3 align-items-start' },
          h('div', { class: 'or-icon-tile', 'aria-hidden': 'true' }, icon(tool.icon)),
          h(
            'div',
            { class: 'min-w-0 flex-grow-1 pe-4' },
            h(
              'h3',
              { class: 'h6 mb-1 d-flex align-items-center gap-2' },
              h(
                'a',
                {
                  class: 'stretched-link or-tool-link',
                  href: toolUrl(tool.id),
                  'data-testid': `${testPrefix}tool-link-${tool.id}`,
                },
                tool.name,
              ),
              isFreeTool(tool)
                ? h(
                    'span',
                    { class: 'badge rounded-pill text-bg-success', 'data-testid': 'free-badge' },
                    'Free',
                  )
                : null,
            ),
            h('p', { class: 'small text-body-secondary mb-0' }, tool.description),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-link or-star or-card-star',
            'aria-pressed': String(starred),
            'aria-label': `Favourite: ${tool.name}`,
            title: starred ? 'Remove from favourites' : 'Add to favourites',
            // Re-rendering a grid gives focus back to the same tool's star (see replace() in dom.ts).
            'data-focus-key': `star-${tool.id}`,
            'data-testid': `star-${tool.id}`,
            onclick: () => toggleFavourite(tool),
          },
          icon(starred ? 'star-fill' : 'star'),
        ),
      ),
    );
  };

  const grid = (list: readonly ToolManifest[], testPrefix = ''): HTMLElement =>
    h(
      'div',
      { class: 'row row-cols-1 row-cols-sm-2 row-cols-xl-3 g-3' },
      list.map((tool) => card(tool, testPrefix)),
    );

  const sectionHeading = (
    id: string,
    iconName: string,
    title: string,
    extra?: Child,
  ): HTMLElement =>
    h(
      'div',
      { class: 'd-flex align-items-center gap-2 mb-3' },
      h(
        'h2',
        { id, class: 'or-section-title mb-0 d-flex align-items-center gap-2' },
        icon(iconName, 'text-primary-emphasis'),
        title,
      ),
      extra && h('div', { class: 'ms-auto' }, extra),
    );

  // --- sections -----------------------------------------------------------------------------------------
  const onboardingSlot = h('div');
  const favourites = h('section', {
    class: 'mb-5',
    'aria-labelledby': 'favourites-title',
    'data-testid': 'favourites',
  });
  const recent = h('section', {
    class: 'mb-5',
    'aria-labelledby': 'recent-title',
    'data-testid': 'recent-runs',
  });
  const categories = h('div', { 'data-testid': 'categories' });
  const results = h('section', {
    class: 'mb-5',
    'aria-labelledby': 'results-title',
    hidden: true,
    'data-testid': 'search-results',
  });
  const resultCount = h('div', { class: 'visually-hidden', role: 'status' });

  const renderFavourites = (): void => {
    const list = core.settings.get().favouriteTools.map(getTool);
    replace(
      favourites,
      sectionHeading('favourites-title', 'star', 'Favourites'),
      list.length > 0
        ? grid(list, 'fav-')
        : emptyState({
            icon: 'star',
            title: 'No favourites yet',
            text: 'Star the tools you use most and they stay right here.',
            inline: true,
            testId: 'favourites-empty',
          }),
    );
  };

  const runRow = (run: RunRecord): HTMLElement => {
    const tool = getTool(run.tool);
    // "Free" only for runs on free models; a failed paid run that cost nothing shows $0.00.
    const allFree = run.models.length > 0 && run.models.every((model) => core.models.isFree(model));
    const cost =
      run.status === 'running'
        ? 'Running'
        : run.usage.costUnknown
          ? 'Cost unknown'
          : run.usage.costUsd === 0 && allFree
            ? 'Free'
            : formatUsd(run.usage.costUsd);
    return h(
      'a',
      {
        class: 'list-group-item list-group-item-action d-flex align-items-center gap-3 py-3',
        href: toolUrl(run.tool, { run: run.id }),
        'data-testid': 'recent-run',
      },
      h('span', { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' }, icon(tool.icon)),
      h(
        'span',
        { class: 'min-w-0 flex-grow-1' },
        h('span', { class: 'd-block fw-semibold text-truncate' }, run.title),
        h(
          'span',
          { class: 'd-block small text-body-secondary' },
          tool.name,
          ' · ',
          h(
            'time',
            {
              dateTime: new Date(run.startedAt).toISOString(),
              title: formatDateTime(run.startedAt),
            },
            formatRelativeTime(run.startedAt),
          ),
        ),
      ),
      run.status === 'error'
        ? h('span', { class: 'badge rounded-pill text-bg-danger' }, 'Failed')
        : null,
      h('span', { class: 'small text-body-secondary text-nowrap' }, cost),
    );
  };

  let recentGeneration = 0;
  const renderRecent = (): void => {
    const mine = ++recentGeneration;
    const heading = sectionHeading(
      'recent-title',
      'clock-history',
      'Recent runs',
      h('a', { class: 'small', href: historyUrl() }, 'All history'),
    );
    if (recent.childElementCount === 0) {
      recent.replaceChildren(
        heading,
        h(
          'div',
          { class: 'list-group shadow-sm placeholder-glow', 'aria-hidden': 'true' },
          [0, 1].map(() =>
            h(
              'div',
              { class: 'list-group-item py-3' },
              h('span', { class: 'placeholder col-6 d-block mb-2' }),
              h('span', { class: 'placeholder placeholder-sm col-3 d-block' }),
            ),
          ),
        ),
      );
    }
    core.history
      .query({ limit: 5 })
      .then((runs) => {
        if (mine !== recentGeneration) return;
        recent.replaceChildren(
          heading,
          runs.length > 0
            ? h('div', { class: 'list-group shadow-sm' }, runs.map(runRow))
            : emptyState({
                icon: 'clock-history',
                title: 'No runs yet',
                text: 'Your latest runs appear here, ready to reopen with their prompt and settings.',
                inline: true,
                testId: 'recent-empty',
              }),
        );
      })
      .catch(() => {
        // Replace the skeleton for good (hiding it would let the search bring it back).
        if (mine !== recentGeneration) return;
        recent.replaceChildren(
          heading,
          emptyState({
            icon: 'exclamation-triangle',
            title: 'Recent runs could not be loaded',
            text: 'Browser storage is unavailable right now. Your tools still work.',
            inline: true,
            testId: 'recent-error',
          }),
        );
      });
  };

  const renderCategories = (): void => {
    replace(
      categories,
      ...TOOL_CATEGORIES.map((category) => {
        const id = `category-${category}-title`;
        return h(
          'section',
          { class: 'mb-5', 'aria-labelledby': id, 'data-testid': `category-${category}` },
          sectionHeading(id, CATEGORY_INFO[category].icon, CATEGORY_INFO[category].label),
          grid(tools.filter((tool) => tool.category === category)),
        );
      }),
    );
  };

  let matches: ToolManifest[] = [];
  const applySearch = (): void => {
    const query = search.value.trim();
    const searching = query !== '';
    for (const section of [onboardingSlot, favourites, recent, categories])
      section.hidden = searching;
    results.hidden = !searching;
    if (!searching) {
      matches = [];
      resultCount.textContent = '';
      return;
    }
    matches = rank(
      tools.map((tool) => ({
        label: tool.name,
        detail: tool.description,
        keywords: `${tool.category} ${tool.capabilities.join(' ')}`,
        tool,
      })),
      query,
    ).map((entry) => entry.tool);
    replace(
      results,
      h(
        'h2',
        { id: 'results-title', class: 'or-section-title mb-3' },
        matches.length > 0 ? `${plural(matches.length, 'tool')} found` : 'No tools found',
      ),
      matches.length > 0
        ? grid(matches, 'result-')
        : h(
            'div',
            { class: 'card shadow-sm' },
            emptyState({
              icon: 'search',
              title: `No tool matches “${query}”`,
              text: 'Try another word, or search runs, models and settings too.',
              action: h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-outline-primary btn-sm',
                  onclick: () => togglePalette(core),
                },
                'Search everything',
              ),
              compact: true,
              testId: 'search-empty',
            }),
          ),
    );
    resultCount.textContent =
      matches.length > 0
        ? `${plural(matches.length, 'tool')} found. Press Enter to open ${matches[0]!.name}.`
        : 'No tools found.';
  };

  search.addEventListener('input', applySearch);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && matches[0]) {
      event.preventDefault();
      void navigate(toolUrl(matches[0].id));
    } else if (event.key === 'Escape' && search.value) {
      search.value = '';
      applySearch();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    )
      return;
    if (modalOpen()) return;
    event.preventDefault();
    search.focus();
  });

  const showOnboarding = (): void => {
    const wizard = onboarding(core, { navigate, onClose: () => search.focus() });
    onboardingSlot.replaceChildren(wizard ?? '');
  };

  main.append(
    h(
      'div',
      { class: 'or-hero mb-5' },
      h('h1', { class: 'or-hero-title mb-2', 'data-testid': 'page-title' }, 'ORtoolbox'),
      h(
        'p',
        { class: 'or-hero-lead text-body-secondary mb-4' },
        'AI tools that run in your browser on your own OpenRouter key. What you run goes to OpenRouter and the model provider; your history, settings and keys stay here.',
      ),
      h(
        'div',
        { class: 'or-hero-search position-relative', role: 'search' },
        h('label', { class: 'visually-hidden', htmlFor: searchId }, 'Search tools'),
        icon('search', 'or-search-icon'),
        search,
        h('kbd', { class: 'or-kbd or-search-kbd d-none d-md-inline', 'aria-hidden': 'true' }, '/'),
      ),
      resultCount,
    ),
    onboardingSlot,
    results,
    favourites,
    recent,
    categories,
  );

  showOnboarding();
  renderFavourites();
  renderRecent();
  renderCategories();

  /** Anything that changes a card (star, Free badge) re-renders all grids; replace() keeps focus. */
  const affectsCards = (next: Readonly<Settings>, prev: Readonly<Settings>): boolean =>
    next.freeOnly !== prev.freeOnly ||
    JSON.stringify(next.defaultModels) !== JSON.stringify(prev.defaultModels) ||
    JSON.stringify(next.tools) !== JSON.stringify(prev.tools);

  core.settings.subscribe((next, prev) => {
    const favouritesChanged = next.favouriteTools.join() !== prev.favouriteTools.join();
    if (favouritesChanged || affectsCards(next, prev)) {
      // A star un-starred inside Favourites disappears with its card: continue on that tool's other star.
      const focused = document.activeElement;
      const key =
        focused instanceof HTMLElement && favourites.contains(focused)
          ? focused.closest('[data-focus-key]')?.getAttribute('data-focus-key')
          : null;
      renderFavourites();
      renderCategories();
      if (search.value.trim()) applySearch();
      if (key && !main.contains(document.activeElement)) {
        [...categories.querySelectorAll<HTMLElement>('[data-focus-key]')]
          .find((candidate) => candidate.getAttribute('data-focus-key') === key)
          ?.focus();
      }
    }
    if (next.onboarding.completed !== prev.onboarding.completed && !next.onboarding.completed)
      showOnboarding();
  });
  core.history.subscribe(renderRecent);
});
