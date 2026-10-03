/**
 * Image processing for the image tools.
 *
 * Two layers:
 *
 * - **Pixel algorithms** on a plain `RasterImage` (`{ width, height, data }`,
 *   RGBA, 4 bytes per pixel, row-major). They need no DOM, so they run and are
 *   unit-tested in Node: bounding box, padding to a square, the white
 *   flood fill, unsharp mask, the isolated-image QA check, mask overlays.
 * - **Canvas wrappers** (`loadImage`, `imageDataFrom`, `toBlob`, `resizeCanvas`,
 *   `cropCanvas`, `toDataUrl`) that move pixels between Blobs, bitmaps and
 *   `RasterImage`. They need a browser and are covered by tests/e2e/media/.
 *
 * Memory: a `RasterImage` costs width x height x 4 bytes (a 2000 x 2000 image
 * is 16 MB), and most algorithms here return a new one instead of editing in
 * place. Process large batches one image at a time.
 */
import { InvalidInputError } from '../errors';
import { readAsDataUrl } from '../files';

// --- types ------------------------------------------------------------------

/** RGBA pixels, row-major, straight (not premultiplied) alpha. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** A rectangle in pixels. `x`/`y` is the top-left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One byte per pixel: 0 = untouched, 255 = fully marked. Same size as the image it belongs to. */
export interface Mask {
  width: number;
  height: number;
  data: Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;
}

export type Rgb = readonly [red: number, green: number, blue: number];

const WHITE: Rgb = [255, 255, 255];

/** Parses `#RGB` or `#RRGGBB`. */
export function parseColour(colour: string | Rgb): Rgb {
  if (typeof colour !== 'string') return colour;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (!match?.[1]) throw new RangeError(`Not a hex colour: ${colour}`);
  const hex =
    match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

/** A new opaque image filled with one colour (white by default). */
export function createRaster(
  width: number,
  height: number,
  fill: string | Rgb = WHITE,
): RasterImage {
  const [r, g, b] = parseColour(fill);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function copyRaster(img: RasterImage): RasterImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

function assertSize(img: RasterImage): void {
  if (img.data.length !== img.width * img.height * 4) {
    throw new RangeError('Image data does not match its width and height.');
  }
}

// --- geometry ---------------------------------------------------------------

/** Crops to `box`, which is clamped to the image. Throws if nothing is left. */
export function cropRaster(img: RasterImage, box: Box): RasterImage {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) throw new RangeError('The crop area is outside the image.');
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data: out };
}

/**
 * The size that fits inside `max` (a number for a square, or a width and
 * height) with the aspect ratio kept. Smaller images are not enlarged unless
 * `upscale` is set.
 */
