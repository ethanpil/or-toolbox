/**
 * Building blocks shared by the Settings sections: cards, switches, validated number fields, radio cards,
 * progress meters, settings writes, and re-rendering that keeps keyboard focus. Plain Bootstrap markup through
 * h(); the look follows the Privacy page (cards with an icon-tile heading).
 */
import type { CoreServices, Settings } from '../../core/types';
import { type Child, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { MIN_PASSPHRASE_LENGTH, type Parsed, passphraseStrength } from './logic';

/** What a section module returns: its body, and what to do whenever its panel is shown (lazy loads). */
export interface SectionView {
  element: HTMLElement;
  onShow?: () => void;
}

/** Applies a settings change; shows the error (e.g. storage full) and returns false when it fails. */
export function saveSettings(core: CoreServices, mutate: (draft: Settings) => void): boolean {
  try {
    core.settings.update(mutate);
    return true;
  } catch (error) {
    void presentError(error);
    return false;
  }
}

/** Runs a synchronous write (keys service); errors go through presentError. */
export function attempt(action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    void presentError(error);
    return false;
  }
}

export interface RerenderOptions {
  /**
   * Where focus goes when the control that had it is gone or cannot take focus any more (now disabled). Gets
   * that control's `data-focus` key (null without one).
   */
  fallback?: (lostKey: string | null) => HTMLElement | null | undefined;
}

/**
 * Replaces the children of `container` and gives focus back to the element that had it, matched by
 * `data-focus` (or else `data-testid`), or else to `options.fallback`, so live re-renders never throw keyboard
 * users back to the top of the page.
 */
export function rerender(
  container: HTMLElement,
  content?: Child,
  options: RerenderOptions = {},
): void {
  const active = document.activeElement;
  const hadFocus = active instanceof HTMLElement && container.contains(active);
  const byFocusKey = hadFocus && active.dataset.focus !== undefined;
  const key = hadFocus ? (active.dataset.focus ?? active.dataset.testid ?? null) : null;
  replace(container, content);
  if (!hadFocus) return;
  const target = key
    ? container.querySelector<HTMLElement>(
        `[${byFocusKey ? 'data-focus' : 'data-testid'}="${CSS.escape(key)}"]`,
      )
    : null;
  target?.focus();
  if (target && document.activeElement === target) return;
  options.fallback?.(byFocusKey ? key : null)?.focus();
}

/** Focuses a Settings section's heading (`#<section>-title`, focusable by script). */
export function focusSectionHeading(section: string): void {
  document.getElementById(`${section}-title`)?.focus();
}

export interface CardOptions {
  title: string;
  icon?: string;
  /** One muted sentence under the title. */
  text?: Child;
  /** Buttons on the right of the title. */
  actions?: Child;
  testId?: string;
}

/**
 * A settings card: an `<h3>` with an icon tile, a muted lead, then the body. The heading takes focus from
 * script (`tabIndex -1`), as the place to land when the control that had focus disappears.
 */
