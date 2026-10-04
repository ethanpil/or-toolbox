import { describe, expect, it } from 'vitest';
import type { RasterImage } from '../../core/media/image';
import { compositeMasked } from './mask';
import {
  fitResult,
  outpaintAlpha,
  outpaintMask,
  outpaintPlan,
  placeOnCanvas,
  planFromAspect,
  planFromMargins,
  planProblem,
  scaledPlan,
} from './outpaint';

describe('outpaint plans', () => {
  it('adds margins in percent of the picture’s width and height', () => {
    expect(planFromMargins(1000, 500, { top: 10, right: 25, bottom: 0, left: 25 })).toEqual({
      width: 1500,
      height: 550,
      offsetX: 250,
      offsetY: 50,
    });
    // Out-of-range margins are clamped (0 to 200%).
    expect(planFromMargins(100, 100, { top: -5, right: 500, bottom: Number.NaN, left: 0 })).toEqual(
      {
        width: 300,
        height: 100,
        offsetX: 0,
        offsetY: 0,
      },
    );
  });

  it('widens or heightens to an aspect ratio, centred, never cropping', () => {
    expect(planFromAspect(1024, 768, 16 / 9)).toEqual({
      width: 1365,
      height: 768,
      offsetX: 170,
      offsetY: 0,
    });
    expect(planFromAspect(1024, 1024, 9 / 16)).toEqual({
      width: 1024,
      height: 1820,
      offsetX: 0,
      offsetY: 398,
    });
    expect(planFromAspect(1600, 900, 16 / 9)).toEqual({
      width: 1600,
      height: 900,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it('picks margins or a ratio from the form, and refuses plans that add nothing or grow too big', () => {
    const margins = { top: 0, right: 50, bottom: 0, left: 50 };
    expect(outpaintPlan(800, 600, 'margins', margins).width).toBe(1600);
    expect(outpaintPlan(800, 600, '1:1', margins)).toEqual({
      width: 800,
      height: 800,
      offsetX: 0,
      offsetY: 100,
    });
    expect(planProblem({ width: 800, height: 600, offsetX: 0, offsetY: 0 }, 800, 600)).toMatch(
      /nothing to add/,
    );
    expect(planProblem(planFromMargins(3000, 1000, margins), 3000, 1000)).toMatch(/at most 4096/);
    expect(planProblem(outpaintPlan(800, 600, 'margins', margins), 800, 600)).toBeNull();
  });
});

describe('the new canvas and its mask', () => {
  const picture: RasterImage = {
    width: 2,
    height: 1,
    data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  };
  const plan = planFromMargins(2, 1, { top: 100, right: 50, bottom: 100, left: 50 });

  it('places the picture at its offset on a grey canvas', () => {
    expect(plan).toEqual({ width: 4, height: 3, offsetX: 1, offsetY: 1 });
    const canvas = placeOnCanvas(picture, plan);
    const pixel = (x: number, y: number) => [
      ...canvas.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];
    expect(pixel(0, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(2, 1)).toEqual([0, 255, 0, 255]);
    expect(pixel(3, 1)).toEqual([128, 128, 128, 255]);
  });

  it('marks exactly the new area', () => {
    const mask = outpaintMask(plan, 2, 1);
    expect([...mask.data]).toEqual([255, 255, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255]);
  });
});

describe('outpaint compositing', () => {
  const white = (width: number, height: number): RasterImage => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4).fill(255),
  });

  it('never blends the grey filler into the new area (white picture, white result, feather 6)', () => {
    const picture = white(40, 20);
    const plan = planFromMargins(40, 20, { top: 0, right: 50, bottom: 0, left: 50 });
    const canvas = placeOnCanvas(picture, plan);
    const result = white(plan.width, plan.height);
    const out = compositeMasked(canvas, result, outpaintAlpha(plan, 40, 20, 6));
    const grey = [...out.data].filter((value) => value !== 255).length;
    expect(grey).toBe(0);
  });

  it('puts the soft edge on the picture’s side of the seam; the new area is all result', () => {
    const plan = planFromMargins(40, 20, { top: 0, right: 50, bottom: 0, left: 50 });
    const alpha = outpaintAlpha(plan, 40, 20, 6);
    const at = (x: number, y: number) => alpha.data[y * plan.width + x] ?? -1;
    for (let x = 0; x < plan.offsetX; x++) expect(at(x, 10)).toBe(255);
    expect(at(plan.offsetX, 10)).toBeGreaterThan(0);
    expect(at(plan.offsetX, 10)).toBeLessThan(255);
    expect(at(plan.offsetX + 20, 10)).toBe(0); // the middle of the picture stays exactly as it was
    expect(outpaintAlpha(plan, 40, 20, 0).data).toEqual(outpaintMask(plan, 40, 20).data);
  });

  it('scales a plan to the size the model sees, keeping the picture’s box consistent', () => {
    const plan = planFromAspect(3000, 2000, 16 / 9); // 3556 x 2000, picture at x 278
    const scaled = scaledPlan(plan, 3000, 2000, { width: 2048, height: 1152 });
    expect(scaled).toEqual({
      width: 2048,
      height: 1152,
      offsetX: 160,
      offsetY: 0,
      imageWidth: 1728,
      imageHeight: 1152,
    });
  });
});

describe('fitting a result onto the canvas', () => {
  it('fills the canvas when the shapes agree, and fits it inside, centred, when they do not', () => {
    expect(fitResult(1792, 1008, 1820, 1024)).toEqual({
      fill: true,
      box: { x: 0, y: 0, width: 1820, height: 1024 },
    });
    expect(fitResult(1024, 1024, 1820, 1024)).toEqual({
      fill: false,
      box: { x: 398, y: 0, width: 1024, height: 1024 },
    });
    expect(fitResult(1536, 1024, 1000, 1000)).toEqual({
      fill: false,
      box: { x: 0, y: 167, width: 1000, height: 667 },
    });
  });
});
