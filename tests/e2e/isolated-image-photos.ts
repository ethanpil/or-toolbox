/**
 * The Isolated image test set, drawn in Node (no canvas, no fixtures on disk): 20 synthetic products of varied
 * shapes and colours, eight of them with a white part inside (a label, a screen, a plate's middle at 249), each
 * as
 *
 * - a **photo** (what the user uploads): the product on a busy background (gradient, noise, colour, stripes);
 * - an **isolation** (what the mocked edit model answers): the same product on an imperfect white, as models
 *   really return it: an off-white background between 240 and 252 with noise, a soft shadow under the product,
 *   the product a little off-centre, and pictures of varied aspect ratios.
 *
 * Both are PNGs (a small encoder below; Node has no image codec). Deterministic: the same seed draws the same
 * pixels on every run.
 */
import { deflateSync } from 'node:zlib';

type Rgb = readonly [number, number, number];

/** An RGB picture being drawn. */
interface Picture {
  width: number;
  height: number;
  data: Float32Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An 8-bit RGB PNG of the picture (values rounded and clamped). */
export function encodePng(picture: Picture): Buffer {
  const { width, height, data } = picture;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < width * 3; i++) {
      raw[y * stride + 1 + i] = Math.min(
        255,
        Math.max(0, Math.round(data[y * width * 3 + i] ?? 0)),
      );
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** mulberry32: a small seeded generator in [0, 1). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function picture(width: number, height: number, fill: (x: number, y: number) => Rgb): Picture {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 3);
  }
  return { width, height, data };
}

/** Where a product sits in a picture, in pixels. */
interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A shape in the product's own unit square: true where (u, v) is inside. */
type Shape = (u: number, v: number) => boolean;

const rect =
  (u0: number, v0: number, u1: number, v1: number): Shape =>
  (u, v) =>
    u >= u0 && u <= u1 && v >= v0 && v <= v1;
const ellipse =
  (cu: number, cv: number, ru: number, rv: number): Shape =>
  (u, v) =>
    ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2 <= 1;
const roundRect =
  (u0: number, v0: number, u1: number, v1: number, r: number): Shape =>
  (u, v) => {
    if (u < u0 || u > u1 || v < v0 || v > v1) return false;
    const du = Math.max(u0 + r - u, 0, u - (u1 - r));
    const dv = Math.max(v0 + r - v, 0, v - (v1 - r));
    return du * du + dv * dv <= r * r;
  };
const union =
  (...shapes: Shape[]): Shape =>
  (u, v) =>
    shapes.some((shape) => shape(u, v));
/** A lamp shade: narrow at the top, wide at the bottom. */
const trapezoid =
  (v0: number, v1: number, top: number, bottom: number): Shape =>
  (u, v) => {
    if (v < v0 || v > v1) return false;
    const half = (top + ((v - v0) / (v1 - v0)) * (bottom - top)) / 2;
    return Math.abs(u - 0.5) <= half;
  };

/** Paints `shape` placed at `at`, with 4 x 4 supersampled edges (anti-aliased like a real photo). */
function paint(target: Picture, at: Placement, shape: Shape, colour: Rgb): void {
  const x0 = Math.max(0, Math.floor(at.x));
  const y0 = Math.max(0, Math.floor(at.y));
  const x1 = Math.min(target.width, Math.ceil(at.x + at.width));
  const y1 = Math.min(target.height, Math.ceil(at.y + at.height));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let inside = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = (x + (sx + 0.5) / 4 - at.x) / at.width;
          const v = (y + (sy + 0.5) / 4 - at.y) / at.height;
          if (shape(u, v)) inside += 1;
        }
      }
      if (inside === 0) continue;
      const cover = inside / 16;
      const i = (y * target.width + x) * 3;
      for (let c = 0; c < 3; c++) {
        target.data[i + c] = (target.data[i + c] ?? 0) * (1 - cover) + (colour[c] ?? 0) * cover;
      }
    }
  }
}

/** The white inside some products: flat 249, which the flood fill must never reach. */
export const INTERIOR_WHITE = 249;
const WHITE_PART: Rgb = [INTERIOR_WHITE, INTERIOR_WHITE, INTERIOR_WHITE];

interface Product {
  kind: string;
  /** Width / height of the product. */
  aspect: number;
  colour: Rgb;
  accent: Rgb;
  /** Body shape, an accent part, and the white part inside (null when the product has none). */
  body: Shape;
  detail: Shape | null;
  white: Shape | null;
}

