/**
 * First-run onboarding, inline at the top of Home while `settings.onboarding.completed` is false:
 * (1) connect OpenRouter or paste a key, with an optional free-only switch; (2) pick favourite tools;
 * (3) try a sample (opens a tool with `?sample=1`). "Skip setup" on any step ends it for good; so does
 * finishing. The current step is kept in `settings.ui['home.onboardingStep']`, so the OAuth round trip (which
 * leaves the page) comes back to the right place.
 */
import type { CoreServices } from '../core/types';
import { url } from '../core/paths';
import { getTool, tools } from '../tools/registry';
import type { ToolId } from '../tools/types';
import { connectKey } from '../ui/components/connect-key';
import { switchField } from '../ui/components/switch-field';
import { type Child, h, replace } from '../ui/dom';
import { toast } from '../ui/feedback/toast';
import { icon } from '../ui/icon';
import { uid } from '../ui/id';
import { saveSettings } from '../ui/settings-actions';
import { settingsUrl, toolUrl } from '../ui/shell/links';

const STEP_KEY = 'home.onboardingStep';
const SUGGESTED: readonly ToolId[] = ['chat', 'ocr', 'text-to-speech'];

export interface OnboardingOptions {
  navigate: (href: string) => Promise<boolean>;
  /** Called after the wizard removed itself (finished or skipped). */
  onClose: () => void;
}

