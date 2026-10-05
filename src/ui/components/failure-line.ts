/**
 * `failureLine(failure)`: an inline failure (an item, a part, a panel) as text, from `failureText(error)` or a
 * `runItems` outcome's `failure`. After an unknown outcome it adds the link to OpenRouter's activity page, and in
 * blind mode the shared note, so every tool words "this may have been billed" the same way.
 *
 * ```ts
 * row.append(failureLine(outcome.failure!, { testId: 'ocr-page-error' }));
 * ```
 */
import { h } from '../dom';
import type { FailureText } from '../feedback/errors';
import { externalLink } from './external-link';

export interface FailureLineOptions {
  /** Classes of the wrapper; default a small danger-coloured line. */
  className?: string;
  testId?: string;
  /** Test id of the activity link; default `<testId>-activity` (or none without `testId`). */
  activityTestId?: string;
}

export function failureLine(failure: FailureText, options: FailureLineOptions = {}): HTMLElement {
  const link = failure.activityUrl
    ? externalLink(failure.activityUrl, 'OpenRouter activity')
    : null;
  const activityId =
    options.activityTestId ?? (options.testId ? `${options.testId}-activity` : undefined);
  if (link && activityId) link.dataset.testid = activityId;
  return h(
    'div',
    { class: options.className ?? 'small text-danger-emphasis', 'data-testid': options.testId },
    failure.text,
    failure.note ? ` ${failure.note}` : null,
    link ? ' ' : null,
    link,
  );
}