const KINDS: Omit<Product, 'colour' | 'accent'>[] = [
  {
    kind: 'box',
    aspect: 0.8,
    body: rect(0, 0, 1, 1),
    detail: rect(0, 0, 1, 0.12),
    white: rect(0.18, 0.32, 0.82, 0.72),
  },
  {
    kind: 'bottle',
    aspect: 0.42,
    body: union(rect(0.36, 0, 0.64, 0.24), roundRect(0, 0.2, 1, 1, 0.22)),
    detail: rect(0.33, 0, 0.67, 0.07),
    white: rect(0.12, 0.46, 0.88, 0.76),
  },
  {
    kind: 'plate',
    aspect: 1.7,
    body: ellipse(0.5, 0.5, 0.5, 0.5),
    detail: null,
    white: ellipse(0.5, 0.5, 0.3, 0.3),
  },
  {
    kind: 'ball',
    aspect: 1,
    body: ellipse(0.5, 0.5, 0.5, 0.5),
    detail: rect(0, 0.45, 1, 0.55),
    white: null,
  },
  {
    kind: 'lamp',
    aspect: 0.7,
    body: union(
      trapezoid(0, 0.55, 0.45, 1),
      rect(0.45, 0.55, 0.55, 0.94),
      rect(0.22, 0.92, 0.78, 1),
    ),
    detail: rect(0.22, 0.92, 0.78, 1),
    white: null,
  },
  {
    kind: 'phone',
    aspect: 0.5,
    body: roundRect(0, 0, 1, 1, 0.12),
    detail: rect(0.4, 0.93, 0.6, 0.96),
    white: rect(0.1, 0.08, 0.9, 0.88),
  },
  {
    kind: 'book',
    aspect: 0.72,
    body: rect(0, 0, 1, 1),
    detail: rect(0, 0, 0.12, 1),
    white: null,
  },
  {
    kind: 'vase',
    aspect: 0.62,
    body: union(rect(0.34, 0, 0.66, 0.36), ellipse(0.5, 0.66, 0.5, 0.34)),
    detail: rect(0.3, 0, 0.7, 0.05),
    white: null,
  },
  {
    kind: 'can',
    aspect: 0.58,
    body: union(
      rect(0, 0.08, 1, 0.92),
      ellipse(0.5, 0.08, 0.5, 0.08),
      ellipse(0.5, 0.92, 0.5, 0.08),
    ),
    detail: ellipse(0.5, 0.08, 0.5, 0.08),
    white: rect(0.1, 0.32, 0.9, 0.66),
  },
  {
    kind: 'speaker',
    aspect: 1.9,
    body: roundRect(0, 0, 1, 1, 0.18),
    detail: ellipse(0.25, 0.5, 0.12, 0.3),
    white: null,
  },
];

const COLOURS: Rgb[] = [
  [20, 34, 92],
  [178, 24, 32],
  [16, 110, 74],
  [230, 120, 10],
  [92, 40, 140],
  [24, 24, 28],
  [0, 118, 128],
  [120, 72, 36],
  [228, 186, 0],
  [176, 172, 168],
];
const ACCENTS: Rgb[] = [
  [240, 180, 20],
  [20, 20, 20],
  [200, 40, 40],
  [40, 40, 120],
  [10, 140, 200],
];

/** Output picture sizes of the mocked model: landscape, portrait and square. */
const ANSWER_SIZES: [number, number][] = [
  [640, 480],
  [480, 640],
  [600, 600],
  [704, 512],
  [512, 704],
];

export interface TestPhoto {
  /** File name, e.g. `03-plate.png`. */
  name: string;
  /** The uploaded photo. */
  photo: Buffer;
  /** The mocked model's isolation. */
  isolation: Buffer;
  /** True when the product has a white part inside. */
  hasWhitePart: boolean;
  /** Width / height of the product plus the dark part of its shadow in the isolation. */
  contentAspect: number;
}

function drawProduct(target: Picture, at: Placement, product: Product): void {
  paint(target, at, product.body, product.colour);
  if (product.detail) paint(target, at, product.detail, product.accent);
  if (product.white) paint(target, at, product.white, WHITE_PART);
}

