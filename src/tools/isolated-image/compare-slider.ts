/**
 * `compareSlider()`: a before/after wipe. Both images are fitted into one square frame; the "after" image shows
 * to the right of a divider, the "before" image to the left. The divider follows a real range input (Arrow keys,
 * Page Up/Down, Home/End, and the screen reader's own gestures) and a drag on the frame.
 *
 * Kept in the tool folder until a second tool needs it.
 */
import { h } from '../../ui/dom';
import { uid } from '../../ui/id';

export interface CompareSliderOptions {
  before: { src: string; alt: string; label: string };
  after: { src: string; alt: string; label: string };
  /** Accessible name of the range. */
  label: string;
  /** Divider position in percent from the left. Default 50. */
  value?: number;
  testId?: string;
}

export interface CompareSlider {
  readonly element: HTMLElement;
  readonly range: HTMLInputElement;
  /** Swaps the images (the divider stays where it is). */
  setImages(images: {
    before?: { src: string; alt: string };
    after?: { src: string; alt: string };
  }): void;
}

export function compareSlider(options: CompareSliderOptions): CompareSlider {
  const rangeId = uid('compare');
  const before = h('img', {
    class: 'or-compare-img',
    src: options.before.src,
    alt: options.before.alt,
    draggable: false,
    'data-testid': 'compare-before',
  });
  const after = h('img', {
    class: 'or-compare-img or-compare-after',
    src: options.after.src,
    alt: options.after.alt,
    draggable: false,
    'data-testid': 'compare-after',
  });
  const frame = h(
    'div',
    { class: 'or-compare' },
    before,
    after,
    h('div', { class: 'or-compare-divider', 'aria-hidden': 'true' }),
    h(
      'span',
      {
        class: 'badge text-bg-dark or-compare-label or-compare-label-start',
        'aria-hidden': 'true',
      },
      options.before.label,
    ),
    h(
      'span',
      { class: 'badge text-bg-dark or-compare-label or-compare-label-end', 'aria-hidden': 'true' },
      options.after.label,
    ),
  );
  const range = h('input', {
    id: rangeId,
    type: 'range',
    class: 'form-range',
    min: '0',
    max: '100',
    step: '1',
    value: String(options.value ?? 50),
    'aria-label': options.label,
    'data-testid': 'compare-range',
  });

  const show = (): void => {
    const value = Number(range.value);
    frame.style.setProperty('--or-compare', `${value}%`);
    range.setAttribute(
      'aria-valuetext',
      `${options.before.label} on the left ${value}%, ${options.after.label} on the right ${100 - value}%`,
    );
  };
  range.addEventListener('input', show);

  // A drag on the picture moves the divider too; the range stays the one control (and takes focus).
  const fromPointer = (event: PointerEvent): void => {
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0) return;
    const value = Math.round(((event.clientX - rect.left) / rect.width) * 100);
    range.value = String(Math.min(100, Math.max(0, value)));
    show();
  };
  frame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    frame.setPointerCapture(event.pointerId);
    range.focus({ preventScroll: true });
    fromPointer(event);
  });
  frame.addEventListener('pointermove', (event) => {
    if (frame.hasPointerCapture(event.pointerId)) fromPointer(event);
  });

  show();
  return {
    element: h('div', { class: 'vstack gap-2', 'data-testid': options.testId }, frame, range),
    range,
    setImages(images) {
      if (images.before) {
        before.src = images.before.src;
        before.alt = images.before.alt;
      }
      if (images.after) {
        after.src = images.after.src;
        after.alt = images.after.alt;
      }
    },
  };
}
