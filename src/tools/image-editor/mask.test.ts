import { describe, expect, it } from 'vitest';
import type { Mask } from '../../core/media/image';
import {
  applyOp,
  clipMask,
  createMask,
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
