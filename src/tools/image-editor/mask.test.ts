import { describe, expect, it } from 'vitest';
import type { Mask, RasterImage } from '../../core/media/image';
import {
  applyOp,
  clipMask,
  compositeMasked,
  createMask,
  featherInside,
  invertMask,
  isMaskEmpty,
  maskCoverage,
  type MaskOp,
  paintSegment,
  replayOps,
  scaleMask,
  stampDisc,
} from './mask';

const at = (mask: Mask, x: number, y: number): number => mask.data[y * mask.width + x] ?? -1;

function raster(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

describe('painting', () => {
  it('stamps a hard-edged disc and reports the box it touched', () => {
    const mask = createMask(20, 20);
    const box = stampDisc(mask, 10, 10, 3, 255);
    expect(box).toEqual({ x: 7, y: 7, width: 7, height: 7 });
    expect(at(mask, 10, 10)).toBe(255);
    expect(at(mask, 12, 9)).toBe(255);
    expect(at(mask, 13, 13)).toBe(0); // the corner of the box is outside the disc
    expect(at(mask, 0, 0)).toBe(0);
    expect(stampDisc(mask, -50, -50, 3, 255)).toBeNull();
  });

  it('paints a segment without gaps and erases with 0', () => {
    const mask = createMask(100, 10);
    paintSegment(mask, [5, 5], [95, 5], 2, 255);
    for (let x = 5; x < 95; x++) expect(at(mask, x, 5)).toBe(255);
    paintSegment(mask, [40, 5], [60, 5], 3, 0);
    expect(at(mask, 50, 5)).toBe(0);
    expect(at(mask, 30, 5)).toBe(255);
  });

  it('replays strokes, clear and invert: undo is replaying fewer operations', () => {
    const ops: MaskOp[] = [
      {
        type: 'stroke',
        tool: 'brush',
        radius: 2,
        points: [
          [2, 2],
          [8, 2],
        ],
      },
      { type: 'stroke', tool: 'eraser', radius: 1, points: [[5, 2]] },
      { type: 'invert' },
    ];
    const all = replayOps(10, 5, ops);
    expect(at(all, 3, 2)).toBe(0); // brushed, then inverted
    expect(at(all, 5, 2)).toBe(255); // erased, then inverted
    expect(at(all, 9, 4)).toBe(255);
    const undone = replayOps(10, 5, ops.slice(0, 2));
    expect(at(undone, 3, 2)).toBe(255);
    expect(at(undone, 5, 2)).toBe(0);
    const cleared = replayOps(10, 5, [...ops, { type: 'clear' }]);
    expect(isMaskEmpty(cleared)).toBe(true);
    expect(
      applyOp(createMask(4, 4), { type: 'stroke', tool: 'brush', radius: 1, points: [] }),
    ).toBeNull();
  });

  it('measures coverage and inverts in place', () => {
    const mask = createMask(10, 10);
    expect(maskCoverage(mask)).toBe(0);
    mask.data.fill(255, 0, 25);
    expect(maskCoverage(mask)).toBe(0.25);
    invertMask(mask);
    expect(maskCoverage(mask)).toBe(0.75);
    expect(isMaskEmpty(mask)).toBe(false);
  });
});

describe('feather and composite', () => {
  /** A 40 x 40 mask with a 20 x 20 square marked in the middle (10..29). */
  const square = (): Mask => {
    const mask = createMask(40, 40);
    for (let y = 10; y < 30; y++) mask.data.fill(255, y * 40 + 10, y * 40 + 30);
    return mask;
  };

  it('softens only the inside of the mask: zero outside, full deeper than the radius', () => {
    const soft = featherInside(square(), 3);
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) {
        const inside = x >= 10 && x < 30 && y >= 10 && y < 30;
        if (!inside) expect(at(soft, x, y)).toBe(0);
      }
    }
    expect(at(soft, 20, 20)).toBe(255);
    expect(at(soft, 14, 20)).toBe(255); // depth 4 > radius 3
    expect(at(soft, 10, 20)).toBeGreaterThan(0);
    expect(at(soft, 10, 20)).toBeLessThan(255);
    expect(featherInside(square(), 0).data).toEqual(square().data);
  });

  it('keeps the original exactly outside the mask and takes the result inside', () => {
    const original = raster(40, 40, [10, 20, 30, 255]);
    original.data[0] = 99; // a distinctive pixel outside the mask
    const result = raster(40, 40, [200, 100, 50, 255]);
    const out = compositeMasked(original, result, featherInside(square(), 3));
    const pixel = (x: number, y: number) => [
      ...out.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4),
    ];
    expect(pixel(0, 0)).toEqual([99, 20, 30, 255]);
    expect(pixel(9, 20)).toEqual([10, 20, 30, 255]);
    expect(pixel(30, 30)).toEqual([10, 20, 30, 255]);
    expect(pixel(20, 20)).toEqual([200, 100, 50, 255]);
    const edge = pixel(10, 20);
    expect(edge[0]).toBeGreaterThan(10);
    expect(edge[0]).toBeLessThan(200);
    expect(() => compositeMasked(original, raster(20, 20, [0, 0, 0, 255]), square())).toThrow(
      RangeError,
    );
  });
});

describe('scaleMask', () => {
  it('scales a mask to another size by nearest pixel', () => {
    const mask = createMask(2, 2);
    mask.data.set([255, 0, 0, 255]);
    expect([...scaleMask(mask, 4, 4).data]).toEqual([
      255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255,
    ]);
    expect(scaleMask(mask, 2, 2).data).toEqual(mask.data);
  });
});
describe('clipMask', () => {
  it('keeps the mask inside a box only', () => {
    const mask = createMask(4, 3);
    mask.data.fill(255);
    expect([...clipMask(mask, { x: 1, y: 1, width: 2, height: 5 }).data]).toEqual([
      0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0,
    ]);
  });
});
