import { afterEach, describe, expect, it } from 'vitest';
import { compareSlider } from './compare-slider';

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T =>
  root.querySelector<T>(`[data-testid="${id}"]`)!;

afterEach(() => {
  document.body.replaceChildren();
});

describe('compareSlider', () => {
  const make = () =>
    compareSlider({
      before: { src: 'blob:before', alt: 'Original photo', label: 'Before' },
      after: { src: 'blob:after', alt: 'Isolated product', label: 'After' },
      label: 'Compare before and after',
      value: 40,
      testId: 'wipe',
    });

  it('shows both images and names the divider position', () => {
    const slider = make();
    expect(slider.element.dataset.testid).toBe('wipe');
    expect($<HTMLImageElement>(slider.element, 'compare-before').alt).toBe('Original photo');
    expect($<HTMLImageElement>(slider.element, 'compare-after').alt).toBe('Isolated product');
    expect(slider.range.getAttribute('aria-label')).toBe('Compare before and after');
    expect(slider.range.getAttribute('aria-valuetext')).toBe(
      'Before on the left 40%, After on the right 60%',
    );
    const frame = slider.element.querySelector<HTMLElement>('.or-compare')!;
    expect(frame.style.getPropertyValue('--or-compare')).toBe('40%');
  });

  it('follows the range input and swaps images in place', () => {
    const slider = make();
    slider.range.value = '75';
    slider.range.dispatchEvent(new Event('input'));
    const frame = slider.element.querySelector<HTMLElement>('.or-compare')!;
    expect(frame.style.getPropertyValue('--or-compare')).toBe('75%');
    expect(slider.range.getAttribute('aria-valuetext')).toBe(
      'Before on the left 75%, After on the right 25%',
    );
    const after = $<HTMLImageElement>(slider.element, 'compare-after');
    slider.setImages({ after: { src: 'blob:next', alt: 'Retouched product' } });
    expect($(slider.element, 'compare-after')).toBe(after);
    expect(after.getAttribute('src')).toBe('blob:next');
    expect(after.alt).toBe('Retouched product');
    expect(slider.range.value).toBe('75');
  });
});