export function onboarding(core: CoreServices, options: OnboardingOptions): HTMLElement | null {
  if (core.settings.get().onboarding.completed) return null;

  const headingId = uid('onboarding-title');
  const body = h('div', { 'data-testid': 'onboarding-step' });
  const progress = h('ol', {
    class: 'or-steps list-unstyled d-flex gap-2 mb-0',
    'aria-label': 'Setup progress',
  });
  const element = h(
    'section',
    {
      class: 'card shadow-sm or-onboarding mb-5 or-fade-in',
      'aria-labelledby': headingId,
      'data-testid': 'onboarding',
    },
    h(
      'div',
      { class: 'card-body p-4 p-lg-5' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-3 mb-4' },
        h('div', { class: 'or-icon-tile', 'aria-hidden': 'true' }, icon('rocket-takeoff')),
        h(
          'div',
          { class: 'flex-grow-1' },
          h('h2', { id: headingId, class: 'h4 mb-0' }, 'Get started in three steps'),
          h(
            'p',
            { class: 'text-body-secondary mb-0' },
            'About a minute. Your key stays in this browser and is sent only to OpenRouter.',
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-link text-body-secondary',
            'data-testid': 'onboarding-skip',
            onclick: () => finish(true),
          },
          'Skip setup',
        ),
      ),
      progress,
      body,
    ),
  );

  const savedStep = core.settings.get().ui[STEP_KEY];
  let step = savedStep === 2 || savedStep === 3 ? savedStep : 1;
  /** The favourites being picked; read from the settings each time step 2 opens (they may have changed). */
  let picked = new Set<ToolId>();

  const persistStep = (next: number): void => {
    // Storage full: the wizard still works for this visit, so say nothing.
    saveSettings(
      core,
      (draft) => {
        draft.ui[STEP_KEY] = next;
      },
      { onError: () => undefined },
    );
  };

  const go = (next: number): void => {
    step = next;
    persistStep(next);
    render();
    body.querySelector<HTMLElement>('h3')?.focus();
  };

  function finish(skipped: boolean): void {
    const saved = saveSettings(core, (draft) => {
      draft.onboarding.completed = true;
      delete draft.ui[STEP_KEY];
    });
    if (!saved) return;
    element.remove();
    options.onClose();
    toast(
      skipped
        ? {
            message: 'Setup skipped. Add a key any time in Settings → Keys.',
            action: { label: 'Keys', href: settingsUrl('keys') },
          }
        : { message: 'You are all set.', variant: 'success' },
    );
  }

  const stepTitle = (text: string): HTMLElement =>
    h('h3', { class: 'h5 mb-3', tabIndex: -1 }, text);
  const footer = (...buttons: Child[]): HTMLElement =>
    h('div', { class: 'd-flex flex-wrap gap-2 mt-4' }, buttons);

  let nextButton: HTMLButtonElement | null = null;
  const stepConnect = (): Child[] => {
    const key = core.keys.resolve();
    const freeOnly = switchField({
      label: 'Use free models only',
      help: 'Free models cost nothing but are rate-limited, and some tools (images, video, music, transcription) have none.',
      checked: core.settings.get().freeOnly,
      testId: 'onboarding-free-only',
      onChange: (checked, input) => {
        const saved = saveSettings(core, (draft) => {
          draft.freeOnly = checked;
        });
        if (!saved) input.checked = !checked;
      },
    });
    return [
      stepTitle('Connect OpenRouter'),
      key
        ? h(
            'div',
            {
              class: 'alert alert-success d-flex align-items-center gap-2',
              'data-testid': 'onboarding-connected',
            },
            icon('check-circle-fill'),
            h(
              'div',
              null,
              'Connected with the key ',
              h('strong', null, key.name),
              ` (${key.masked}).`,
            ),
          )
        : h(
            'div',
            { class: 'or-connect' },
            connectKey({
              returnTo: url(),
              // connectKey announces the result; then show the connected state and move on to Next, so
              // focus does not drop to the page when the form is replaced.
              onAdded: () =>
                setTimeout(() => {
                  render();
                  nextButton?.focus();
                }, 600),
            }),
          ),
      h('div', { class: 'mt-4' }, freeOnly.element),
      footer(
        (nextButton = h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            'data-testid': 'onboarding-next',
            onclick: () => go(2),
          },
          key ? 'Next' : 'Continue without a key',
          icon('arrow-right', 'ms-2'),
        )),
      ),
    ];
  };

  const stepFavourites = (): Child[] => {
    picked = new Set<ToolId>(core.settings.get().favouriteTools);
    const count = h('span', { class: 'text-body-secondary small', role: 'status' });
    const updateCount = (): void => {
      count.textContent = `${picked.size} picked`;
    };
    const grid = h(
      'div',
      {
        class: 'row row-cols-2 row-cols-md-3 row-cols-xl-4 g-2',
        role: 'group',
        'aria-label': 'Tools',
      },
      tools.map((tool) => {
        const button: HTMLButtonElement = h(
          'button',
          {
            type: 'button',
            class: [
              'btn or-pick w-100 h-100 d-flex align-items-center gap-2 text-start',
              picked.has(tool.id) && 'active',
            ],
            'aria-pressed': String(picked.has(tool.id)),
            'data-testid': `pick-tool-${tool.id}`,
            onclick: () => {
              if (picked.has(tool.id)) picked.delete(tool.id);
              else picked.add(tool.id);
              const on = picked.has(tool.id);
              button.setAttribute('aria-pressed', String(on));
              button.classList.toggle('active', on);
              updateCount();
            },
          },
          icon(tool.icon, 'fs-5'),
          h('span', { class: 'small fw-semibold' }, tool.name),
        );
        return h('div', { class: 'col' }, button);
      }),
    );
    updateCount();
    return [
      stepTitle('Pick your favourite tools'),
      h(
        'p',
        { class: 'text-body-secondary' },
        'Choose three or so. They are pinned at the top of this page.',
      ),
      grid,
      footer(
        h(
          'button',
          { type: 'button', class: 'btn btn-outline-secondary', onclick: () => go(1) },
          icon('arrow-left', 'me-2'),
          'Back',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            'data-testid': 'onboarding-next',
            onclick: () => {
              const saved = saveSettings(core, (draft) => {
                draft.favouriteTools = [...picked];
              });
              if (saved) go(3);
            },
          },
          'Next',
          icon('arrow-right', 'ms-2'),
        ),
        count,
      ),
    ];
  };

  const stepSample = (): Child[] => {
    const favourites = core.settings.get().favouriteTools;
    const suggestions = (favourites.length > 0 ? favourites : SUGGESTED).slice(0, 3).map(getTool);
    return [
      stepTitle('Try a sample'),
      h(
        'p',
        { class: 'text-body-secondary' },
        'Open a tool with an example already filled in, then press Run.',
      ),
      h(
        'div',
        { class: 'row row-cols-1 row-cols-md-3 g-3' },
        suggestions.map((tool) =>
          h(
            'div',
            { class: 'col' },
            h(
              'button',
              {
                type: 'button',
                class: 'btn or-pick w-100 h-100 text-start p-3',
                'data-testid': `try-${tool.id}`,
                onclick: () => {
                  finish(false);
                  void options.navigate(toolUrl(tool.id, { sample: '1' }));
                },
              },
              h(
                'span',
                { class: 'd-flex align-items-center gap-2 fw-semibold mb-1' },
                icon(tool.icon, 'fs-5'),
                `Try ${tool.name}`,
              ),
              h('span', { class: 'd-block small text-body-secondary' }, tool.description),
            ),
          ),
        ),
      ),
      footer(
        h(
          'button',
          { type: 'button', class: 'btn btn-outline-secondary', onclick: () => go(2) },
          icon('arrow-left', 'me-2'),
          'Back',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            'data-testid': 'onboarding-finish',
            onclick: () => finish(false),
          },
          'Finish',
        ),
      ),
    ];
  };

  function render(): void {
    const labels = ['Connect', 'Favourites', 'Try it'];
    progress.replaceChildren(
      ...labels.map((label, index) => {
        const number = index + 1;
        return h(
          'li',
          {
            class: [
              'or-step flex-fill',
              number < step && 'is-done',
              number === step && 'is-current',
            ],
            'aria-current': number === step ? 'step' : null,
          },
          h('span', { class: 'or-step-bar', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'small' },
            h('span', { class: 'visually-hidden' }, `Step ${number} of 3: `),
            label,
          ),
        );
      }),
    );
    replace(body, step === 1 ? stepConnect() : step === 2 ? stepFavourites() : stepSample());
    body.classList.add('mt-4');
  }

  render();
  return element;
}
