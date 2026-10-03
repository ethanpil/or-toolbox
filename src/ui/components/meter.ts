import { h } from '../dom';

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
