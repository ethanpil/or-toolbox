/**
 * Showing validation messages without repeating them: both the situation and the question builder re-check their
 * fields as the user edits, and `setFieldError` announces every message it is given, so a message that is
 * already on show is left alone.
 */
import { setFieldError } from '../../ui/feedback/field-error';

/** `setFieldError`, skipped when `feedback` already says exactly this (unless focus is wanted). */
export function showProblem(
  input: HTMLElement,
  feedback: HTMLElement,
  message: string | null,
  options: { focus?: boolean } = {},
): void {
  if ((message ?? '') === feedback.textContent && !options.focus) return;
  setFieldError(input, feedback, message, options);
}

/**
 * A message for a whole list ("Add at least 2 options"): there is no field to mark, so it is a live alert of its
 * own, shown while it has text. Unchanged text is not set again (an alert would read it again).
 */
export function showListProblem(alert: HTMLElement, message: string | null): void {
  const text = message ?? '';
  if (alert.textContent === text) return;
  alert.textContent = text;
  alert.hidden = text === '';
}
