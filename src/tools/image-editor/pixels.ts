/**
 * Browser-only pixel helper for the editor: a picture drawn into a box of a canvas of a given size, with
 * high-quality smoothing (the browser's, no pixel loops), read back as a `RasterImage`.
 */
import { InvalidInputError } from '../../core/errors';
import type { Box, RasterImage, Rgb } from '../../core/media/image';

type Context2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function surface(width: number, height: number): Context2d {
  let context: Context2d | null;
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!context) throw new InvalidInputError('This browser could not create a drawing surface.');
  return context;
}

/** `source` drawn into `box` (default: all) of a `width` x `height` canvas, over `fill` when given. */
export function drawToRaster(
  source: CanvasImageSource,
  width: number,
  height: number,
  options: { box?: Box; fill?: Rgb } = {},
): RasterImage {
  const context = surface(width, height);
  if (options.fill) {
    context.fillStyle = `rgb(${options.fill.join(',')})`;
    context.fillRect(0, 0, width, height);
  }
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const box = options.box ?? { x: 0, y: 0, width, height };
  context.drawImage(source, box.x, box.y, box.width, box.height);
  const { data } = context.getImageData(0, 0, width, height);
  return { width, height, data };
}
