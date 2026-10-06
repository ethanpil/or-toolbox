import { describe, expect, it } from 'vitest';
import { uncoverBy } from './uncover';

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe('uncoverBy', () => {
  const viewport = 800;
  // Phone-like: the Run bar spans the width at the bottom; the navbar spans it at the top.
  const bar = rect(0, 740, 400, 60);
  const navbar = rect(0, 0, 400, 56);

  it('scrolls a control the bottom bar covers up by the overlap and a little air', () => {
    expect(uncoverBy(rect(16, 720, 200, 40), bar, 'bottom', viewport)).toBe(20 + 8);
  });

  it('never pushes the control’s top out of the window', () => {
    expect(uncoverBy(rect(16, 20, 200, 760), bar, 'bottom', viewport)).toBe(12);
  });

  it('leaves alone a control beside the bar (desktop: the bar is in the left column)', () => {
    const leftBar = rect(0, 740, 500, 60);
    expect(uncoverBy(rect(600, 720, 200, 40), leftBar, 'bottom', viewport)).toBe(0);
  });

  it('leaves alone a control above or below it', () => {
    expect(uncoverBy(rect(16, 600, 200, 40), bar, 'bottom', viewport)).toBe(0);
    expect(uncoverBy(rect(16, 800, 200, 40), bar, 'bottom', viewport)).toBe(0);
  });

  it('scrolls a control under the sticky navbar down into view (Shift+Tab)', () => {
    expect(uncoverBy(rect(16, 30, 200, 40), navbar, 'top', viewport)).toBe(-(56 - 30 + 8));
    expect(uncoverBy(rect(16, 100, 200, 40), navbar, 'top', viewport)).toBe(0);
  });
});
