/**
 * The painted mask: brush and eraser strokes as replayable operations (undo/redo replays them from blank, so no
 * snapshots are kept), invert, coverage, and the mask at another size or clipped to a box. Feathering and
 * compositing run in the image worker (`featherInsideAsync`, `compositeMaskedAsync`).
 *
 * A mask is one byte per pixel (`Mask` from src/core/media/image.ts): 255 = marked for change, 0 = keep.
 * Strokes paint hard-edged discs; softness comes only from `featherInside` at composite time, and it never
 * reaches past the mask, so pixels outside it stay exactly the original.
 */
import type { Box, Mask } from '../../core/media/image';

export type MaskTool = 'brush' | 'eraser';

/** One undoable change to the mask. Points and radii are in image pixels. */
export type MaskOp =
  | {
      type: 'stroke';
      tool: MaskTool;
      radius: number;
      points: readonly (readonly [x: number, y: number])[];
    }
  | { type: 'clear' }
  | { type: 'invert' };

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

/** The union of two boxes (either may be null). */
export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * Sets every pixel whose centre lies within `radius` of (`cx`, `cy`) to `value`. Returns the box it touched
 * (clamped to the mask), or null when the disc is outside.
 */
export function stampDisc(
  mask: Mask,
  cx: number,
  cy: number,
  radius: number,
  value: number,
): Box | null {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + r));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return null;
  const limit = r * r;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    const row = y * mask.width;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      if (dx * dx + dy * dy <= limit) mask.data[row + x] = value;
    }
  }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Discs along a segment, spaced a quarter radius apart, so a fast stroke has no gaps. */
export function paintSegment(
  mask: Mask,
  from: readonly [number, number],
  to: readonly [number, number],
  radius: number,
  value: number,
): Box | null {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(length / Math.max(0.5, radius / 4)));
  let dirty: Box | null = null;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    dirty = unionBox(
      dirty,
      stampDisc(
        mask,
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        radius,
        value,
      ),
    );
  }
  return dirty;
}

export function invertMask(mask: Mask): void {
  for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - (mask.data[i] ?? 0);
}

/** Applies one operation in place; returns the box it may have changed (the whole mask for clear/invert). */
export function applyOp(mask: Mask, op: MaskOp): Box | null {
  const whole: Box = { x: 0, y: 0, width: mask.width, height: mask.height };
  if (op.type === 'clear') {
    mask.data.fill(0);
    return whole;
  }
  if (op.type === 'invert') {
    invertMask(mask);
    return whole;
  }
  const value = op.tool === 'brush' ? 255 : 0;
  const [first, ...rest] = op.points;
  if (!first) return null;
  let dirty = stampDisc(mask, first[0], first[1], op.radius, value);
  let last = first;
  for (const point of rest) {
    dirty = unionBox(dirty, paintSegment(mask, last, point, op.radius, value));
    last = point;
  }
  return dirty;
}

/** The mask after `ops`, starting from blank. */
export function replayOps(width: number, height: number, ops: readonly MaskOp[]): Mask {
  const mask = createMask(width, height);
  for (const op of ops) applyOp(mask, op);
  return mask;
}

/** Share of the pixels that are marked (0 to 1). */
export function maskCoverage(mask: Mask): number {
  if (mask.data.length === 0) return 0;
  let marked = 0;
  for (let i = 0; i < mask.data.length; i++) if ((mask.data[i] ?? 0) > 0) marked++;
  return marked / mask.data.length;
}

export function isMaskEmpty(mask: Mask): boolean {
  for (let i = 0; i < mask.data.length; i++) if ((mask.data[i] ?? 0) > 0) return false;
  return true;
}

/** The mask with everything outside `box` set to 0 (where a fitted result does not reach). */
export function clipMask(mask: Mask, box: Box): Mask {
  const out = createMask(mask.width, mask.height);
  const x0 = Math.max(0, box.x);
  const x1 = Math.min(mask.width, box.x + box.width);
  for (let y = Math.max(0, box.y); y < Math.min(mask.height, box.y + box.height); y++) {
    const row = y * mask.width;
    out.data.set(mask.data.subarray(row + x0, row + x1), row + x0);
  }
  return out;
}

/** The mask at another size, nearest pixel (the editor paints at the size the model sees). */
export function scaleMask(mask: Mask, width: number, height: number): Mask {
  if (width === mask.width && height === mask.height) {
    return { width, height, data: new Uint8Array(mask.data) };
  }
  const out = createMask(width, height);
  for (let y = 0; y < height; y++) {
    const row =
      Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height)) * mask.width;
    for (let x = 0; x < width; x++) {
      out.data[y * width + x] =
        mask.data[row + Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width))] ??
        0;
    }
  }
  return out;
}
