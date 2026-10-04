/**
 * Browser-only pixel helpers for the editor: a picture drawn into a box of a canvas of a given size, with
 * high-quality smoothing, read back as a `RasterImage`; and a raster encoded as a reference data URL without
 * being resized again (all references of one edit share one size).
 */
import { InvalidInputError } from '../../core/errors';
import { readAsDataUrl } from '../../core/files';
import { type Box, type RasterImage, type Rgb, toBlob } from '../../core/media/image';

/** References above this many bytes as PNG go as JPEG (same size, never scaled again). */
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;

type Context2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function surface(width: number, height: number): Context2d {
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d', { willReadFrequently: true }) as Context2d | null;
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

/** A reference picture as a data URL at its own size: PNG, or JPEG when the PNG is too big and `lossy` is allowed. */
export async function referenceUrl(raster: RasterImage, lossy: boolean): Promise<string> {
  let blob = await toBlob(raster, { type: 'image/png' });
  if (lossy && blob.size > MAX_REFERENCE_BYTES) {
    blob = await toBlob(raster, { type: 'image/jpeg', quality: 0.9 });
  }
  return readAsDataUrl(blob);
}
