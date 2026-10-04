import { describe, expect, it } from 'vitest';
import { progressBar } from './progress-bar';

describe('progressBar', () => {
  it('is a labelled progressbar whose values and width follow update()', () => {
    const progress = progressBar({ label: 'Pages read', testId: 'p', hidden: true, class: 'mb-3' });
    const { element } = progress;
    expect(element.getAttribute('role')).toBe('progressbar');
    expect(element.getAttribute('aria-label')).toBe('Pages read');
    expect(element.hidden).toBe(true);
    expect(element.classList.contains('mb-3')).toBe(true);

    progress.update(3, 20, '3 of 20 pages');
    expect(element.getAttribute('aria-valuemax')).toBe('20');
    expect(element.getAttribute('aria-valuenow')).toBe('3');
    expect(element.getAttribute('aria-valuetext')).toBe('3 of 20 pages');
    expect((element.firstElementChild as HTMLElement).style.width).toBe('15%');

    progress.update(25, 20);
    expect(element.getAttribute('aria-valuenow')).toBe('20');
    expect(element.hasAttribute('aria-valuetext')).toBe(false);
    progress.update(0, 0);
    expect((element.firstElementChild as HTMLElement).style.width).toBe('0%');
  });
});