export function card(options: CardOptions, ...body: Child[]): HTMLElement {
  const titleId = uid('card-title');
  return h(
    'section',
    { class: 'card shadow-sm mb-4', 'aria-labelledby': titleId, 'data-testid': options.testId },
    h(
      'div',
      { class: 'card-body p-4' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-start gap-3 mb-3' },
        h(
          'div',
          { class: 'flex-grow-1 min-w-0' },
          h(
            'h3',
            { id: titleId, class: 'h5 d-flex align-items-center gap-2 mb-1', tabIndex: -1 },
            options.icon &&
              h(
                'span',
                { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' },
                icon(options.icon),
              ),
            options.title,
          ),
          options.text && h('p', { class: 'text-body-secondary mb-0' }, options.text),
        ),
        options.actions && h('div', { class: 'd-flex flex-wrap gap-2' }, options.actions),
      ),
      body,
    ),
  );
}

/** A link that opens in a new tab and says so to screen readers. */
export function externalLink(href: string, text: string, className?: string): HTMLElement {
  return h(
    'a',
    { href, target: '_blank', rel: 'noopener noreferrer', class: className },
    text,
    h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'),
  );
}

export interface SwitchOptions {
  label: Child;
  help?: Child;
  checked: boolean;
  testId: string;
  onChange: (checked: boolean, input: HTMLInputElement) => void;
}

/** A Bootstrap switch with its label and help text wired up. */
export function switchField(options: SwitchOptions): {
  element: HTMLElement;
  input: HTMLInputElement;
} {
  const id = uid('switch');
  const helpId = options.help ? uid('switch-help') : undefined;
  const input = h('input', {
    id,
    type: 'checkbox',
    role: 'switch',
    class: 'form-check-input',
    'aria-describedby': helpId,
    'data-testid': options.testId,
    checked: options.checked,
    onchange: () => options.onChange(input.checked, input),
  });
  const element = h(
    'div',
    { class: 'form-check form-switch' },
    input,
    h('label', { class: 'form-check-label fw-semibold', htmlFor: id }, options.label),
    options.help && h('div', { id: helpId, class: 'form-text mt-1' }, options.help),
  );
  return { element, input };
}

export interface FieldOptions<T> {
  label: Child;
  help?: Child;
  /** Shown in an input-group before the field, e.g. `$`. */
  prefix?: string;
  /** Shown after the field, e.g. `days`. */
  suffix?: string;
  placeholder?: string;
  inputMode?: 'decimal' | 'numeric';
  testId: string;
  /** Extra classes on the wrapper (e.g. a max width). */
  className?: string;
  parse: (text: string) => Parsed<T>;
  /**
   * Called with a valid value when the field is committed (change: blur or Enter). Return false when it could
   * not be saved: the field then keeps what the user typed.
   */
  onCommit: (value: T) => boolean | void;
}

export interface Field {
  element: HTMLElement;
  input: HTMLInputElement;
  /**
   * Shows a stored value, unless the user is editing the field or left text in it that was not saved (invalid,
   * or the save failed): that is never silently replaced.
   */
  sync(text: string): void;
  /** Replaces the label's content (e.g. a key's name and colour after a rename). */
  setLabel(label: Child): void;
}

/**
 * A text field for numbers with Bootstrap validation, checked as the user types: invalid input is marked
 * (`is-invalid`, the message in `invalid-feedback`, `aria-invalid`), the message is announced once each time it
 * changes, and nothing invalid is saved; a valid value is committed on change.
 */
export function numberField<T>(options: FieldOptions<T>): Field {
  const id = uid('field');
  const helpId = options.help ? uid('field-help') : null;
  const feedbackId = uid('field-feedback');
  const feedback = h('div', { id: feedbackId, class: 'invalid-feedback' });
  const input = h('input', {
    id,
    type: 'text',
    class: 'form-control',
    inputMode: options.inputMode ?? 'decimal',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: options.placeholder ?? '',
    'aria-describedby': [helpId, feedbackId].filter(Boolean).join(' '),
    'data-testid': options.testId,
  });

  const setInvalid = (message: string | null): void => {
    input.classList.toggle('is-invalid', message !== null);
    if (message === null) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
    feedback.textContent = message ?? '';
  };

  /** Text the user typed that is not saved yet. */
  let dirty = false;
  let announced: string | null = null;
  const validate = (): Parsed<T> => {
    const parsed = options.parse(input.value);
    if (parsed.ok) {
      setInvalid(null);
      announced = null;
    } else {
      setInvalid(parsed.error);
      if (announced !== parsed.error) announce(parsed.error, { assertive: true });
      announced = parsed.error;
    }
    return parsed;
  };

  input.addEventListener('input', () => {
    dirty = true;
    validate();
  });
  input.addEventListener('change', () => {
    const parsed = validate();
    if (parsed.ok && options.onCommit(parsed.value) !== false) dirty = false;
  });

  const control =
    options.prefix || options.suffix
      ? h(
          'div',
          { class: 'input-group has-validation' },
          options.prefix && h('span', { class: 'input-group-text' }, options.prefix),
          input,
          options.suffix && h('span', { class: 'input-group-text' }, options.suffix),
          feedback,
        )
      : [input, feedback];

  const label = h('label', { class: 'form-label fw-semibold', htmlFor: id }, options.label);
  const element = h(
    'div',
    { class: options.className },
    label,
    control,
    helpId && h('div', { id: helpId, class: 'form-text' }, options.help),
  );

  return {
    element,
    input,
    sync(text) {
      if (document.activeElement === input || dirty) return;
      input.value = text;
      setInvalid(null);
      announced = null;
    },
    setLabel(content) {
      replace(label, content);
    },
  };
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  icon?: string;
  /** A sentence under the label (radio cards only). */
  description?: string;
  testId: string;
}

export interface ChoiceGroup<T extends string> {
  element: HTMLElement;
  set(value: T): void;
}

/**
 * A radio group as cards (a title and a sentence each), inside a fieldset with a legend. Arrow keys move
 * between the options, as with any radio group.
 */
export function radioCards<T extends string>(options: {
  legend: string;
  legendHidden?: boolean;
  options: readonly ChoiceOption<T>[];
  value: T;
  columns?: string;
  onChange: (value: T) => void;
}): ChoiceGroup<T> {
  const name = uid('choice');
  const inputs = options.options.map((option) => {
    const id = uid('choice-option');
    const descriptionId = option.description ? uid('choice-description') : undefined;
    const input = h('input', {
      id,
      type: 'radio',
      name,
      class: 'form-check-input',
      value: option.value,
      'aria-describedby': descriptionId,
      'data-testid': option.testId,
      checked: option.value === options.value,
      onchange: () => {
        if (input.checked) options.onChange(option.value);
      },
    });
    const cardElement = h(
      'div',
      { class: 'col' },
      h(
        'div',
        { class: 'form-check or-radio-card h-100' },
        input,
        h(
          'label',
          { class: 'form-check-label d-block', htmlFor: id },
          h(
            'span',
            { class: 'd-flex align-items-center gap-2 fw-semibold' },
            option.icon && icon(option.icon),
            option.label,
          ),
          option.description &&
            h(
              'span',
              { id: descriptionId, class: 'd-block small text-body-secondary mt-1' },
              option.description,
            ),
        ),
      ),
    );
    return { input, cardElement };
  });
  const element = h(
    'fieldset',
    null,
    h(
      'legend',
      { class: ['form-label fw-semibold fs-6', options.legendHidden && 'visually-hidden'] },
      options.legend,
    ),
    h(
      'div',
      { class: ['row g-2', options.columns ?? 'row-cols-1 row-cols-md-3'] },
      inputs.map((entry) => entry.cardElement),
    ),
  );
  return {
    element,
    set(value) {
      for (const { input } of inputs) input.checked = input.value === value;
    },
  };
}

/** A compact segmented choice (Bootstrap `btn-check` radios in a button group). */
export function segmented<T extends string>(options: {
  legend: string;
  options: readonly ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): ChoiceGroup<T> {
  const name = uid('segment');
  const inputs = options.options.map((option) => {
    const id = uid('segment-option');
    const input = h('input', {
      id,
      type: 'radio',
      name,
      class: 'btn-check',
      autocomplete: 'off',
      value: option.value,
      'data-testid': option.testId,
      checked: option.value === options.value,
      onchange: () => {
        if (input.checked) options.onChange(option.value);
      },
    });
    return {
      input,
      parts: [
        input,
        h(
          'label',
          {
            class: 'btn btn-outline-primary d-inline-flex align-items-center gap-2',
            htmlFor: id,
          },
          option.icon && icon(option.icon),
          option.label,
        ),
      ],
    };
  });
  const element = h(
    'fieldset',
    null,
    h('legend', { class: 'form-label fw-semibold fs-6' }, options.legend),
    h(
      'div',
      { class: 'btn-group flex-wrap' },
      inputs.map((entry) => entry.parts),
    ),
  );
  return {
    element,
    set(value) {
      for (const { input } of inputs) input.checked = input.value === value;
    },
  };
}

/** A labelled progress bar (`role=progressbar` with a text value), coloured by tone. */
export function meter(options: {
  percent: number;
  tone: 'success' | 'warning' | 'danger' | 'primary';
  label: string;
  text: string;
  testId?: string;
}): HTMLElement {
  return h(
    'div',
    { 'data-testid': options.testId },
    h(
      'div',
      {
        class: 'progress or-settings-meter',
        role: 'progressbar',
        'aria-label': options.label,
        'aria-valuenow': options.percent,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuetext': options.text,
      },
      h('div', {
        class: ['progress-bar', `bg-${options.tone}`],
        style: { width: `${options.percent}%` },
      }),
    ),
    h(
      'div',
      {
        class: 'small text-body-secondary mt-1',
        'data-testid': options.testId && `${options.testId}-text`,
      },
      options.text,
    ),
  );
}

export interface PassphraseInput {
  element: HTMLElement;
  input: HTMLInputElement;
  invalid(message: string | null): void;
  /** Empties the field, its error and its strength meter. */
  clear(): void;
}

/** A password field for a passphrase, optionally with a strength meter (logic.ts `passphraseStrength`). */
export function passphraseInput(options: {
  label: string;
  autocomplete: 'new-password' | 'current-password';
  testId: string;
  strength?: boolean;
  help?: string;
}): PassphraseInput {
  const id = uid('passphrase');
  const feedbackId = uid('passphrase-feedback');
  const strengthId = uid('passphrase-strength');
  const helpId = uid('passphrase-help');
  const feedback = h('div', { id: feedbackId, class: 'invalid-feedback' });
  const input = h('input', {
    id,
    type: 'password',
    class: 'form-control',
    autocomplete: options.autocomplete,
    spellcheck: false,
    'aria-describedby': [feedbackId, options.help && helpId, options.strength && strengthId]
      .filter(Boolean)
      .join(' '),
    'data-testid': options.testId,
  });
  const strengthBar = h('div', { class: 'progress-bar' });
  const strengthText = h('span', { 'data-testid': `${options.testId}-strength` });
  const strengthHint = h('span', { class: 'text-body-secondary' });
  const strength = options.strength
    ? h(
        'div',
        { id: strengthId, class: 'mt-2 small' },
        h('div', { class: 'progress or-strength', 'aria-hidden': 'true' }, strengthBar),
        h('div', { class: 'mt-1' }, 'Strength: ', strengthText, ' · ', strengthHint),
      )
    : null;
  const updateStrength = (): void => {
    const result = passphraseStrength(input.value);
    const tones = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];
    strengthBar.className = `progress-bar ${tones[result.score]}`;
    strengthBar.style.width = `${input.value ? Math.max(10, result.score * 25) : 0}%`;
    strengthText.textContent = input.value ? result.label : '—';
    strengthHint.textContent = result.hint;
  };
  const invalid = (message: string | null): void => {
    input.classList.toggle('is-invalid', message !== null);
    if (message === null) input.removeAttribute('aria-invalid');
    else input.setAttribute('aria-invalid', 'true');
    feedback.textContent = message ?? '';
  };
  input.addEventListener('input', () => {
    if (options.strength) updateStrength();
    if (input.classList.contains('is-invalid')) invalid(null);
  });
  if (options.strength) updateStrength();
  return {
    element: h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: id }, options.label),
      input,
      feedback,
      options.help && h('div', { id: helpId, class: 'form-text' }, options.help),
      strength,
    ),
    input,
    invalid,
    clear() {
      input.value = '';
      invalid(null);
      if (options.strength) updateStrength();
    },
  };
}

