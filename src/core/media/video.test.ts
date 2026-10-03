// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clampSeekTime, lastFrameTime } from './video';

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

describe('clampSeekTime', () => {
  it('leaves times inside the video alone', () => {
    expect(clampSeekTime(0, 1.04)).toBe(0);
    expect(clampSeekTime(0.5, 1.04)).toBe(0.5);
    expect(clampSeekTime(1.0, 1.04)).toBe(1.0);
  });

  it('sends a seek at or past the end to the final frame, which browsers get wrong when asked for the end', () => {
    const last = lastFrameTime(1.04);
    expect(clampSeekTime(1.04, 1.04)).toBe(last);
    expect(clampSeekTime(1.035, 1.04)).toBe(last);
    expect(clampSeekTime(99, 1.04)).toBe(last);
    expect(clampSeekTime(Infinity, 1.04)).toBe(last);
    expect(clampSeekTime(1.035, 1.04, 24)).toBe(lastFrameTime(1.04, 24));
  });

  it('clamps negative, unknown and empty cases to the first frame', () => {
    expect(clampSeekTime(-3, 1.04)).toBe(0);
    expect(clampSeekTime(Number.NaN, 1.04)).toBe(0);
    expect(clampSeekTime(5, 0)).toBe(0);
    expect(clampSeekTime(5, Number.NaN)).toBe(0);
  });
});