export function fitWithin(
  width: number,
  height: number,
  max: number | { width: number; height: number },
  upscale = false,
): { width: number; height: number } {
  const limit = typeof max === 'number' ? { width: max, height: max } : max;
  let scale = Math.min(limit.width / width, limit.height / height);
  if (!upscale) scale = Math.min(scale, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// --- resampling -------------------------------------------------------------

interface Coefficients {
  starts: Int32Array;
  counts: Int32Array;
  weights: Float32Array;
  stride: number;
}

/**
 * Triangle-filter taps for scaling one axis from `inSize` to `outSize`. The
 * filter widens when shrinking, so every source pixel contributes (an area
 * average, no aliasing); when enlarging it is plain bilinear interpolation.
 */
function coefficients(inSize: number, outSize: number): Coefficients {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const stride = Math.ceil(filterScale) * 2 + 2;
  const starts = new Int32Array(outSize);
  const counts = new Int32Array(outSize);
  const weights = new Float32Array(outSize * stride);

  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const start = Math.max(0, Math.floor(center - filterScale + 0.5));
    const end = Math.min(inSize, Math.floor(center + filterScale + 0.5));
    const base = o * stride;
    let sum = 0;
    for (let x = start; x < end; x++) {
      const distance = Math.abs((x + 0.5 - center) / filterScale);
      const weight = distance < 1 ? 1 - distance : 0;
      weights[base + x - start] = weight;
      sum += weight;
    }
    if (sum > 0) {
      for (let k = 0; k < end - start; k++) weights[base + k] = (weights[base + k] ?? 0) / sum;
      starts[o] = start;
      counts[o] = end - start;
    } else {
      // All taps landed exactly on the filter edge: use the nearest source pixel.
      starts[o] = Math.min(inSize - 1, Math.max(0, Math.floor(center)));
      counts[o] = 1;
      weights[base] = 1;
    }
  }
  return { starts, counts, weights, stride };
}

/**
 * Scales an image with a triangle filter (area average when shrinking,
 * bilinear when enlarging). Channels are filtered independently, so flatten
 * images with transparency first (`flattenRaster`) to avoid dark fringes.
 */
export function resizeRaster(img: RasterImage, width: number, height: number): RasterImage {
  assertSize(img);
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === img.width && height === img.height) return copyRaster(img);

  // Horizontal pass: (img.width x img.height) -> (width x img.height).
  let stage = img.data;
  if (width !== img.width) {
    const { starts, counts, weights, stride } = coefficients(img.width, width);
    const next = new Uint8ClampedArray(width * img.height * 4);
    for (let y = 0; y < img.height; y++) {
      const rowIn = y * img.width * 4;
      const rowOut = y * width * 4;
      for (let x = 0; x < width; x++) {
        const start = starts[x] ?? 0;
        const count = counts[x] ?? 0;
        const base = x * stride;
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let k = 0; k < count; k++) {
          const w = weights[base + k] ?? 0;
          const p = rowIn + (start + k) * 4;
          r += (stage[p] ?? 0) * w;
          g += (stage[p + 1] ?? 0) * w;
          b += (stage[p + 2] ?? 0) * w;
          a += (stage[p + 3] ?? 0) * w;
        }
        const q = rowOut + x * 4;
        next[q] = r;
        next[q + 1] = g;
        next[q + 2] = b;
        next[q + 3] = a;
      }
    }
    stage = next;
  }

  // Vertical pass: (width x img.height) -> (width x height).
  if (height !== img.height) {
    const { starts, counts, weights, stride } = coefficients(img.height, height);
    const next = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const start = starts[y] ?? 0;
      const count = counts[y] ?? 0;
      const base = y * stride;
      const rowOut = y * rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        let sum = 0;
        for (let k = 0; k < count; k++) {
          sum += (stage[(start + k) * rowBytes + i] ?? 0) * (weights[base + k] ?? 0);
        }
        next[rowOut + i] = sum;
      }
    }
    stage = next;
  }

  return { width, height, data: stage };
}

/** Composites an image over a solid colour; the result is fully opaque. */
export function flattenRaster(img: RasterImage, background: string | Rgb = WHITE): RasterImage {
  assertSize(img);
  const [br, bg, bb] = parseColour(background);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] ?? 255;
    if (a === 255) {
      out[i] = img.data[i] ?? 0;
      out[i + 1] = img.data[i + 1] ?? 0;
      out[i + 2] = img.data[i + 2] ?? 0;
    } else {
      out[i] = ((img.data[i] ?? 0) * a + br * (255 - a)) / 255;
      out[i + 1] = ((img.data[i + 1] ?? 0) * a + bg * (255 - a)) / 255;
      out[i + 2] = ((img.data[i + 2] ?? 0) * a + bb * (255 - a)) / 255;
    }
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// --- isolated-image pipeline ------------------------------------------------

/**
 * True when the pixel, composited over white, has every channel at or above
 * `threshold`. Written in integers: `channel * a + 255 * (255 - a) >= threshold * 255`.
 */
function isNearWhite(data: Uint8ClampedArray, i: number, threshold: number): boolean {
  const a = data[i + 3] ?? 255;
  if (a === 255) {
    return (
      (data[i] ?? 0) >= threshold &&
      (data[i + 1] ?? 0) >= threshold &&
      (data[i + 2] ?? 0) >= threshold
    );
  }
  const limit = threshold * 255;
  const background = 255 * (255 - a);
  return (
    (data[i] ?? 0) * a + background >= limit &&
    (data[i + 1] ?? 0) * a + background >= limit &&
    (data[i + 2] ?? 0) * a + background >= limit
  );
}

export interface BoundingBoxOptions {
  /** A pixel whose channels are all at least this (0-255) counts as background. Default 245. */
  whiteThreshold?: number;
}

/**
 * The smallest box containing every pixel that is not near-white (see
 * `whiteThreshold`; transparent pixels count as white). `null` when the image
 * is blank.
 */
