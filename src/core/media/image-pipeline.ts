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
  /**
   * True when `adaptThreshold` was asked for but the picture's border showed no background to read (a scene,
   * or a product covering most of it): `whiteThreshold` was used as it is, and the result needs a look.
   */
  backgroundUnclear: boolean;
}

/** `adaptiveThreshold` never goes below this: a background darker than that is grey, not off-white. */
export const MIN_ADAPTIVE_THRESHOLD = 200;

/**
 * What `fillAndDespeckle` whitens: groups of at most this many pixels, no longer than `SPECK_SIDE` and no more
 * than three times as long as wide (so a thread or a thin line is never one), with no pixel more than
 * `SPECK_DEPTH` below the threshold and no such darker pixel within `SPECK_CLEARANCE` (so a pale detail next to
 * the product stays). Noise and the fringe of a soft shadow are single pixels and small clumps.
 */
const SPECK_AREA = 64;
const SPECK_SIDE = 12;
const SPECK_DEPTH = 40;
const SPECK_CLEARANCE = 3;

/**
 * The background fill on the photo itself, for noisy pictures. Fills from the edges through near-white pixels
 * (4-neighbour) like `floodFillWhiteFromEdges`, then looks at each group of pixels the fill did not reach,
 * joined through corners too (8-neighbour, so a diagonal line is one group, and one with the product it leaves).
 * A group that is a speck (see `SPECK_AREA`: small, compact, pale, away from anything darker, off the image's
 * edge) becomes #FFFFFF too. Everything inside a product belongs to the product's group (white parts and their
 * print included), so it stays, as do threads, beads and parts of any size that are not compact specks.
 * Returns a new image.
 */
export function fillAndDespeckle(image: RasterImage, threshold: number): RasterImage {
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
  const dark = (p: number): boolean => !atLeast(p, threshold - SPECK_DEPTH);
  /** True when a pixel darker than a speck may be lies within `SPECK_CLEARANCE` of (x, y). */
  const darkNear = (x: number, y: number): boolean => {
    for (let dy = -SPECK_CLEARANCE; dy <= SPECK_CLEARANCE; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -SPECK_CLEARANCE; dx <= SPECK_CLEARANCE; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < width && dark(yy * width + xx)) return true;
      }
    }
    return false;
  };
  for (let start = 0; start < pixels; start++) {
    if (reached[start] === 1 || grouped[start] === 1) continue;
    let size = 0;
    let keep = false;
    let left = width;
    let right = -1;
    let upper = height;
    let lower = -1;
    grouped[start] = 1;
    stack[top++] = start;
    while (top > 0) {
      const p = stack[--top] ?? 0;
      group[size++] = p;
      const x = p % width;
      const y = (p - x) / width;
      left = Math.min(left, x);
      right = Math.max(right, x);
      upper = Math.min(upper, y);
      lower = Math.max(lower, y);
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1 || dark(p)) keep = true;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (reached[q] === 1 || grouped[q] === 1) continue;
          grouped[q] = 1;
          stack[top++] = q;
        }
      }
    }
    if (keep || size > SPECK_AREA) continue;
    const long = Math.max(right - left, lower - upper) + 1;
    const short = Math.min(right - left, lower - upper) + 1;
    if (long > SPECK_SIDE || long > 3 * short) continue;
    let alone = true;
    for (let k = 0; k < size && alone; k++) {
      const p = group[k] ?? 0;
      alone = !darkNear(p % width, Math.floor(p / width));
    }
    if (alone) for (let k = 0; k < size; k++) whiten(group[k] ?? 0);
  }
  for (let p = 0; p < pixels; p++) if (reached[p] === 1) whiten(p);
  return { width, height, data };
}

/** The background must hold at least this share of the border for `adaptiveThreshold` to read it. */
const MIN_BACKGROUND_SHARE = 0.25;
/** A darker population on the border (a product reaching the frame) counts from this share on. */
const MIN_OTHER_SHARE = 0.02;

/**
 * The white threshold for an image whose background may be off-white or noisy, read from the picture's
 * outermost pixels (each pixel's lightness: its darkest channel, over white).
 *
 * The background is the **lightest** population there, not the border's median, so a pale product covering
 * most of the frame is never taken for it: its level is the median of the pixels near the border's 90th
 * percentile, and its noise their median absolute deviation (both read twice, the second time in a window
 * sized by the first). The threshold is kept seven deviations plus 3 below that level (about six standard
 * deviations of Gaussian noise), so no background pixel and no faint shadow tail inside the noise falls below
 * it, and above the lightest of any darker population on the border (by 3), so a pale product reaching the
 * frame stays content. A clean background (flat 251 and up at 245) keeps `threshold`; it is never raised.
 *
 * `found` is false, and `threshold` comes back unchanged, when the background cannot be read: it holds under a
 * quarter of the border, it is darker than `MIN_ADAPTIVE_THRESHOLD` (a scene that was not removed), or a pale
 * product and the background's noise overlap. Such a result needs a look.
 */
export function adaptiveThreshold(
  image: RasterImage,
  threshold: number,
): { threshold: number; found: boolean } {
  const { width, height, data } = image;
  const unread = { threshold, found: false };
  if (width < 1 || height < 1) return unread;
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

  /** Pixels with a lightness in [low, high]. */
  const count = (low: number, high: number): number => {
    let total = 0;
    for (let value = Math.max(0, low); value <= Math.min(255, high); value++) {
      total += histogram[value] ?? 0;
    }
    return total;
  };
  /** The value under which `fraction` of the pixels in [low, high] lie. */
  const percentile = (low: number, high: number, fraction: number): number => {
    const target = fraction * count(low, high);
    let seen = 0;
    for (let value = Math.max(0, low); value <= Math.min(255, high); value++) {
      seen += histogram[value] ?? 0;
      if (seen > target) return value;
    }
    return Math.min(255, high);
  };
  /** Median and median absolute deviation of the pixels in [low, 255]. */
  const population = (low: number): { level: number; spread: number } => {
    const level = percentile(low, 255, 0.5);
    const half = count(low, 255) / 2;
    let spread = 0;
    while (spread < 255 && count(Math.max(low, level - spread), level + spread) <= half)
      spread += 1;
    return { level, spread };
  };

  const top = percentile(0, 255, 0.9);
  if (top < MIN_ADAPTIVE_THRESHOLD) return unread;
  const first = population(top - 8);
  const low = first.level - Math.max(8, 5 * first.spread);
  const { level, spread } = population(low);
  if (count(low, 255) < MIN_BACKGROUND_SHARE * samples) return unread;
  let adapted = Math.floor(level - 7 * spread - 3);
  // A darker population on the border: a product reaching the frame. Stay above its lightest pixels.
  if (count(0, low - 1) >= MIN_OTHER_SHARE * samples) {
    adapted = Math.max(adapted, percentile(0, low - 1, 0.99) + 3);
    if (adapted > level - 3 * spread - 1) return unread;
  }
  if (adapted < MIN_ADAPTIVE_THRESHOLD) return unread;
  return { threshold: Math.min(threshold, adapted), found: true };
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
  const read = options.adaptThreshold
    ? adaptiveThreshold(image, wanted)
    : { threshold: wanted, found: true };
  const threshold = read.threshold;
  const source = options.despeckle ? fillAndDespeckle(image, threshold) : image;
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
    backgroundUnclear: !read.found,
  };
}
