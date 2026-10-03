/**
 * The isolated-image pipeline on pixels: find the product, centre it on a
 * square, make the background pure white, sharpen a little, and check the
 * result. Pure functions on `RasterImage`, so they run in Node tests, on the
 * page, and in the worker (image-worker.ts), where the tools use them through
 * `isolateImage` (image-async.ts) to keep the page responsive.
 */
import {
  type Box,
  checkIsolated,
  contentBoundingBox,
  floodFillWhiteFromEdges,
  type IsolatedCheck,
  padToSquare,
  type RasterImage,
  resizeRaster,
  resizeRasterNative,
  unsharpMask,
  type UnsharpMaskOptions,
} from './image';

export interface IsolateOptions {
  /** The part of the image to keep. Default: the bounding box of everything that is not near-white. */
  box?: Box;
  /**
   * Channels at or above this (0-255) count as white for finding the product,
   * for the background fill and for the QA check. Default 245.
   */
  whiteThreshold?: number;
  /** Side of the square result in pixels. Default 2000. */
  size?: number;
  /** Empty border on each side as a fraction of `size`. Default 0.08. */
  margin?: number;
  /** Unsharp mask settings, or `false` for none. Default: light (amount 0.5, radius 1). */
  sharpen?: UnsharpMaskOptions | false;
}

export interface IsolateResult {
  /** The square image on pure white. */
  image: RasterImage;
  /** The part of the source that was kept (the whole image if it had no content). */
  box: Box;
  /** Whether every border pixel is #FFFFFF and the product stays off the edge. */
  check: IsolatedCheck;
}

/** Images above this many pixels are resized by the canvas instead of by `resizeRaster`. */
const NATIVE_RESIZE_PIXELS = 1_000_000;

/**
 * `resizeRaster` for small images and the browser's canvas for large ones,
 * where the pure version takes seconds. Outside a browser (Node tests) it is
 * always `resizeRaster`.
 */
export function resizeAuto(image: RasterImage, width: number, height: number): RasterImage {
  const canvasAvailable = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
  return canvasAvailable && image.width * image.height > NATIVE_RESIZE_PIXELS
    ? resizeRasterNative(image, width, height)
    : resizeRaster(image, width, height);
}

/**
 * The whole pipeline, synchronously: bounding box, `padToSquare`,
 * `floodFillWhiteFromEdges`, `unsharpMask`, `checkIsolated`. The input is not
 * changed. For anything but tests or small images, call `isolateImage`, which
 * runs this off the main thread.
 */
export function isolateRaster(image: RasterImage, options: IsolateOptions = {}): IsolateResult {
  const threshold = options.whiteThreshold ?? 245;
  const box = options.box ??
    contentBoundingBox(image, { whiteThreshold: threshold }) ?? {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    };
  const squared = padToSquare(image, box, {
    ...(options.size === undefined ? {} : { size: options.size }),
    ...(options.margin === undefined ? {} : { margin: options.margin }),
    background: '#FFFFFF',
    resize: resizeAuto,
  });
  const white = floodFillWhiteFromEdges(squared, threshold);
  const result =
    options.sharpen === false
      ? white
      : unsharpMask(white, options.sharpen ?? { amount: 0.5, radius: 1 });
  return { image: result, box, check: checkIsolated(result, { whiteThreshold: threshold }) };
}