export function contentBoundingBox(img: RasterImage, options: BoundingBoxOptions = {}): Box | null {
  assertSize(img);
  const threshold = options.whiteThreshold ?? 245;
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4;
    for (let x = 0; x < img.width; x++) {
      if (isNearWhite(img.data, row + x * 4, threshold)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface PadToSquareOptions {
  /** Side of the square canvas in pixels. Default 2000. */
  size?: number;
  /** Empty border on each side, as a fraction of `size` (0 to under 0.5). Default 0.08. */
  margin?: number;
  /** Canvas colour, also what transparent pixels become. Default `#FFFFFF`. */
  background?: string | Rgb;
  /**
   * How to scale the crop. Default `resizeRaster`, which is exact and runs
   * anywhere; `resizeAuto` (image-pipeline.ts) lets the browser's canvas do
   * large resizes much faster.
   */
  resize?: (image: RasterImage, width: number, height: number) => RasterImage;
}

/**
 * Cuts `box` out of the image and centres it on a square canvas: the crop is
 * scaled (up or down) until its longer side fills the canvas minus the margin,
 * keeping its aspect ratio. With an odd leftover the extra pixel goes to the
 * right/bottom, so the margins can differ by one pixel.
 */
export function padToSquare(
  img: RasterImage,
  box: Box,
  options: PadToSquareOptions = {},
): RasterImage {
  const size = options.size ?? 2000;
  const margin = options.margin ?? 0.08;
  const background = parseColour(options.background ?? '#FFFFFF');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer.');
  if (!(margin >= 0 && margin < 0.5))
    throw new RangeError('margin must be at least 0 and below 0.5.');

  const content = flattenRaster(cropRaster(img, box), background);
  const inner = Math.max(1, size - 2 * Math.round(size * margin));
  const scale = inner / Math.max(content.width, content.height);
  const width = Math.max(1, Math.round(content.width * scale));
  const height = Math.max(1, Math.round(content.height * scale));
  const scaled =
    width === content.width && height === content.height
      ? content
      : (options.resize ?? resizeRaster)(content, width, height);

  const out = createRaster(size, size, background);
  const left = Math.floor((size - width) / 2);
  const top = Math.floor((size - height) / 2);
  for (let y = 0; y < height; y++) {
    out.data.set(
      scaled.data.subarray(y * width * 4, (y + 1) * width * 4),
      ((top + y) * size + left) * 4,
    );
  }
  return out;
}

/**
 * Turns the background to exactly #FFFFFF: starting from every near-white
 * pixel on the image border, it fills outward through connected (4-neighbour)
 * near-white pixels. White that is enclosed by the product is never reached,
 * so it is left alone. Returns a new image; the input is not changed.
 */
export function floodFillWhiteFromEdges(img: RasterImage, threshold = 245): RasterImage {
  assertSize(img);
  const { width, height } = img;
  const out = copyRaster(img);
  const data = out.data;
  const seen = new Uint8Array(width * height);
  // Every pixel is pushed at most once, so the stack never outgrows the image.
  const stack = new Int32Array(width * height);
  let top = 0;

  const visit = (pixel: number): void => {
    if (seen[pixel] === 1 || !isNearWhite(data, pixel * 4, threshold)) return;
    seen[pixel] = 1;
    stack[top++] = pixel;
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
    const pixel = stack[--top] ?? 0;
    const i = pixel * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
    const x = pixel % width;
    if (x > 0) visit(pixel - 1);
    if (x < width - 1) visit(pixel + 1);
    if (pixel >= width) visit(pixel - width);
    if (pixel < width * (height - 1)) visit(pixel + width);
  }
  return out;
}

export interface UnsharpMaskOptions {
  /** Strength: how much of the detail is added back. 0.5 is light, 1 is strong. Default 0.5. */
  amount?: number;
  /** Blur radius in pixels (Gaussian sigma). Default 1. */
  radius?: number;
  /** Differences smaller than this (0-255) are left alone. Default 0. */
  threshold?: number;
}

/** Horizontal Gaussian pass over a float plane, edges clamped. */
function blurHorizontal(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
): void {
  const half = (kernel.length - 1) / 2;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      if (x >= half && x < width - half) {
        // Away from the edges no tap needs clamping: the common case, and much faster.
        for (let k = -half; k <= half; k++) {
          sum += (source[row + x + k] ?? 0) * (kernel[k + half] ?? 0);
        }
      } else {
        for (let k = -half; k <= half; k++) {
          const j = Math.min(width - 1, Math.max(0, x + k));
          sum += (source[row + j] ?? 0) * (kernel[k + half] ?? 0);
        }
      }
      target[row + x] = sum;
    }
  }
}

/**
 * Vertical Gaussian pass, edges clamped. Adds whole rows (weighted) into a
 * row accumulator instead of walking down each column, so memory is read in
 * order: several times faster than a column walk on a large image.
 */
function blurVertical(
  source: Float32Array,
  target: Float32Array,
  width: number,
  height: number,
  kernel: Float32Array,
): void {
  const half = (kernel.length - 1) / 2;
  const row = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    row.fill(0);
    for (let k = -half; k <= half; k++) {
      const weight = kernel[k + half] ?? 0;
      const from = Math.min(height - 1, Math.max(0, y + k)) * width;
      for (let x = 0; x < width; x++) row[x] = (row[x] ?? 0) + (source[from + x] ?? 0) * weight;
    }
    const out = y * width;
    for (let x = 0; x < width; x++) target[out + x] = row[x] ?? 0;
  }
}

