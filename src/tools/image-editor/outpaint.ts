/**
 * Canvas geometry for edits: the larger outpaint canvas around the picture (by margins, or out to an aspect
 * ratio), the picture placed on it, the new area as the mask and its compositing alpha, the plan at the size
 * the model sees, and how a result of another shape is fitted onto the canvas.
 */
import { aspectValue } from '../../core/models/image-params';
import type { Box, Mask, RasterImage, Rgb } from '../../core/media/image';
import { createMask, featherOutside } from './mask';

/** Extra space on each side, in percent of the picture's width (left, right) or height (top, bottom). */
export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The new canvas and where the original goes on it. */
export interface OutpaintPlan {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

/** No side of the new canvas may be longer than this. */
export const MAX_CANVAS_SIDE = 4096;
export const MAX_MARGIN_PERCENT = 200;
/** What fills the new area in the plain picture sent to the model: a flat mid grey. */
export const OUTPAINT_FILL: Rgb = [128, 128, 128];
export const EXTEND_RATIOS = ['1:1', '4:3', '3:2', '16:9', '21:9', '3:4', '2:3', '9:16'] as const;

const clampPercent = (value: number): number =>
  Number.isFinite(value) ? Math.min(MAX_MARGIN_PERCENT, Math.max(0, value)) : 0;

export function planFromMargins(width: number, height: number, margins: Margins): OutpaintPlan {
  const left = Math.round((width * clampPercent(margins.left)) / 100);
  const right = Math.round((width * clampPercent(margins.right)) / 100);
  const top = Math.round((height * clampPercent(margins.top)) / 100);
  const bottom = Math.round((height * clampPercent(margins.bottom)) / 100);
  return {
    width: width + left + right,
    height: height + top + bottom,
    offsetX: left,
    offsetY: top,
  };
}

/**
 * Widens or heightens the canvas (never crops) until it has `ratio` (width / height), the picture centred;
 * an odd leftover pixel goes right or down. A picture already at the ratio gets no new area.
 */
export function planFromAspect(width: number, height: number, ratio: number): OutpaintPlan {
  if (!(ratio > 0)) return { width, height, offsetX: 0, offsetY: 0 };
  if (width / height < ratio) {
    const wide = Math.max(width, Math.round(height * ratio));
    return { width: wide, height, offsetX: Math.floor((wide - width) / 2), offsetY: 0 };
  }
  const tall = Math.max(height, Math.round(width / ratio));
  return { width, height: tall, offsetX: 0, offsetY: Math.floor((tall - height) / 2) };
}

/** The plan for the form's choice: `extend` is `margins` or an aspect ratio such as `16:9`. */
export function outpaintPlan(
  width: number,
  height: number,
  extend: string,
  margins: Margins,
): OutpaintPlan {
  const ratio = extend === 'margins' ? null : aspectValue(extend);
  return ratio === null
    ? planFromMargins(width, height, margins)
    : planFromAspect(width, height, ratio);
}

/** Why the plan cannot be used, or null. */
export function planProblem(plan: OutpaintPlan, width: number, height: number): string | null {
  if (plan.width === width && plan.height === height) {
    return 'There is nothing to add: set some margins or pick a different shape.';
  }
  if (plan.width > MAX_CANVAS_SIDE || plan.height > MAX_CANVAS_SIDE) {
    return `The new canvas would be ${plan.width} × ${plan.height}; keep each side at most ${MAX_CANVAS_SIDE} pixels.`;
  }
  return null;
}

/** 255 on the new area, 0 where the original sits. */
export function outpaintMask(plan: OutpaintPlan, width: number, height: number): Mask {
  const mask = createMask(plan.width, plan.height);
  mask.data.fill(255);
  for (let y = 0; y < height; y++) {
    const row = (plan.offsetY + y) * plan.width + plan.offsetX;
    mask.data.fill(0, row, row + width);
  }
  return mask;
}

/** The picture on the new canvas, the new area filled with `fill`. */
export function placeOnCanvas(
  image: RasterImage,
  plan: OutpaintPlan,
  fill: Rgb = OUTPAINT_FILL,
): RasterImage {
  const data = new Uint8ClampedArray(plan.width * plan.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = fill[0];
    data[i + 1] = fill[1];
    data[i + 2] = fill[2];
    data[i + 3] = 255;
  }
  for (let y = 0; y < image.height; y++) {
    data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      ((plan.offsetY + y) * plan.width + plan.offsetX) * 4,
    );
  }
  return { width: plan.width, height: plan.height, data };
}

/**
 * The alpha that lays an outpaint result over the picture's canvas: all result in the new area (there is only
 * grey filler under it, never blended in), and a soft edge of `feather` pixels on the picture's side of the
 * seam; beyond that the picture is kept exactly.
 */
export function outpaintAlpha(
  plan: OutpaintPlan,
  width: number,
  height: number,
  feather: number,
): Mask {
  return featherOutside(outpaintMask(plan, width, height), feather);
}

/** A plan at another size of the same canvas, with the picture's own box rounded once, consistently. */
export interface ScaledPlan extends OutpaintPlan {
  imageWidth: number;
  imageHeight: number;
}

export function scaledPlan(
  plan: OutpaintPlan,
  width: number,
  height: number,
  size: { width: number; height: number },
): ScaledPlan {
  const sx = size.width / plan.width;
  const sy = size.height / plan.height;
  const offsetX = Math.round(plan.offsetX * sx);
  const offsetY = Math.round(plan.offsetY * sy);
  return {
    width: size.width,
    height: size.height,
    offsetX,
    offsetY,
    imageWidth: Math.max(1, Math.round((plan.offsetX + width) * sx) - offsetX),
    imageHeight: Math.max(1, Math.round((plan.offsetY + height) * sy) - offsetY),
  };
}

/** Shapes closer than this (in log ratio, about 2%) count as the same: the result is scaled to fill. */
const SAME_SHAPE = 0.02;

/**
 * Where a result goes on the canvas: filling it when the shapes agree, else fitted inside and centred (never
 * stretched); `fill: false` means the edges of the canvas are not covered and the user should be told.
 */
export function fitResult(
  resultWidth: number,
  resultHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { fill: boolean; box: Box } {
  const same =
    Math.abs(Math.log(resultWidth / resultHeight) - Math.log(canvasWidth / canvasHeight)) <=
    SAME_SHAPE;
  if (same) return { fill: true, box: { x: 0, y: 0, width: canvasWidth, height: canvasHeight } };
  const scale = Math.min(canvasWidth / resultWidth, canvasHeight / resultHeight);
  const width = Math.max(1, Math.round(resultWidth * scale));
  const height = Math.max(1, Math.round(resultHeight * scale));
  return {
    fill: false,
    box: {
      x: Math.round((canvasWidth - width) / 2),
      y: Math.round((canvasHeight - height) / 2),
      width,
      height,
    },
  };
}
