/**
 * The painted mask and what is done with it: brush and eraser strokes as replayable operations (undo/redo
 * replays them from blank, so no snapshots are kept), invert, coverage, the inward feather, and the composite
 * that puts the original back outside the mask.
 *
 * A mask is one byte per pixel (`Mask` from src/core/media/image.ts): 255 = marked for change, 0 = keep.
 * Strokes paint hard-edged discs; softness comes only from `featherInside` at composite time, and it never
 * reaches past the mask, so pixels outside it stay exactly the original.
 */
import type { Box, Mask, RasterImage } from '../../core/media/image';

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

/** One box-blur pass of `radius` along rows (`horizontal`) or columns, edges clamped. */
function boxBlur(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const lines = horizontal ? height : width;
  const length = horizontal ? width : height;
  const at = (line: number, i: number): number =>
    horizontal ? line * width + i : i * width + line;
  const size = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += source[at(line, Math.min(length - 1, Math.max(0, k)))] ?? 0;
    }
    for (let i = 0; i < length; i++) {
      target[at(line, i)] = sum / size;
      const out = Math.max(0, i - radius);
      const into = Math.min(length - 1, i + radius + 1);
      sum += (source[at(line, into)] ?? 0) - (source[at(line, out)] ?? 0);
    }
  }
}

/**
 * The mask with a soft inner edge, for compositing: a box blur of `radius` pixels, then never more than the
 * mask itself. Outside the mask it stays 0 (the original is kept exactly); deeper than `radius` inside it is
 * 255 (the result is taken exactly); the band between blends.
 */
export function featherInside(mask: Mask, radius: number): Mask {
  const r = Math.max(0, Math.round(radius));
  const out = createMask(mask.width, mask.height);
  if (r === 0) {
    out.data.set(mask.data);
    return out;
  }
  const { width, height } = mask;
  const a = Float32Array.from(mask.data);
  const b = new Float32Array(a.length);
  boxBlur(a, b, width, height, r, true);
  boxBlur(b, a, width, height, r, false);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = Math.min(mask.data[i] ?? 0, Math.round(a[i] ?? 0));
  }
  return out;
}

/**
 * The result inside the mask, the original outside: `alpha` 0 copies the original pixel exactly, 255 the
 * result pixel exactly, values between blend. All three must be the same size.
 */
export function compositeMasked(
  original: RasterImage,
  result: RasterImage,
  alpha: Mask,
): RasterImage {
  if (
    original.width !== result.width ||
    original.height !== result.height ||
    alpha.width !== original.width ||
    alpha.height !== original.height
  ) {
    throw new RangeError('The image, the result and the mask must be the same size.');
  }
  const out = new Uint8ClampedArray(original.data);
  for (let p = 0; p < alpha.data.length; p++) {
    const a = alpha.data[p] ?? 0;
    if (a === 0) continue;
    const i = p * 4;
    if (a === 255) {
      out[i] = result.data[i] ?? 0;
      out[i + 1] = result.data[i + 1] ?? 0;
      out[i + 2] = result.data[i + 2] ?? 0;
      out[i + 3] = result.data[i + 3] ?? 0;
      continue;
    }
    const t = a / 255;
    for (let c = 0; c < 4; c++) {
      out[i + c] = (original.data[i + c] ?? 0) * (1 - t) + (result.data[i + c] ?? 0) * t;
    }
  }
  return { width: original.width, height: original.height, data: out };
}