/**
 * Unsharp mask on the colour channels (alpha is kept): adds `amount` times the
 * difference between the image and its Gaussian blur. Flat areas, including
 * pure white, are unchanged, and results clamp at 0 and 255, so a white
 * background stays white. Returns a new image.
 */
export function unsharpMask(img: RasterImage, options: UnsharpMaskOptions = {}): RasterImage {
  assertSize(img);
  const amount = options.amount ?? 0.5;
  const sigma = Math.max(0.1, options.radius ?? 1);
  const threshold = options.threshold ?? 0;
  const out = copyRaster(img);
  if (amount === 0) return out;

  const half = Math.ceil(sigma * 3);
  const kernel = new Float32Array(half * 2 + 1);
  let total = 0;
  for (let k = -half; k <= half; k++) {
    const weight = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + half] = weight;
    total += weight;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] = (kernel[k] ?? 0) / total;

  const pixels = img.width * img.height;
  const plane = new Float32Array(pixels);
  const scratch = new Float32Array(pixels);
  const blurred = new Float32Array(pixels);
  for (let channel = 0; channel < 3; channel++) {
    for (let p = 0; p < pixels; p++) plane[p] = img.data[p * 4 + channel] ?? 0;
    blurHorizontal(plane, scratch, img.width, img.height, kernel);
    blurVertical(scratch, blurred, img.width, img.height, kernel);
    for (let p = 0; p < pixels; p++) {
      const original = plane[p] ?? 0;
      const difference = original - (blurred[p] ?? 0);
      if (Math.abs(difference) >= threshold)
        out.data[p * 4 + channel] = original + amount * difference;
    }
  }
  return out;
}

export interface IsolatedCheck {
  /** Every pixel on the image border is exactly #FFFFFF. */
  borderPureWhite: boolean;
  /** The product reaches the border: some border pixel is clearly not background (below the white threshold). */
  touchesEdge: boolean;
  /** Border pixels that are not exactly #FFFFFF. */
  nonWhiteBorderPixels: number;
}

/**
 * QA for the isolated-image tool. A border pixel that is merely off-white
 * (say 253) fails `borderPureWhite` but is not the product, so it does not set
 * `touchesEdge`; that needs a pixel below `whiteThreshold` (default 245).
 */
export function checkIsolated(img: RasterImage, options: BoundingBoxOptions = {}): IsolatedCheck {
  assertSize(img);
  const threshold = options.whiteThreshold ?? 245;
  let nonWhite = 0;
  let touches = false;
  const inspect = (x: number, y: number): void => {
    const i = (y * img.width + x) * 4;
    const pure =
      img.data[i] === 255 &&
      img.data[i + 1] === 255 &&
      img.data[i + 2] === 255 &&
      img.data[i + 3] === 255;
    if (pure) return;
    nonWhite++;
    if (!isNearWhite(img.data, i, threshold)) touches = true;
  };
  for (let x = 0; x < img.width; x++) {
    inspect(x, 0);
    if (img.height > 1) inspect(x, img.height - 1);
  }
  for (let y = 1; y < img.height - 1; y++) {
    inspect(0, y);
    if (img.width > 1) inspect(img.width - 1, y);
  }
  return { borderPureWhite: nonWhite === 0, touchesEdge: touches, nonWhiteBorderPixels: nonWhite };
}

