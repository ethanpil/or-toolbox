/**
 * `setFieldError(input, feedback, message)`: the one way a form field shows (or clears) an error. It sets
 * Bootstrap's `is-invalid`, `aria-invalid`, links the message with `aria-describedby` (keeping any existing
 * descriptions) and announces it assertively, so screen-reader users hear what is wrong without hunting for it.
 *
 * ```ts
 * const feedback = h('div', { class: 'invalid-feedback' });
 * setFieldError(input, feedback, 'Enter a name.'); // show
 * setFieldError(input, feedback, null);            // clear
 * setFieldError(input, feedback, 'Enter a name.', { focus: true }); // show and move focus to the field
 * ```
 *
 * With `focus`, the field takes the focus and a screen reader reads the message with it (it is in
 * `aria-describedby`), so it is announced only when the focus was already in the field: never twice. A caller
 * that may show the same message again (a repeated submit) keeps what is on show and skips the call, as
 * `numberField` does, so an unchanged error is not announced again.
 */
import { uid } from '../id';
import { announce } from './announce';

export function setFieldError(
  input: HTMLElement,
  feedback: HTMLElement,
  message: string | null,
  options: { focus?: boolean } = {},
): void {
  if (!feedback.id) feedback.id = uid('field-error');
  const described = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!described.includes(feedback.id)) {
    input.setAttribute('aria-describedby', [...described, feedback.id].join(' '));
  }
  if (message === null || message === '') {
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    feedback.textContent = '';
    return;
  }
  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  feedback.textContent = message;
  if (options.focus && document.activeElement !== input) {
    input.focus();
    // Read out with the field as it takes the focus (unless it could not).
    if (document.activeElement === input) return;
  }
  announce(message, { assertive: true });
}
