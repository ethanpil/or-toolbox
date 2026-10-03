import { type Child, h } from '../dom';
import { uid } from '../id';

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
