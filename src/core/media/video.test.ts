// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { lastFrameTime } from './video';

describe('lastFrameTime', () => {
  it('aims inside the final frame: 1/120 s before the end without a frame rate', () => {
    expect(lastFrameTime(1.04)).toBeCloseTo(1.04 - 1 / 120, 9);
    expect(lastFrameTime(10)).toBeCloseTo(10 - 1 / 120, 9);
  });

  it('aims at the middle of the final frame when the frame rate is known', () => {
    expect(lastFrameTime(1.04, 24)).toBeCloseTo(1.04 - 0.5 / 24, 9);
    expect(lastFrameTime(5, 60)).toBeCloseTo(5 - 0.5 / 60, 9);
  });

  it('copes with empty, tiny and unknown durations', () => {
    expect(lastFrameTime(0)).toBe(0);
    expect(lastFrameTime(Number.NaN)).toBe(0);
    expect(lastFrameTime(-1)).toBe(0);
    expect(lastFrameTime(0.001)).toBe(0);
    expect(lastFrameTime(1, 0)).toBeCloseTo(1 - 1 / 120, 9);
  });
});
