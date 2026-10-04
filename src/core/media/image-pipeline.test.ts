// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkIsolated,
  contentBoundingBox,
  createRaster,
  floodFillWhiteFromEdges,
  padToSquare,
  type RasterImage,
  unsharpMask,
} from './image';
import {
  adaptiveThreshold,
  fillAndDespeckle,
  isolateRaster,
  MIN_ADAPTIVE_THRESHOLD,
  resizeAuto,
} from './image-pipeline';

function fillRect(
  img: RasterImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: number[],
): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) img.data.set([...rgb, 255], (yy * img.width + xx) * 4);
  }
}

/** A 120 x 90 "photo": nearly white background, a blue product. */
function photo(): RasterImage {
  const img = createRaster(120, 90, '#fbfbfb');
  fillRect(img, 30, 20, 50, 40, [20, 80, 160]);
  return img;
}

// Deep `toEqual` over whole images is slow on a loaded machine; the default 5 s is not enough there.
describe('isolateRaster', { timeout: 30_000 }, () => {
  it('is the pipeline step by step: box, square, white fill, sharpen, QA', () => {
    const source = photo();
    const result = isolateRaster(source, { size: 200 });

    const box = contentBoundingBox(source) ?? { x: 0, y: 0, width: 120, height: 90 };
    expect(box).toEqual({ x: 30, y: 20, width: 50, height: 40 });
    const expected = unsharpMask(
      floodFillWhiteFromEdges(padToSquare(source, box, { size: 200, background: '#FFFFFF' })),
      { amount: 0.5, radius: 1 },
    );
    expect(result.box).toEqual(box);
    expect(result.image.width).toBe(200);
    expect(result.image.data).toEqual(expected.data);
    expect(result.check).toEqual(checkIsolated(expected));
    expect(result.check).toEqual({
      borderPureWhite: true,
      touchesEdge: false,
      nonWhiteBorderPixels: 0,
    });
  });

  it('does not change its input', () => {
    const source = photo();
    const before = new Uint8ClampedArray(source.data);
    isolateRaster(source, { size: 100 });
    expect(source.data).toEqual(before);
  });

  it('follows the options: box, margin, threshold, sharpening off', () => {
    const source = photo();
    const box = { x: 20, y: 10, width: 70, height: 60 };
    const plain = isolateRaster(source, { box, size: 100, margin: 0, sharpen: false });
    expect(plain.box).toEqual(box);
    const filled = floodFillWhiteFromEdges(padToSquare(source, box, { size: 100, margin: 0 }));
    expect(plain.image.data).toEqual(filled.data);

    const sharp = isolateRaster(source, {
      box,
      size: 100,
      margin: 0,
      sharpen: { amount: 2, radius: 1.5 },
    });
    expect(sharp.image.data).not.toEqual(plain.image.data);

    // At a stricter threshold the 251 background counts as content and is not filled; the margin still is white.
    const strict = isolateRaster(source, { box, size: 100, margin: 0.1, whiteThreshold: 252 });
    expect(strict.check.borderPureWhite).toBe(true); // the padding is pure white already
  });

  it('flags a product that touches the edge', () => {
    const source = createRaster(50, 50, '#ffffff');
    fillRect(source, 0, 0, 50, 50, [0, 0, 0]);
    const { check } = isolateRaster(source, { size: 100, margin: 0 });
    expect(check.touchesEdge).toBe(true);
  });

  it('handles an image with no content: the whole image is the box and the result is white', () => {
    const blank = createRaster(40, 30, '#fcfcfc');
    const result = isolateRaster(blank, { size: 60 });
    expect(result.box).toEqual({ x: 0, y: 0, width: 40, height: 30 });
    expect(result.check.borderPureWhite).toBe(true);
    expect(new Set(result.image.data)).toEqual(new Set([255]));
  });
});

