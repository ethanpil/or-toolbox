/**
 * Test helper (never imported by product code): the headers of PNG, JPEG, WebP and GIF files built byte by
 * byte, with an EXIF orientation where the format has one. The pixel data is a stub: these files are for
 * header readers and for fakes that stand in for the browser's decoder, not for real decoding.
 */

type Part = number | readonly number[] | Uint8Array;

/** Concatenates bytes, byte arrays and strings' ASCII codes. */
function bytes(...parts: (Part | string)[]): Uint8Array {
  const arrays = parts.map((part) =>
    typeof part === 'string'
      ? Uint8Array.from(part, (c) => c.charCodeAt(0))
      : typeof part === 'number'
        ? Uint8Array.of(part)
        : Uint8Array.from(part),
  );
  const out = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
  let at = 0;
  for (const array of arrays) {
    out.set(array, at);
    at += array.length;
  }
  return out;
}

const be16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number): number[] => [...be16(Math.floor(n / 0x10000)), ...be16(n & 0xffff)];
const le16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number): number[] => [...le16(n & 0xffff), (n >> 16) & 0xff];
const le32 = (n: number): number[] => [...le16(n & 0xffff), ...le16(Math.floor(n / 0x10000))];

/** A TIFF block whose first directory holds a resolution tag and then the orientation tag. */
export function tiffBlock(orientation: number, littleEndian = false): Uint8Array {
  const u16 = littleEndian ? le16 : be16;
  const u32 = littleEndian ? le32 : be32;
  const entry = (tag: number, type: number, value: number[]): Uint8Array =>
    bytes(u16(tag), u16(type), u32(1), value);
  return bytes(
    littleEndian ? 'II' : 'MM',
    u16(42),
    u32(8),
    u16(2),
    entry(0x011a, 4, u32(72)), // a LONG to skip over first
    entry(0x0112, 3, [...u16(orientation), 0, 0]),
    u32(0),
  );
}

export interface FileOptions {
  /** EXIF orientation to embed (1-8); none when absent. */
  orientation?: number;
  littleEndian?: boolean;
  /** Bytes of other metadata before the size (PNG, JPEG) or of image data before the EXIF (WebP). */
  padding?: number;
}

/** CRCs are left 0: header readers do not check them. */
const pngChunk = (type: string, data: Part): Uint8Array =>
  bytes(be32(typeof data === 'number' ? 1 : data.length), type, data, [0, 0, 0, 0]);

export function pngFile(width: number, height: number, options: FileOptions = {}): Uint8Array {
  return bytes(
    0x89,
    'PNG\r\n\x1a\n',
    pngChunk('IHDR', [...be32(width), ...be32(height), 8, 6, 0, 0, 0]),
    options.padding ? pngChunk('tEXt', new Uint8Array(options.padding)) : [],
    options.orientation === undefined
      ? []
      : pngChunk('eXIf', tiffBlock(options.orientation, options.littleEndian)),
    pngChunk('IDAT', new Uint8Array(4)),
    pngChunk('IEND', []),
  );
}

const jpegSegment = (marker: number, data: Part): Uint8Array =>
  bytes(0xff, marker, be16((typeof data === 'number' ? 1 : data.length) + 2), data);

export function jpegFile(
  width: number,
  height: number,
  options: FileOptions & { progressive?: boolean } = {},
): Uint8Array {
  const padding: Uint8Array[] = [];
  // ICC profiles and the like, in segments of at most 65,533 bytes.
  for (let left = options.padding ?? 0; left > 0; left -= 65_000) {
    padding.push(jpegSegment(0xe2, new Uint8Array(Math.min(left, 65_000))));
  }
  return bytes(
    [0xff, 0xd8],
    jpegSegment(0xe0, bytes('JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    options.orientation === undefined
      ? []
      : jpegSegment(
          0xe1,
          bytes('Exif', [0, 0], tiffBlock(options.orientation, options.littleEndian)),
        ),
    ...padding,
    jpegSegment(0xdb, new Uint8Array(65)), // a quantisation table
    jpegSegment(options.progressive ? 0xc2 : 0xc0, [
      8,
      ...be16(height),
      ...be16(width),
      3,
      1,
      0x22,
      0,
      2,
      0x11,
      1,
      3,
      0x11,
      1,
    ]),
    jpegSegment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    [0, 0, 0, 0, 0xff, 0xd9],
  );
}

const riffChunk = (type: string, data: Uint8Array): Uint8Array =>
  bytes(type, le32(data.length), data, data.length % 2 === 1 ? [0] : []);

const riff = (...chunks: Uint8Array[]): Uint8Array => {
  const body = bytes(...chunks);
  return bytes('RIFF', le32(body.length + 4), 'WEBP', body);
};

const vp8 = (width: number, height: number, padding = 0): Uint8Array =>
  riffChunk(
    'VP8 ',
    bytes([0, 0, 0, 0x9d, 0x01, 0x2a], le16(width), le16(height), new Uint8Array(padding + 4)),
  );

/** A lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`, which can carry EXIF) WebP. */
export function webpFile(
  kind: 'VP8 ' | 'VP8L' | 'VP8X',
  width: number,
  height: number,
  options: FileOptions & { exifPrefix?: boolean } = {},
): Uint8Array {
  if (kind === 'VP8 ') return riff(vp8(width, height));
  if (kind === 'VP8L') {
    const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
    return riff(riffChunk('VP8L', bytes(0x2f, le32(bits), [0, 0, 0])));
  }
  const exif = options.orientation !== undefined;
  const tiff = tiffBlock(options.orientation ?? 1, options.littleEndian);
  return riff(
    riffChunk('VP8X', bytes(exif ? 0x08 : 0, [0, 0, 0], le24(width - 1), le24(height - 1))),
    // Image data first, then the EXIF, as the format orders them.
    vp8(width, height, options.padding),
    ...(exif ? [riffChunk('EXIF', options.exifPrefix ? bytes('Exif', [0, 0], tiff) : tiff)] : []),
  );
}

export function gifFile(width: number, height: number): Uint8Array {
  return bytes(
    'GIF89a',
    le16(width),
    le16(height),
    [0x80, 0, 0],
    [0, 0, 0, 255, 255, 255], // a two-colour palette
    [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], // a 1 x 1 frame
    [2, 2, 0x44, 0x01, 0], // its pixel
    0x3b,
  );
}
