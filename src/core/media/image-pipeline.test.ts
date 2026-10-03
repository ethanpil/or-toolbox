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
import { isolateRaster, resizeAuto } from './image-pipeline';

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

describe('isolateRaster', () => {
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

describe('resizeAuto', () => {
  it('is the exact resampler where there is no canvas', () => {
    const resized = resizeAuto(photo(), 60, 45);
    expect([resized.width, resized.height]).toEqual([60, 45]);
  });
});