/** A deterministic pseudo-random sequence in [0, 1) (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 160 x 120 edit-model answer: a navy product with a white label, on `level` plus or minus `noise`. */
function offWhitePhoto(level: number, noise: number, seed = 1): RasterImage {
  const next = random(seed);
  const img = createRaster(160, 120, '#ffffff');
  for (let i = 0; i < img.data.length; i += 4) {
    const value = level + Math.round((next() * 2 - 1) * noise);
    img.data[i] = value;
    img.data[i + 1] = value;
    img.data[i + 2] = value;
  }
  fillRect(img, 50, 30, 60, 50, [20, 30, 90]);
  fillRect(img, 60, 40, 40, 30, [250, 250, 250]);
  return img;
}

/** `adaptiveThreshold`'s threshold, for the cases where it found the background. */
const adapted = (img: RasterImage, threshold: number): number => {
  const result = adaptiveThreshold(img, threshold);
  expect(result.found).toBe(true);
  return result.threshold;
};

describe('adaptiveThreshold', () => {
  it('keeps the threshold when the background is clean and light enough', () => {
    expect(adaptiveThreshold(createRaster(40, 30, '#fbfbfb'), 245)).toEqual({
      threshold: 245,
      found: true,
    });
    expect(adapted(createRaster(40, 30, '#ffffff'), 245)).toBe(245);
  });

  it('stays clear of the noise of a light background, so a shadow’s faint tail does not cross it', () => {
    const light = adapted(offWhitePhoto(252, 3), 245);
    expect(light).toBeLessThan(245);
    expect(light).toBeGreaterThan(230);
  });

  it('goes below an even off-white background and its noise, never above the threshold', () => {
    expect(adapted(createRaster(40, 30, '#f0f0f0'), 245)).toBe(237);
    const noisy = adapted(offWhitePhoto(240, 3), 245);
    expect(noisy).toBeLessThan(237);
    expect(noisy).toBeGreaterThanOrEqual(MIN_ADAPTIVE_THRESHOLD);
    expect(adapted(createRaster(40, 30, '#f0f0f0'), 230)).toBe(230);
  });

  it('reads the background past a product that reaches part of the border', () => {
    const cut = offWhitePhoto(240, 3);
    fillRect(cut, 0, 30, 60, 50, [20, 30, 90]);
    expect(adapted(cut, 245)).toBeLessThan(237);
    const { box } = isolateRaster(cut, { size: 100, adaptThreshold: true });
    expect(box).toEqual({ x: 0, y: 30, width: 110, height: 50 });
  });

  it('never drops to a pale product that covers most of the border, so the QA cannot falsely pass', () => {
    // 200 x 150 on 250 (plus or minus 2); a pale product (228) covers 60% of the border.
    const next = random(5);
    const img = createRaster(200, 150, '#ffffff');
    for (let i = 0; i < img.data.length; i += 4) {
      const value = 250 + Math.round((next() * 2 - 1) * 2);
      img.data.set([value, value, value], i);
    }
    fillRect(img, 0, 40, 200, 110, [228, 228, 228]);
    const threshold = adapted(img, 245);
    expect(threshold).toBeGreaterThan(230);
    // The product stays content: its box reaches the photo's edges, which the QA reports.
    const result = isolateRaster(img, {
      size: 200,
      adaptThreshold: true,
      despeckle: true,
      sharpen: false,
    });
    expect(result.box).toEqual({ x: 0, y: 40, width: 200, height: 110 });
    expect(result.backgroundUnclear).toBe(false);
    // Even a product 12 below the background stays content.
    fillRect(img, 0, 40, 200, 110, [238, 238, 238]);
    expect(adapted(img, 245)).toBeGreaterThan(238);
  });

  it('falls back to the fixed threshold and says so when the border shows no background', () => {
    expect(adaptiveThreshold(createRaster(40, 30, '#808080'), 245)).toEqual({
      threshold: 245,
      found: false,
    });
    expect(adaptiveThreshold(offWhitePhoto(225, 12), 245)).toEqual({
      threshold: 245,
      found: false,
    });
    // A product that covers nearly all of the border leaves too little background to read.
    const filled = createRaster(100, 200, '#fafafa');
    fillRect(filled, 0, 1, 100, 199, [235, 235, 235]);
    expect(adaptiveThreshold(filled, 245).found).toBe(false);
    const result = isolateRaster(filled, { size: 100, adaptThreshold: true });
    expect(result.threshold).toBe(245);
    expect(result.backgroundUnclear).toBe(true);
    // Without adaptThreshold nothing is estimated, so nothing is unclear.
    expect(isolateRaster(filled, { size: 100 }).backgroundUnclear).toBe(false);
  });

  it('reads light over white for transparent pixels', () => {
    const clear = createRaster(20, 20, '#000000');
    for (let i = 3; i < clear.data.length; i += 4) clear.data[i] = 0;
    expect(adapted(clear, 245)).toBe(245);
  });
});

