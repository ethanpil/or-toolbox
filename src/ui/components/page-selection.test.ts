import { describe, expect, it } from 'vitest';
import {
  allPages,
  describeSelection,
  formatPageRange,
  isAllPages,
  normalizePages,
  parsePageRange,
  togglePage,
} from './page-selection';

describe('parsePageRange', () => {
  it.each([
    ['1-3,7', [1, 2, 3, 7]],
    ['1-3, 7', [1, 2, 3, 7]],
    [' 7 ; 1 - 3 ', [1, 2, 3, 7]],
    ['3 1 2', [1, 2, 3]],
    ['2–4', [2, 3, 4]],
    ['8-', [8, 9, 10]],
    ['-2', [1, 2]],
    ['5,5,4-5', [4, 5]],
    ['all', allPages(10)],
    ['ALL', allPages(10)],
    ['*', allPages(10)],
    ['10', [10]],
  ])('reads %j', (text, pages) => {
    expect(parsePageRange(text, 10)).toEqual({ pages });
  });

  it.each([
    ['', /Enter pages/],
    ['   ', /Enter pages/],
    ['11', /Page 11 does not exist; this file has 10 pages/],
    ['3-12', /Page 12 does not exist/],
    ['0', /Pages start at 1/],
    ['5-3', /runs backwards; write 3-5/],
    ['abc', /“abc” is not a page or a range/],
    ['1-2-3', /not a page or a range/],
    ['-', /not a page or a range/],
    ['1.5', /not a page or a range/],
  ])('refuses %j', (text, message) => {
    const result = parsePageRange(text, 10);
    expect(result.pages).toBeUndefined();
    expect(result.error).toMatch(message);
  });

  it('says "page" for a one-page file', () => {
    expect(parsePageRange('2', 1).error).toBe('Page 2 does not exist; this file has 1 page.');
  });
});

describe('formatPageRange', () => {
  it('compresses runs and round-trips through the parser', () => {
    expect(formatPageRange([7, 1, 2, 3])).toBe('1-3, 7');
    expect(formatPageRange([1, 3, 5])).toBe('1, 3, 5');
    expect(formatPageRange([4])).toBe('4');
    expect(formatPageRange([])).toBe('');
    expect(formatPageRange([2, 2, 3])).toBe('2-3');
    const pages = [1, 2, 4, 5, 6, 9, 20];
    expect(parsePageRange(formatPageRange(pages), 20)).toEqual({ pages });
  });
});

describe('selection helpers', () => {
  it('toggles a page in and out, keeping the order', () => {
    expect(togglePage([1, 3], 2)).toEqual([1, 2, 3]);
    expect(togglePage([1, 2, 3], 2)).toEqual([1, 3]);
    expect(togglePage([], 4)).toEqual([4]);
  });

  it('normalises: sorted, unique, in range, whole numbers', () => {
    expect(normalizePages([3, 1, 3, 0, -1, 2.5, 9], 5)).toEqual([1, 3]);
  });

  it('knows when everything is selected', () => {
    expect(isAllPages([1, 2, 3], 3)).toBe(true);
    expect(isAllPages([1, 3], 3)).toBe(false);
    expect(isAllPages([], 0)).toBe(true);
    expect(allPages(0)).toEqual([]);
  });

  it('describes the selection for the live count', () => {
    expect(describeSelection([])).toBe('No files yet.');
    expect(describeSelection([{ pageCount: 1, selected: [1] }])).toBe('1 file · 1 page');
    expect(
      describeSelection([
        { pageCount: 20, selected: [1, 2, 3] },
        { pageCount: 1, selected: [1] },
      ]),
    ).toBe('2 files · 4 of 21 pages selected');
  });
});