/** Fits a product of `aspect` into `share` of the smaller side, centred on (cx, cy). */
function place(aspect: number, side: number, share: number, cx: number, cy: number): Placement {
  const longest = side * share;
  const width = aspect >= 1 ? longest : longest * aspect;
  const height = aspect >= 1 ? longest / aspect : longest;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

function photoBackground(index: number, width: number, height: number): Picture {
  const next = random(1000 + index);
  const a: Rgb = [90 + ((index * 37) % 120), 70 + ((index * 53) % 140), 60 + ((index * 29) % 150)];
  const b: Rgb = [
    200 - ((index * 41) % 120),
    160 - ((index * 23) % 100),
    120 + ((index * 17) % 100),
  ];
  const mix = (t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  switch (index % 5) {
    case 0: // vertical gradient
      return picture(width, height, (_x, y) => mix(y / height));
    case 1: // noise
      return picture(width, height, () => mix(next()));
    case 2: // flat colour with a table edge
      return picture(width, height, (_x, y) => (y > height * 0.7 ? b : a));
    case 3: // radial gradient
      return picture(width, height, (x, y) =>
        mix(Math.min(1, Math.hypot(x - width / 2, y - height / 2) / (width / 1.4))),
      );
    default: // stripes
      return picture(width, height, (x) => (Math.floor(x / 24) % 2 === 0 ? a : b));
  }
}

/**
 * The isolation: background `level` (240-252) with noise of plus or minus 3, a soft shadow (up to 60 darker,
 * fading out) just under the product, which sits off-centre in a picture of the model's own size.
 */
function isolationPicture(
  index: number,
  product: Product,
): { picture: Picture; contentAspect: number } {
  const [width, height] = ANSWER_SIZES[index % ANSWER_SIZES.length]!;
  const level = 240 + ((index * 5) % 13);
  const next = random(index + 1);
  const target = picture(width, height, () => {
    const value = level + Math.round((next() * 2 - 1) * 3);
    return [value, value, value];
  });
  const side = Math.min(width, height);
  const dx = (((index * 7) % 9) - 4) * 0.01 * width;
  const dy = (((index * 5) % 7) - 3) * 0.01 * height;
  const at = place(product.aspect, side, 0.58, width / 2 + dx, height / 2 + dy - side * 0.03);

  // Soft shadow: a flat ellipse under the product's foot, darkest at its centre.
  const sx = at.x + at.width / 2;
  const sy = at.y + at.height;
  const rx = at.width * 0.4;
  const ry = Math.max(6, side * 0.035);
  const depth = 60;
  for (let y = Math.floor(sy - ry * 3); y < Math.ceil(sy + ry * 3); y++) {
    for (let x = Math.floor(sx - rx * 1.6); x < Math.ceil(sx + rx * 1.6); x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const d = ((x - sx) / rx) ** 2 + ((y - sy) / ry) ** 2;
      const shade = depth * Math.exp(-d * 1.5);
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) target.data[i + c] = (target.data[i + c] ?? 0) - shade;
    }
  }
  drawProduct(target, at, product);
  // The shadow is content where it is darker than the threshold the tool will use: about 14 below the
  // background (its median minus 7 deviations of the noise minus 3).
  const reach = Math.sqrt(Math.log(depth / 14) / 1.5);
  const left = Math.min(at.x, sx - rx * reach);
  const right = Math.max(at.x + at.width, sx + rx * reach);
  const bottom = Math.max(at.y + at.height, sy + ry * reach);
  return { picture: target, contentAspect: (right - left) / (bottom - at.y) };
}

/** The 20 photos of the gate, each with the isolation the mocked model answers. */
export function testPhotos(count = 20): TestPhoto[] {
  return Array.from({ length: count }, (_, index) => {
    const kind = KINDS[index % KINDS.length]!;
    const product: Product = {
      ...kind,
      colour: COLOURS[(index * 3) % COLOURS.length]!,
      accent: ACCENTS[index % ACCENTS.length]!,
    };
    const landscape = index % 2 === 0;
    const [pw, ph] = landscape ? [480, 360] : [360, 480];
    const photo = photoBackground(index, pw, ph);
    drawProduct(photo, place(product.aspect, Math.min(pw, ph), 0.6, pw * 0.52, ph * 0.5), product);
    const isolation = isolationPicture(index, product);
    return {
      name: `${String(index + 1).padStart(2, '0')}-${product.kind}.png`,
      photo: encodePng(photo),
      isolation: encodePng(isolation.picture),
      hasWhitePart: product.white !== null,
      contentAspect: isolation.contentAspect,
    };
  });
}