describe('isolateRaster with adaptThreshold', () => {
  it('finds the product on a noisy off-white background and fills all of that background', () => {
    const source = offWhitePhoto(242, 3, 7);
    const plain = isolateRaster(source, { size: 200, sharpen: false });
    const adapted = isolateRaster(source, { size: 200, sharpen: false, adaptThreshold: true });

    // At 245 the noise below it counts as content: the box is nearly the whole photo.
    expect(plain.threshold).toBe(245);
    expect(plain.box.width).toBeGreaterThan(150);
    // Adapted, the box is the product and every background pixel is pure white.
    expect(adapted.threshold).toBeLessThan(239);
    expect(adapted.box).toEqual({ x: 50, y: 30, width: 60, height: 50 });
    expect(adapted.check).toEqual({
      borderPureWhite: true,
      touchesEdge: false,
      nonWhiteBorderPixels: 0,
    });
    const { data, width } = adapted.image;
    const pixel = (x: number, y: number): number[] => [
      ...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3),
    ];
    expect(pixel(5, 5)).toEqual([255, 255, 255]);
    // The label inside the product is near-white too, but enclosed: it keeps its colour.
    expect(pixel(100, 100)).toEqual([250, 250, 250]);
  });

  it('is the plain pipeline when the background needs nothing', () => {
    const source = photo();
    const adapted = isolateRaster(source, { size: 120, adaptThreshold: true });
    const plain = isolateRaster(source, { size: 120 });
    expect(adapted.threshold).toBe(245);
    // Compared as bytes: a deep `toEqual` over 57,600 values takes seconds on a busy machine.
    expect(Buffer.from(adapted.image.data).equals(Buffer.from(plain.image.data))).toBe(true);
  });
});

const at = (img: RasterImage, x: number, y: number): number[] => [
  ...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3),
];

/** A shadow's fringe where it fades through the threshold: single pixels and a pair just below 245. */
const SPECKS: [number, number][] = [
  [25, 85],
  [135, 83],
  [30, 95],
  [128, 92],
  [80, 100],
  [20, 82],
  [21, 82],
];

/** 160 x 120 at 250, a navy product, the core of its shadow (230) and the specks around it. */
function shadowPhoto(): RasterImage {
  const img = createRaster(160, 120, '#fafafa');
  for (let y = 77; y <= 87; y++) {
    for (let x = 40; x <= 120; x++) {
      if (((x - 80) / 40) ** 2 + ((y - 82) / 5) ** 2 <= 1)
        img.data.set([230, 230, 230, 255], (y * 160 + x) * 4);
    }
  }
  fillRect(img, 50, 30, 60, 50, [20, 30, 90]);
  for (const [x, y] of SPECKS) img.data.set([243, 243, 243, 255], (y * 160 + x) * 4);
  return img;
}

