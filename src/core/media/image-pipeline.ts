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
  /**
   * Lower `whiteThreshold` for this image as far as its own background needs (an edit model's light grey, its
   * noise), so that background is found and filled too; see `adaptiveThreshold`. Default false.
   */
  adaptThreshold?: boolean;
  /**
   * Fill the background on the photo itself before finding the product box, and whiten the specks that fill
   * leaves (see `fillAndDespeckle`), so noise and the fringe of a soft shadow neither widen the box nor stay as
   * grey dots. For noisy edit-model answers. Default false.
   */
  despeckle?: boolean;
}

export interface IsolateResult {
  /** The square image on pure white. */
  image: RasterImage;
  /** The part of the source that was kept (the whole image if it had no content). */
  box: Box;
  /** Whether every border pixel is #FFFFFF and the product stays off the edge. */
  check: IsolatedCheck;
  /** The white threshold used: `whiteThreshold`, or lower with `adaptThreshold`. */
  threshold: number;
}

/** `adaptiveThreshold` never goes below this: a background darker than that is grey, not off-white. */
export const MIN_ADAPTIVE_THRESHOLD = 200;

/** `despeckle` treats groups up to this share of the image as specks. */
const SPECK_SHARE = 0.001;
/** A speck has no pixel darker than this below the threshold: darker groups are things, not noise. */
const SPECK_DEPTH = 40;

/**
 * The background fill on the photo itself, for noisy pictures. Fills from the edges through near-white pixels
 * like `floodFillWhiteFromEdges`, then looks at each group of pixels the fill did not reach (4-neighbour): one
 * that does not touch the image's edge, has at most `maxSpeck` pixels and no pixel more than 40 below the
 * threshold is a speck (noise, or the fringe of a soft shadow fading through the threshold) and becomes
 * #FFFFFF too. Everything inside a product belongs to the product's own group (white parts included), so it
 * stays, as do darker or larger groups (a separate part, the core of a shadow). Returns a new image.
 */
export function fillAndDespeckle(
  image: RasterImage,
  threshold: number,
  maxSpeck: number,
): RasterImage {
  const { width, height } = image;
  const pixels = width * height;
  const data = new Uint8ClampedArray(image.data);
  /** True when the pixel's darkest channel, over white, is at least `level` (integer arithmetic). */
  const atLeast = (p: number, level: number): boolean => {
    const i = p * 4;
    const alpha = data[i + 3] ?? 255;
    const darkest = Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    return darkest * alpha + 255 * (255 - alpha) >= level * 255;
  };
  const reached = new Uint8Array(pixels);
  const stack = new Int32Array(pixels);
  let top = 0;
  const visit = (p: number): void => {
    if (reached[p] === 1 || !atLeast(p, threshold)) return;
    reached[p] = 1;
    stack[top++] = p;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (top > 0) {
    const p = stack[--top] ?? 0;
    const x = p % width;
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p < pixels - width) visit(p + width);
  }

  const grouped = new Uint8Array(pixels);
  const group = new Int32Array(pixels);
  const whiten = (p: number): void => {
    data.fill(255, p * 4, p * 4 + 4);
  };
  for (let start = 0; start < pixels; start++) {
    if (reached[start] === 1 || grouped[start] === 1) continue;
    let size = 0;
    let keep = false;
    grouped[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const p = stack[--top] ?? 0;
      group[size++] = p;
      const x = p % width;
      const onEdge = x === 0 || x === width - 1 || p < width || p >= pixels - width;
      if (onEdge || size > maxSpeck || !atLeast(p, threshold - SPECK_DEPTH)) keep = true;
      const take = (q: number): void => {
        if (reached[q] === 1 || grouped[q] === 1) return;
        grouped[q] = 1;
        stack[top++] = q;
      };
      if (x > 0) take(p - 1);
      if (x < width - 1) take(p + 1);
      if (p >= width) take(p - width);
      if (p < pixels - width) take(p + width);
    }
    if (!keep) for (let k = 0; k < size; k++) whiten(group[k] ?? 0);
  }
  for (let p = 0; p < pixels; p++) if (reached[p] === 1) whiten(p);
  return { width, height, data };
}

/**
 * The white threshold for an image whose background may be off-white or noisy. The outermost pixels are the
 * background of a product shot, so their lightness (each pixel's darkest channel, over white) is read, and the
 * threshold is kept at least a margin below their median: seven median absolute deviations plus 3, about six
 * standard deviations of Gaussian noise. So no background pixel, even in the image's interior, falls below it,
 * and the faint tail of a soft shadow does not cross it inside the noise (where it would leave specks). A clean
 * background (flat 251 and up at 245) keeps `threshold`; it is never raised. Median and deviation ignore a
 * product that reaches the frame on part of the border. When the result would go below
 * `MIN_ADAPTIVE_THRESHOLD` (a grey or busy border: a scene that was not removed), `threshold` is returned
 * unchanged, so the result still fails the QA instead of being bleached.
 */
export function adaptiveThreshold(image: RasterImage, threshold: number): number {
  const { width, height, data } = image;
  if (width < 1 || height < 1) return threshold;
  const histogram = new Uint32Array(256);
  let samples = 0;
  const sample = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    const darkest = Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    const alpha = data[i + 3] ?? 255;
    const value = Math.round((darkest * alpha + 255 * (255 - alpha)) / 255);
    histogram[value] = (histogram[value] ?? 0) + 1;
    samples += 1;
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }

  /** The value below which `fraction` of the border lies, from a 256-bin histogram. */
  const percentile = (bins: Uint32Array, fraction: number): number => {
    const target = fraction * samples;
    let seen = 0;
    for (let value = 0; value < bins.length; value++) {
      seen += bins[value] ?? 0;
      if (seen > target) return value;
    }
    return bins.length - 1;
  };
  const median = percentile(histogram, 0.5);
  const deviations = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    const distance = Math.abs(value - median);
    deviations[distance] = (deviations[distance] ?? 0) + (histogram[value] ?? 0);
  }
  const adapted = Math.floor(median - 7 * percentile(deviations, 0.5) - 3);
  return adapted < MIN_ADAPTIVE_THRESHOLD ? threshold : Math.min(threshold, adapted);
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
 * The whole pipeline, synchronously: the threshold (`adaptiveThreshold` with
 * `adaptThreshold`), the background filled on the photo (`fillAndDespeckle`
 * with `despeckle`), bounding box, `padToSquare`,
 * `floodFillWhiteFromEdges`, `unsharpMask`, `checkIsolated`. The input is not
 * changed. For anything but tests or small images, call `isolateImage`, which
 * runs this off the main thread.
 */
export function isolateRaster(image: RasterImage, options: IsolateOptions = {}): IsolateResult {
  const wanted = options.whiteThreshold ?? 245;
  const threshold = options.adaptThreshold ? adaptiveThreshold(image, wanted) : wanted;
  const source = options.despeckle
    ? fillAndDespeckle(
        image,
        threshold,
        Math.max(4, Math.round(image.width * image.height * SPECK_SHARE)),
      )
    : image;
  const box = options.box ??
    contentBoundingBox(source, { whiteThreshold: threshold }) ?? {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    };
  const squared = padToSquare(source, box, {
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
  return {
    image: result,
    box,
    check: checkIsolated(result, { whiteThreshold: threshold }),
    threshold,
  };
}