// --- masks (image editor) ---------------------------------------------------

function assertMatch(image: { width: number; height: number }, mask: Mask): void {
  if (mask.width !== image.width || mask.height !== image.height) {
    throw new RangeError('The mask must be the same size as the image.');
  }
  if (mask.data.length !== mask.width * mask.height) {
    throw new RangeError('Mask data does not match its width and height.');
  }
}

/**
 * The marked-up reference for editing: the image with the masked area tinted.
 * OpenRouter has no mask parameter, so the editor sends this picture plus an
 * instruction ("change what is painted red"). Where the mask is 255 the
 * result is `alpha` of `colour` over the image; partial mask values blend
 * proportionally. Returns a new image.
 */
export function maskOverlay(
  image: RasterImage,
  mask: Mask,
  colour: string | Rgb = '#FF0000',
  alpha = 0.5,
): RasterImage {
  assertSize(image);
  assertMatch(image, mask);
  const [cr, cg, cb] = parseColour(colour);
  const strength = Math.min(1, Math.max(0, alpha));
  const out = copyRaster(image);
  for (let p = 0; p < mask.data.length; p++) {
    const t = ((mask.data[p] ?? 0) / 255) * strength;
    if (t === 0) continue;
    const i = p * 4;
    out.data[i] = (image.data[i] ?? 0) * (1 - t) + cr * t;
    out.data[i + 1] = (image.data[i + 1] ?? 0) * (1 - t) + cg * t;
    out.data[i + 2] = (image.data[i + 2] ?? 0) * (1 - t) + cb * t;
  }
  return out;
}

/** The mask as an opaque black-and-white picture: white = marked. */
export function maskToRaster(mask: Mask): RasterImage {
  const data = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let p = 0; p < mask.data.length; p++) {
    const value = mask.data[p] ?? 0;
    data[p * 4] = value;
    data[p * 4 + 1] = value;
    data[p * 4 + 2] = value;
    data[p * 4 + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data };
}

/** `maskToRaster` encoded as a PNG. Browser only. */
export function maskToPng(mask: Mask): Promise<Blob> {
  return toBlob(maskToRaster(mask), { type: 'image/png' });
}

// --- canvas wrappers (browser only) ------------------------------------------

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export interface EncodeOptions {
  /** `image/png` (default), `image/jpeg` or `image/webp`. Safari cannot encode WebP and returns PNG. */
  type?: string;
  /** 0-1, for JPEG and WebP. */
  quality?: number;
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(
  canvas: CanvasLike,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new InvalidInputError('This browser could not create a drawing surface.');
  return context;
}

function canvasToBlob(
  canvas: CanvasLike,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, ...(quality === undefined ? {} : { quality }) });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new InvalidInputError('The browser could not encode the image.'));
      },
      type,
      quality,
    );
  });
}

/** Pixel size of anything drawable (the natural size for images and videos). */
export function imageSize(source: CanvasImageSource): { width: number; height: number } {
  if ('naturalWidth' in source) return { width: source.naturalWidth, height: source.naturalHeight };
  if ('videoWidth' in source) return { width: source.videoWidth, height: source.videoHeight };
  if ('displayWidth' in source) return { width: source.displayWidth, height: source.displayHeight };
  if ('width' in source && typeof source.width === 'number') {
    return { width: source.width, height: source.height as number };
  }
  throw new TypeError('Cannot tell the size of this image source.');
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const href = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(href);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(href);
      reject(new InvalidInputError('This file is not an image the browser can read.'));
    };
    img.src = href;
  });
}

/**
 * Decodes an image Blob. Uses `createImageBitmap` (off the main thread, EXIF
 * orientation applied) and falls back to an `<img>` element, which also reads
 * SVG. Call `.close()` on a returned bitmap when finished with it.
 */
export async function loadImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // The bitmap decoder refuses some inputs (SVG, odd formats): try an <img>.
    }
  }
  return loadImageElement(blob);
}