/** Checks a new passphrase and its confirmation; marks the fields and returns false when they fail. */
export function validNewPassphrase(next: PassphraseInput, confirm: PassphraseInput): boolean {
  if (next.input.value.length < MIN_PASSPHRASE_LENGTH) {
    next.invalid(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    next.input.focus();
    return false;
  }
  if (confirm.input.value !== next.input.value) {
    confirm.invalid('The passphrases do not match.');
    confirm.input.focus();
    return false;
  }
  return true;
}

/**
 * A button's busy state while `work` runs (PBKDF2 takes a moment on purpose; imports read files). Disabling
 * drops the button's focus, so it gets focus back afterwards unless `work` moved it elsewhere.
 */
export async function busy(button: HTMLButtonElement, work: () => Promise<void>): Promise<void> {
  const label = [...button.childNodes];
  const hadFocus = document.activeElement === button;
  button.disabled = true;
  button.replaceChildren(
    h('span', { class: 'spinner-border spinner-border-sm me-2', 'aria-hidden': 'true' }),
    'Working…',
  );
  try {
    await work();
  } finally {
    button.disabled = false;
    button.replaceChildren(...label);
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (hadFocus && lost && button.isConnected) button.focus();
  }
}

/** The muted "loading" line used while a section reads its numbers. */
export function loadingLine(text: string): HTMLElement {
  return h(
    'span',
    { class: 'd-inline-flex align-items-center gap-2 text-body-secondary small' },
    h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }),
    text,
  );
}
