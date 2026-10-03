// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  checkIsolated,
  contentBoundingBox,
  createRaster,
  cropRaster,
  fitWithin,
  flattenRaster,
  floodFillWhiteFromEdges,
  maskOverlay,
  maskToRaster,
  padToSquare,
  parseColour,
  resizeRaster,
  type RasterImage,
  unsharpMask,
} from './image';

type Rgb = [number, number, number];

function pixel(img: RasterImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i] ?? -1, img.data[i + 1] ?? -1, img.data[i + 2] ?? -1, img.data[i + 3] ?? -1];
}

function setPixel(img: RasterImage, x: number, y: number, [r, g, b]: Rgb, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data.set([r, g, b, a], i);
}

function fillRect(img: RasterImage, x: number, y: number, w: number, h: number, colour: Rgb): void {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) setPixel(img, xx, yy, colour);
}

describe('parseColour', () => {
  it('reads short and long hex', () => {
    expect(parseColour('#fff')).toEqual([255, 255, 255]);
    expect(parseColour('#0a0B0c')).toEqual([10, 11, 12]);
    expect(parseColour([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('rejects anything else', () => {
    expect(() => parseColour('red')).toThrow(/hex colour/);
    expect(() => parseColour('#12345')).toThrow(/hex colour/);
  });
});

describe('cropRaster and fitWithin', () => {
  it('crops, clamping to the image', () => {
    const img = createRaster(4, 3, '#000000');
    setPixel(img, 2, 1, [9, 8, 7]);
    const crop = cropRaster(img, { x: 2, y: 1, width: 10, height: 10 });
    expect([crop.width, crop.height]).toEqual([2, 2]);
    expect(pixel(crop, 0, 0)).toEqual([9, 8, 7, 255]);
    const negative = cropRaster(img, { x: -5, y: -5, width: 6, height: 6 });
    expect([negative.width, negative.height]).toEqual([1, 1]);
  });

  it('throws when the crop is outside the image', () => {
    expect(() => cropRaster(createRaster(4, 4), { x: 10, y: 10, width: 2, height: 2 })).toThrow(
      /outside/,
    );
  });

  it('fits within a limit without enlarging unless asked', () => {
    expect(fitWithin(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(fitWithin(500, 300, 1000)).toEqual({ width: 500, height: 300 });
    expect(fitWithin(500, 300, 1000, true)).toEqual({ width: 1000, height: 600 });
    expect(fitWithin(1000, 1000, { width: 100, height: 50 })).toEqual({ width: 50, height: 50 });
    expect(fitWithin(10000, 1, 100)).toEqual({ width: 100, height: 1 });
  });
});

describe('resizeRaster', () => {
  it('keeps a flat colour flat in both directions', () => {
    const red = createRaster(100, 50, '#ff0000');
    for (const [w, h] of [
      [33, 17],
      [250, 125],
      [100, 20],
      [7, 50],
    ] as const) {
      const out = resizeRaster(red, w, h);
      expect([out.width, out.height]).toEqual([w, h]);
      expect(new Set(Array.from(out.data)).size).toBe(2); // only 255 and 0
      expect(pixel(out, w - 1, h - 1)).toEqual([255, 0, 0, 255]);
    }
  });

  it('averages when shrinking', () => {
    const checker = createRaster(16, 16, '#000000');
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) if ((x + y) % 2 === 0) setPixel(checker, x, y, [255, 255, 255]);
    }
    const out = resizeRaster(checker, 4, 4);
    // Away from the borders every output pixel covers whole periods of the pattern.
    for (const [x, y] of [
      [1, 1],
      [2, 1],
      [1, 2],
      [2, 2],
    ] as const) {
      expect(Math.abs(pixel(out, x, y)[0] - 127.5)).toBeLessThanOrEqual(1);
    }
  });

  it('interpolates when enlarging', () => {
    const gradient = createRaster(2, 1, '#000000');
    setPixel(gradient, 1, 0, [200, 200, 200]);
    const out = resizeRaster(gradient, 4, 1);
    const values = [0, 1, 2, 3].map((x) => pixel(out, x, 0)[0]);
    expect(values[0]).toBeLessThan(values[1] ?? 0);
    expect(values[1]).toBeLessThan(values[2] ?? 0);
    expect(values[2]).toBeLessThan(values[3] ?? 0);
  });

  it('returns a copy when the size is unchanged', () => {
    const img = createRaster(3, 3, '#123456');
    const out = resizeRaster(img, 3, 3);
    expect(out.data).not.toBe(img.data);
    expect(out.data).toEqual(img.data);
  });
});

describe('flattenRaster', () => {
  it('composites transparency over the background', () => {
    const img = createRaster(2, 1, '#000000');
    setPixel(img, 0, 0, [0, 0, 0], 0);
    setPixel(img, 1, 0, [0, 0, 0], 128);
    const out = flattenRaster(img, '#ffffff');
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 1, 0)).toEqual([127, 127, 127, 255]);
  });
});

describe('contentBoundingBox', () => {
  it('finds the product on a white background', () => {
    const img = createRaster(100, 80);
    fillRect(img, 20, 10, 40, 30, [30, 60, 90]);
    expect(contentBoundingBox(img)).toEqual({ x: 20, y: 10, width: 40, height: 30 });
  });

  it('returns null for a blank image', () => {
    expect(contentBoundingBox(createRaster(10, 10))).toBeNull();
  });

  it('ignores near-white noise at the default threshold, and honours a stricter one', () => {
    const img = createRaster(10, 10);
    setPixel(img, 0, 0, [250, 250, 250]);
    expect(contentBoundingBox(img)).toBeNull();
    expect(contentBoundingBox(img, { whiteThreshold: 255 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });

  it('treats transparent pixels as background', () => {
    const img = createRaster(10, 10);
    setPixel(img, 5, 5, [0, 0, 0], 0);
    expect(contentBoundingBox(img)).toBeNull();
    setPixel(img, 5, 5, [0, 0, 0], 255);
    expect(contentBoundingBox(img)).toEqual({ x: 5, y: 5, width: 1, height: 1 });
  });
});

describe('padToSquare', () => {
  it('centres the product with the margin', () => {
    const img = createRaster(60, 40);
    fillRect(img, 10, 10, 20, 10, [255, 0, 0]);
    const box = contentBoundingBox(img);
    expect(box).toEqual({ x: 10, y: 10, width: 20, height: 10 });
    if (!box) return;

    const out = padToSquare(img, box, { size: 100, margin: 0.1 });
    expect([out.width, out.height]).toEqual([100, 100]);
    // The longer side fills 100 - 2 x 10 = 80 pixels; aspect ratio 2:1 gives 80 x 40, centred.
    expect(contentBoundingBox(out)).toEqual({ x: 10, y: 30, width: 80, height: 40 });
    expect(pixel(out, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(pixel(out, 5, 5)).toEqual([255, 255, 255, 255]);
  });

  it('handles odd sizes, putting the extra pixel on the right and bottom', () => {
    const img = createRaster(50, 50);
    fillRect(img, 5, 5, 33, 21, [0, 0, 0]);
    const out = padToSquare(
      img,
      { x: 5, y: 5, width: 33, height: 21 },
      { size: 101, margin: 0.08 },
    );
    // margin = round(8.08) = 8, inner = 85, scale = 85/33, height = round(21 x 85/33) = 54.
    expect(contentBoundingBox(out, { whiteThreshold: 128 })).toEqual({
      x: 8,
      y: 23,
      width: 85,
      height: 54,
    });
    expect(out.width).toBe(101);
  });

  it('uses the whole canvas with no margin, and enlarges small products', () => {
    const img = createRaster(20, 20);
    fillRect(img, 8, 8, 4, 4, [0, 0, 0]);
    const out = padToSquare(img, { x: 8, y: 8, width: 4, height: 4 }, { size: 40, margin: 0 });
    expect(contentBoundingBox(out, { whiteThreshold: 128 })).toEqual({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
    });
  });

  it('flattens transparency onto the background colour', () => {
    const img = createRaster(10, 10, '#000000');
    setPixel(img, 4, 4, [0, 0, 0], 0);
    const out = padToSquare(
      img,
      { x: 4, y: 4, width: 1, height: 1 },
      { size: 10, margin: 0, background: '#00ff00' },
    );
    expect(pixel(out, 5, 5)).toEqual([0, 255, 0, 255]);
  });

  it('rejects impossible options', () => {
    const img = createRaster(10, 10);
    const box = { x: 0, y: 0, width: 5, height: 5 };
    expect(() => padToSquare(img, box, { margin: 0.5 })).toThrow(/margin/);
    expect(() => padToSquare(img, box, { margin: -0.1 })).toThrow(/margin/);
    expect(() => padToSquare(img, box, { size: 0 })).toThrow(/size/);
  });
});

describe('floodFillWhiteFromEdges', () => {
  /** A 20 x 20 photo: off-white background (250), a black ring, off-white (252) enclosed inside it. */
  function ringed(): RasterImage {
    const img = createRaster(20, 20, '#fafafa');
    for (let i = 5; i <= 14; i++) {
      for (const [x, y] of [
        [i, 5],
        [i, 14],
        [5, i],
        [14, i],
      ] as const)
        setPixel(img, x, y, [0, 0, 0]);
    }
    fillRect(img, 6, 6, 8, 8, [252, 252, 252]);
    return img;
  }

  it('turns only the background connected to the border pure white', () => {
    const img = ringed();
    const out = floodFillWhiteFromEdges(img);
    expect(pixel(out, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 19, 19)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 3, 10)).toEqual([255, 255, 255, 255]);
    expect(pixel(out, 5, 5)).toEqual([0, 0, 0, 255]);
    // White inside the product is not background: untouched.
    expect(pixel(out, 10, 10)).toEqual([252, 252, 252, 255]);
    expect(pixel(out, 6, 6)).toEqual([252, 252, 252, 255]);
    // The input is not modified.
    expect(pixel(img, 0, 0)).toEqual([250, 250, 250, 255]);
  });

  it('respects the threshold', () => {
    const img = createRaster(6, 6, '#f0f0f0'); // 240
    expect(pixel(floodFillWhiteFromEdges(img), 0, 0)).toEqual([240, 240, 240, 255]);
    expect(pixel(floodFillWhiteFromEdges(img, 235), 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('does not start from border pixels that are product', () => {
    const img = createRaster(10, 10, '#fafafa');
    fillRect(img, 0, 0, 10, 1, [0, 0, 0]); // product along the whole top edge
    const out = floodFillWhiteFromEdges(img);
    expect(pixel(out, 5, 0)).toEqual([0, 0, 0, 255]);
    expect(pixel(out, 5, 5)).toEqual([255, 255, 255, 255]); // still reached from the other edges
  });

  it('fills a large image without recursion trouble', () => {
    const out = floodFillWhiteFromEdges(createRaster(1200, 1200, '#fdfdfd'));
    expect(pixel(out, 600, 600)).toEqual([255, 255, 255, 255]);
  });

  it('counts transparent pixels as white', () => {
    const img = createRaster(4, 4, '#000000');
    for (let p = 0; p < 16; p++) img.data[p * 4 + 3] = 0;
    expect(pixel(floodFillWhiteFromEdges(img), 2, 2)).toEqual([255, 255, 255, 255]);
  });
});

describe('unsharpMask', () => {
  it('leaves flat areas, including pure white, exactly as they are', () => {
    expect(unsharpMask(createRaster(8, 8)).data).toEqual(createRaster(8, 8).data);
    const gray = createRaster(8, 8, '#808080');
    expect(unsharpMask(gray, { amount: 2, radius: 2 }).data).toEqual(gray.data);
  });

  it('steepens an edge and keeps white clamped at 255', () => {
    const img = createRaster(20, 1, '#ffffff');
    fillRect(img, 0, 0, 10, 1, [50, 50, 50]);
    const out = unsharpMask(img, { amount: 1, radius: 1 });
    expect(pixel(out, 9, 0)[0]).toBeLessThan(50);
    expect(pixel(out, 10, 0)[0]).toBe(255);
    expect(pixel(out, 0, 0)[0]).toBe(50);
    expect(pixel(out, 19, 0)[0]).toBe(255);
  });

  it('keeps alpha and does nothing at amount 0', () => {
    const img = createRaster(4, 4, '#336699');
    setPixel(img, 1, 1, [10, 20, 30], 77);
    expect(pixel(unsharpMask(img), 1, 1)[3]).toBe(77);
    expect(unsharpMask(img, { amount: 0 }).data).toEqual(img.data);
  });

  it('skips differences below the threshold', () => {
    const img = createRaster(20, 1, '#ffffff');
    fillRect(img, 0, 0, 10, 1, [250, 250, 250]);
    expect(unsharpMask(img, { amount: 3, threshold: 20 }).data).toEqual(img.data);
  });
});

describe('checkIsolated', () => {
  it('passes a clean image', () => {
    expect(checkIsolated(createRaster(10, 10))).toEqual({
      borderPureWhite: true,
      touchesEdge: false,
      nonWhiteBorderPixels: 0,
    });
  });

  it('detects an off-white border pixel without calling it the product', () => {
    const img = createRaster(10, 10);
    setPixel(img, 0, 5, [254, 254, 254]);
    expect(checkIsolated(img)).toEqual({
      borderPureWhite: false,
      touchesEdge: false,
      nonWhiteBorderPixels: 1,
    });
  });

  it('detects the product touching the edge', () => {
    const img = createRaster(10, 10);
    setPixel(img, 3, 0, [100, 100, 100]);
    setPixel(img, 9, 9, [254, 255, 255]);
    expect(checkIsolated(img)).toEqual({
      borderPureWhite: false,
      touchesEdge: true,
      nonWhiteBorderPixels: 2,
    });
  });

  it('ignores off-white pixels in the interior', () => {
    const img = createRaster(10, 10);
    setPixel(img, 5, 5, [0, 0, 0]);
    expect(checkIsolated(img).borderPureWhite).toBe(true);
  });

  it('counts each border pixel once, also on a 1-pixel-wide image', () => {
    const img = createRaster(1, 5, '#000000');
    expect(checkIsolated(img).nonWhiteBorderPixels).toBe(5);
    expect(checkIsolated(createRaster(1, 1, '#000000')).nonWhiteBorderPixels).toBe(1);
  });

  it('sees a transparent border pixel as not pure white', () => {
    const img = createRaster(4, 4);
    img.data[3] = 0;
    expect(checkIsolated(img).borderPureWhite).toBe(false);
  });

  it('passes the output of the whole pipeline', () => {
    const photo = createRaster(120, 90, '#fbfbfb');
    fillRect(photo, 30, 20, 50, 40, [20, 80, 160]);
    const box = contentBoundingBox(photo);
    if (!box) throw new Error('no content');
    const square = padToSquare(photo, box, { size: 200, margin: 0.08 });
    const white = floodFillWhiteFromEdges(square);
    const sharp = unsharpMask(white, { amount: 0.5, radius: 1 });
    expect(checkIsolated(sharp)).toEqual({
      borderPureWhite: true,
      touchesEdge: false,
      nonWhiteBorderPixels: 0,
    });
  });
});

describe('masks', () => {
  it('tints the masked area', () => {
    const img = createRaster(2, 1, '#646464');
    const out = maskOverlay(
      img,
      { width: 2, height: 1, data: new Uint8Array([255, 0]) },
      '#c80000',
      0.5,
    );
    expect(pixel(out, 0, 0)).toEqual([150, 50, 50, 255]);
    expect(pixel(out, 1, 0)).toEqual([100, 100, 100, 255]);
    expect(pixel(img, 0, 0)).toEqual([100, 100, 100, 255]);
  });

  it('blends partial coverage proportionally', () => {
    const img = createRaster(1, 1, '#000000');
    const out = maskOverlay(
      img,
      { width: 1, height: 1, data: new Uint8Array([102]) },
      '#ff0000',
      1,
    );
    expect(pixel(out, 0, 0)[0]).toBe(102);
  });

  it('refuses a mask of another size', () => {
    expect(() =>
      maskOverlay(createRaster(2, 2), { width: 1, height: 1, data: new Uint8Array(1) }),
    ).toThrow(/same size/);
  });

  it('renders a mask as black and white', () => {
    const raster = maskToRaster({ width: 2, height: 1, data: new Uint8Array([255, 0]) });
    expect(pixel(raster, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(raster, 1, 0)).toEqual([0, 0, 0, 255]);
  });
});