/** Reads pixels from anything drawable, optionally scaled to `size`. */
export function imageDataFrom(
  source: CanvasImageSource,
  size?: { width: number; height: number },
): RasterImage {
  const { width, height } = size ?? imageSize(source);
  if (width < 1 || height < 1) throw new InvalidInputError('The image is empty.');
  const context = context2d(createCanvas(width, height));
  context.drawImage(source, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return { width, height, data };
}

/**
 * Encodes a `RasterImage` or any drawable (bitmap, `<img>`, canvas, video) as
 * a Blob. JPEG has no transparency, so it is flattened onto white first.
 */
export async function toBlob(
  image: RasterImage | CanvasImageSource,
  options: EncodeOptions = {},
): Promise<Blob> {
  const type = options.type ?? 'image/png';
  const jpeg = type === 'image/jpeg';
  let canvas: CanvasLike;
  if ('data' in image) {
    const source = jpeg ? flattenRaster(image) : image;
    canvas = createCanvas(source.width, source.height);
    context2d(canvas).putImageData(new ImageData(source.data, source.width, source.height), 0, 0);
  } else {
    const { width, height } = imageSize(image);
    canvas = createCanvas(width, height);
    const context = context2d(canvas);
    if (jpeg) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0);
  }
  return canvasToBlob(canvas, type, options.quality);
}

/** Scales anything drawable to exactly `width` x `height` with the browser's high-quality filter. */
export function resizeCanvas(source: CanvasImageSource, width: number, height: number): CanvasLike {
  const canvas = createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  const context = context2d(canvas);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * `resizeRaster` done by the browser's canvas: high-quality smoothing at
 * native speed, on the main thread or, with `OffscreenCanvas`, in a worker. The
 * exact pixels differ a little between browsers, unlike `resizeRaster`. Meant
 * for large images, where the pure version takes seconds.
 */
export function resizeRasterNative(img: RasterImage, width: number, height: number): RasterImage {
  const source = createCanvas(img.width, img.height);
  context2d(source).putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const scaled = resizeCanvas(source, width, height);
  const { data } = context2d(scaled).getImageData(0, 0, scaled.width, scaled.height);
  return { width: scaled.width, height: scaled.height, data };
}

/** Copies the `box` part of anything drawable onto a new canvas. */
export function cropCanvas(source: CanvasImageSource, box: Box): CanvasLike {
  const canvas = createCanvas(
    Math.max(1, Math.round(box.width)),
    Math.max(1, Math.round(box.height)),
  );
  context2d(canvas).drawImage(
    source,
    box.x,
    box.y,
    box.width,
    box.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas;
}

export interface DataUrlOptions {
  /** Re-encode when the file is bigger than this. Default 4 MiB. */
  maxBytes?: number;
  /** Shrink when the longer side is bigger than this. Default 2048. */
  maxDimension?: number;
  /** Format used when the image has to be re-encoded. Default `image/jpeg`. */
  type?: string;
  /** Starting quality for a re-encode. Default 0.9. */
  quality?: number;
}

/**
 * An image Blob as a `data:` URL that respects upload limits. A file that is
 * already small enough, in bytes and in pixels, is passed through untouched.
 * Otherwise it is scaled down to `maxDimension` and re-encoded, lowering the
 * quality and then the size in steps until it is under `maxBytes` (or cannot
 * get smaller). Browser only.
 */
export async function toDataUrl(blob: Blob, options: DataUrlOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  const maxDimension = options.maxDimension ?? 2048;
  const type = options.type ?? 'image/jpeg';

  const source = await loadImage(blob);
  try {
    const { width, height } = imageSize(source);
    if (blob.size <= maxBytes && Math.max(width, height) <= maxDimension) {
      return await readAsDataUrl(blob);
    }
    let target = fitWithin(width, height, maxDimension);
    let quality = options.quality ?? 0.9;
    let encoded = await toBlob(resizeCanvas(source, target.width, target.height), {
      type,
      quality,
    });
    for (let attempt = 0; attempt < 8 && encoded.size > maxBytes; attempt++) {
      if (quality > 0.55) {
        quality -= 0.15;
      } else {
        target = {
          width: Math.max(1, Math.round(target.width * 0.8)),
          height: Math.max(1, Math.round(target.height * 0.8)),
        };
      }
      encoded = await toBlob(resizeCanvas(source, target.width, target.height), { type, quality });
    }
    return await readAsDataUrl(encoded);
  } finally {
    if ('close' in source) source.close();
  }
}