describe('fillAndDespeckle', () => {
  it('whitens the background and light specks; keeps the product with all inside it, and darker or larger groups', () => {
    const img = createRaster(100, 80, '#f8f8f8');
    fillRect(img, 30, 20, 40, 40, [20, 30, 90]); // the product
    fillRect(img, 38, 28, 24, 24, [250, 250, 250]); // its white label
    fillRect(img, 45, 35, 4, 2, [230, 230, 230]); // light print on the label
    fillRect(img, 10, 10, 2, 2, [238, 238, 238]); // a light speck
    fillRect(img, 85, 60, 2, 2, [60, 60, 60]); // a small dark part
    fillRect(img, 0, 70, 3, 3, [238, 238, 238]); // light, but on the edge
    fillRect(img, 80, 10, 10, 10, [240, 240, 240]); // light, but larger than a speck
    const out = fillAndDespeckle(img, 245);
    expect(at(out, 5, 5)).toEqual([255, 255, 255]);
    expect(at(out, 10, 10)).toEqual([255, 255, 255]);
    expect(at(out, 40, 30)).toEqual([250, 250, 250]);
    expect(at(out, 46, 36)).toEqual([230, 230, 230]);
    expect(at(out, 31, 21)).toEqual([20, 30, 90]);
    expect(at(out, 85, 60)).toEqual([60, 60, 60]);
    expect(at(out, 0, 70)).toEqual([238, 238, 238]);
    expect(at(out, 85, 15)).toEqual([240, 240, 240]);
    expect(img.data[(10 * 100 + 10) * 4]).toBe(238); // the input is not changed
  });

  it('leaves no grey dots where a soft shadow fades through the threshold, and keeps the box to it', () => {
    const source = shadowPhoto();
    const plain = isolateRaster(source, { size: 200, sharpen: false });
    const clean = isolateRaster(source, { size: 200, sharpen: false, despeckle: true });
    // Without despeckling the specks widen the box (and stay, as grey dots)…
    expect(plain.box).toEqual({ x: 20, y: 30, width: 116, height: 71 });
    // …with it they are white, and the box is the product and its shadow.
    expect(clean.box).toEqual({ x: 40, y: 30, width: 81, height: 58 });
    const cleaned = fillAndDespeckle(source, 245);
    for (const [x, y] of SPECKS) expect(at(cleaned, x, y)).toEqual([255, 255, 255]);
    expect(at(cleaned, 80, 85)).toEqual([230, 230, 230]);
    expect(at(cleaned, 5, 5)).toEqual([255, 255, 255]);
    expect(clean.check.borderPureWhite).toBe(true);
  });

  it('keeps thin and pale product details: a diagonal line, a long string, a bead', () => {
    const img = createRaster(600, 400, '#fafafa');
    fillRect(img, 40, 40, 60, 60, [20, 30, 90]); // a box
    // A 1-pixel diagonal line at 215 leaving the box's corner: its pixels only touch at their corners.
    for (let i = 0; i < 120; i++)
      img.data.set([215, 215, 215, 255], ((100 + i) * 600 + 100 + i) * 4);
    fillRect(img, 50, 300, 490, 3, [220, 220, 220]); // a 3 x 490 string, on its own
    fillRect(img, 450, 60, 30, 30, [230, 230, 230]); // a 30 x 30 bead, on its own
    fillRect(img, 300, 150, 1, 9, [236, 236, 236]); // a 1 x 9 thread
    // A pale highlight 2 px off the box, not touching it.
    fillRect(img, 102, 60, 2, 2, [238, 238, 238]);
    fillRect(img, 300, 60, 3, 3, [238, 238, 238]); // a speck: compact, small, alone
    const out = fillAndDespeckle(img, 245);
    for (let i = 0; i < 120; i += 7) expect(at(out, 100 + i, 100 + i)).toEqual([215, 215, 215]);
    expect(at(out, 60, 301)).toEqual([220, 220, 220]);
    expect(at(out, 535, 301)).toEqual([220, 220, 220]);
    expect(at(out, 465, 75)).toEqual([230, 230, 230]);
    expect(at(out, 300, 154)).toEqual([236, 236, 236]);
    expect(at(out, 102, 60)).toEqual([238, 238, 238]);
    expect(at(out, 301, 61)).toEqual([255, 255, 255]);
    // The same bead in a large picture (where 0.1% of the pixels was more than its 900).
    const large = createRaster(1000, 1000, '#fafafa');
    fillRect(large, 400, 400, 30, 30, [230, 230, 230]);
    expect(at(fillAndDespeckle(large, 245), 415, 415)).toEqual([230, 230, 230]);
  });
});

describe('resizeAuto', () => {
  it('is the exact resampler where there is no canvas', () => {
    const resized = resizeAuto(photo(), 60, 45);
    expect([resized.width, resized.height]).toEqual([60, 45]);
  });
});
