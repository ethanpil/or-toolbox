/**
 * Promise-based dialogs on top of `openModal()`:
 *
 * - `confirmDialog()` → true/false. Destructive ones (`tone: 'danger'`) focus Cancel first.
 * - `typedConfirm()` → true only after the user typed `phrase` (for "Delete all", "Reset everything").
 * - `promptDialog()` → the entered text, or null when cancelled.
 *
 * Every dialog resolves exactly once, also when dismissed with Escape, the close button or the backdrop.
 */
import { type Child, h } from '../dom';
import { uid } from '../id';
import { setFieldError } from './field-error';
import { openModal, type Tone } from './modal';

export interface ConfirmOptions {
  title: string;
  message: Child;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: Tone;
  icon?: string;
  testId?: string;
}

const TONE_ICONS: Partial<Record<Tone, string>> = {
  danger: 'exclamation-octagon',
  warning: 'exclamation-triangle',
  primary: 'question-circle',
};

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const tone = options.tone ?? 'primary';
  let result = false;
  const cancel = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary',
      'data-bs-dismiss': 'modal',
      'data-testid': 'dialog-cancel',
    },
    options.cancelLabel ?? 'Cancel',
  );
  const confirm = h(
    'button',
    {
      type: 'button',
      class: `btn btn-${tone === 'danger' ? 'danger' : 'primary'}`,
      'data-testid': 'dialog-confirm',
      onclick: () => {
        result = true;
        modal.hide();
      },
    },
    options.confirmLabel ?? 'Confirm',
  );
  const modal = openModal({
    title: options.title,
    icon: options.icon ?? TONE_ICONS[tone],
    tone,
    body:
      typeof options.message === 'string'
        ? h('p', { class: 'mb-0' }, options.message)
        : options.message,
    footer: [cancel, confirm],
    initialFocus: tone === 'danger' ? cancel : confirm,
    testId: options.testId ?? 'confirm-dialog',
  });
  return modal.closed.then(() => result);
}

export interface TypedConfirmOptions {
  title: string;
  message: Child;
  /** What the user must type, e.g. `delete everything`. Compared case-insensitively, trimmed. */
  phrase: string;
  confirmLabel?: string;
  testId?: string;
}

export function typedConfirm(options: TypedConfirmOptions): Promise<boolean> {
  let result = false;
  const inputId = uid('typed-confirm');
  const matches = (): boolean => input.value.trim().toLowerCase() === options.phrase.toLowerCase();
  const confirm = h(
    'button',
    { type: 'submit', class: 'btn btn-danger', disabled: true, 'data-testid': 'dialog-confirm' },
    options.confirmLabel ?? 'Delete',
  );
  const input = h('input', {
    id: inputId,
    type: 'text',
    class: 'form-control',
    autocomplete: 'off',
    spellcheck: false,
    'data-testid': 'typed-confirm-input',
    oninput: () => {
      confirm.disabled = !matches();
    },
  });
  const form = h(
    'form',
    {
      onsubmit: (event: Event) => {
        event.preventDefault();
        if (!matches()) return;
        result = true;
        modal.hide();
      },
    },
    typeof options.message === 'string' ? h('p', null, options.message) : options.message,
    h(
      'label',
      { class: 'form-label', htmlFor: inputId },
      'Type ',
      h('strong', { class: 'user-select-all' }, options.phrase),
      ' to confirm',
    ),
    input,
  );
  const modal = openModal({
    title: options.title,
    icon: 'exclamation-octagon',
    tone: 'danger',
    body: form,
    footer: [
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Cancel',
      ),
      confirm,
    ],
    initialFocus: input,
    testId: options.testId ?? 'typed-confirm-dialog',
  });
  // The submit button lives in the footer, outside the form: wire it to the form explicitly.
  form.id = uid('typed-confirm-form');
  confirm.setAttribute('form', form.id);
  return modal.closed.then(() => result);
}

export interface PromptOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  help?: string;
  confirmLabel?: string;
  /** Empty input is refused unless false. */
  required?: boolean;
  maxLength?: number;
  icon?: string;
  testId?: string;
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  let result: string | null = null;
  const inputId = uid('prompt-input');
  const helpId = options.help ? uid('prompt-help') : undefined;
  const input = h('input', {
    id: inputId,
    type: 'text',
    class: 'form-control',
    placeholder: options.placeholder ?? '',
    maxLength: options.maxLength ?? 200,
    required: options.required !== false,
    autocomplete: 'off',
    'aria-describedby': helpId,
    'data-testid': 'prompt-input',
    value: options.value ?? '',
  });
  const feedback = h('div', { class: 'invalid-feedback' });
  input.addEventListener('input', () => {
    if (input.classList.contains('is-invalid')) setFieldError(input, feedback, null);
  });
  const formId = uid('prompt-form');
  const form = h(
    'form',
    {
      id: formId,
      noValidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (options.required !== false && !value) {
          setFieldError(input, feedback, 'Enter a value.');
          input.focus();
          return;
        }
        result = value;
        modal.hide();
      },
    },
    h('label', { class: 'form-label', htmlFor: inputId }, options.label),
    input,
    feedback,
    options.help && h('div', { class: 'form-text', id: helpId }, options.help),
  );
  const save = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', 'data-testid': 'dialog-confirm' },
    options.confirmLabel ?? 'Save',
  );
  // The footer is outside the form; the `form` attribute makes the button submit it.
  save.setAttribute('form', formId);
  const modal = openModal({
    title: options.title,
    icon: options.icon,
    body: form,
    footer: [
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Cancel',
      ),
      save,
    ],
    initialFocus: input,
    testId: options.testId ?? 'prompt-dialog',
  });
  modal.element.addEventListener('shown.bs.modal', () => input.select());
  return modal.closed.then(() => result);
}
