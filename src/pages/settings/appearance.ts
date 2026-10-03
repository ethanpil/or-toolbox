/**
 * Settings → Appearance: theme, accent colour (picker, presets, reset, preview), density and reduced motion.
 * This section only writes `settings.appearance`; the shell (src/ui/shell/appearance.ts) applies every change
 * live, here and in other tabs.
 */
import { parseHex } from '../../ui/shell/accent';
import type { CoreServices, Settings, ThemeMode } from '../../core/types';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { card, saveSettings, type SectionView, segmented, switchField } from './ui';

/** The shipped primary colour (src/styles/_variables.scss). */
export const DEFAULT_ACCENT = '#4f46e5';

const PRESETS: readonly { name: string; hex: string }[] = [
  { name: 'Indigo', hex: DEFAULT_ACCENT },
  { name: 'Blue', hex: '#2563eb' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Green', hex: '#15803d' },
  { name: 'Orange', hex: '#c2410c' },
  { name: 'Pink', hex: '#db2777' },
  { name: 'Purple', hex: '#7c3aed' },
  { name: 'Slate', hex: '#475569' },
];

type Density = Settings['appearance']['density'];

export function appearanceSection(core: CoreServices): SectionView {
  const appearance = (): Settings['appearance'] => core.settings.get().appearance;

  /** Saves the accent; when that fails, the controls go back to the colour in force. */
  const setAccent = (hex: string | null): boolean => {
    const value = hex === null || hex.toLowerCase() === DEFAULT_ACCENT ? null : hex.toLowerCase();
    if (value !== null && !parseHex(value)) return false;
    const saved = saveSettings(core, (draft) => {
      draft.appearance.accent = value;
    });
    if (!saved) sync();
    return saved;
  };

  const theme = segmented<ThemeMode>({
    legend: 'Theme',
    value: appearance().theme,
    options: [
      { value: 'light', label: 'Light', icon: 'sun', testId: 'theme-option-light' },
      { value: 'dark', label: 'Dark', icon: 'moon-stars', testId: 'theme-option-dark' },
      { value: 'system', label: 'System', icon: 'circle-half', testId: 'theme-option-system' },
    ],
    onChange: (value) => {
      const saved = saveSettings(core, (draft) => {
        draft.appearance.theme = value;
      });
      if (!saved) theme.set(appearance().theme);
    },
  });

  // Accent: the colour input writes while it is dragged (debounced), presets and Reset at once.
  let accentTimer: ReturnType<typeof setTimeout> | null = null;
  const accentId = uid('accent');
  const accentInput = h('input', {
    type: 'color',
    id: accentId,
    class: 'form-control form-control-color',
    value: appearance().accent ?? DEFAULT_ACCENT,
    'data-testid': 'accent-input',
    oninput: () => {
      if (accentTimer !== null) clearTimeout(accentTimer);
      accentTimer = setTimeout(() => setAccent(accentInput.value), 120);
    },
    onchange: () => {
      if (accentTimer !== null) clearTimeout(accentTimer);
      setAccent(accentInput.value);
    },
  });
  const presetButtons = PRESETS.map((preset) =>
    h(
      'button',
      {
        type: 'button',
        class: 'or-accent-preset',
        style: { backgroundColor: preset.hex },
        title: preset.name,
        'aria-label': preset.hex === DEFAULT_ACCENT ? `${preset.name} (default)` : preset.name,
        'data-testid': `accent-preset-${preset.name.toLowerCase()}`,
        dataset: { hex: preset.hex },
        onclick: () => {
          if (setAccent(preset.hex)) announce(`Accent colour: ${preset.name}.`);
        },
      },
      icon('check-lg'),
    ),
  );
  const resetAccent = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-testid': 'accent-reset',
      onclick: () => {
        if (setAccent(null)) announce('Accent colour reset to the default indigo.');
      },
    },
    icon('arrow-counterclockwise', 'me-1'),
    'Reset',
  );
  const accentValue = h('span', { class: 'font-monospace small', 'data-testid': 'accent-value' });

  const density = segmented<Density>({
    legend: 'Density',
    value: appearance().density,
    options: [
      {
        value: 'comfortable',
        label: 'Comfortable',
        icon: 'arrows-expand',
        testId: 'density-comfortable',
      },
      { value: 'compact', label: 'Compact', icon: 'arrows-collapse', testId: 'density-compact' },
    ],
    onChange: (value) => {
      const saved = saveSettings(core, (draft) => {
        draft.appearance.density = value;
      });
      if (!saved) density.set(appearance().density);
    },
  });

  const motion = switchField({
    label: 'Reduce motion',
    help: 'Turns off animations and page transitions. Your system’s reduced-motion setting always applies too.',
    checked: appearance().reducedMotion,
    testId: 'reduced-motion',
    onChange: (checked, input) => {
      const saved = saveSettings(core, (draft) => {
        draft.appearance.reducedMotion = checked;
      });
      if (!saved) input.checked = !checked;
    },
  });

  const sync = (): void => {
    const current = appearance();
    theme.set(current.theme);
    density.set(current.density);
    motion.input.checked = current.reducedMotion;
    const accent = current.accent ?? DEFAULT_ACCENT;
    if (document.activeElement !== accentInput) accentInput.value = accent;
    accentValue.textContent = current.accent ? accent : `${DEFAULT_ACCENT} (default)`;
    resetAccent.disabled = current.accent === null;
    for (const button of presetButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.hex === accent));
    }
  };

  const element = card(
    {
      title: 'Look and feel',
      icon: 'palette',
      text: 'Changes apply at once, on every open page.',
      testId: 'appearance',
    },
    h(
      'div',
      { class: 'vstack gap-4' },
      theme.element,
      h(
        'div',
        null,
        h('label', { class: 'form-label fw-semibold', htmlFor: accentId }, 'Accent colour'),
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-3' },
          accentInput,
          h(
            'div',
            { class: 'd-flex flex-wrap gap-2', role: 'group', 'aria-label': 'Preset colours' },
            presetButtons,
          ),
          resetAccent,
        ),
        h(
          'div',
          {
            class: 'or-accent-preview d-flex flex-wrap align-items-center gap-3 mt-3 p-3 rounded-3',
            'data-testid': 'accent-preview',
          },
          h('span', { class: 'or-accent-swatch', 'aria-hidden': 'true' }),
          h('span', { class: 'small text-body-secondary' }, 'Preview: ', accentValue),
          h('span', { class: 'btn btn-sm btn-primary pe-none', 'aria-hidden': 'true' }, 'Button'),
          h(
            'span',
            { class: 'badge rounded-pill text-bg-primary', 'aria-hidden': 'true' },
            'Badge',
          ),
          h('span', { class: 'or-preview-link small', 'aria-hidden': 'true' }, 'Link'),
        ),
        h(
          'div',
          { class: 'form-text' },
          'Text on buttons and links switches between light and dark to stay readable on any colour.',
        ),
      ),
      density.element,
      motion.element,
    ),
  );

  core.settings.subscribe((next, prev) => {
    if (JSON.stringify(next.appearance) !== JSON.stringify(prev.appearance)) sync();
  });
  sync();
  return { element };
}
