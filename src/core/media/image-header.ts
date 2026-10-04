/**
 * What an image file's header says, read without decoding the picture: the format, the stored pixel size and
 * the EXIF orientation, for PNG, JPEG, WebP and GIF. Only the bytes that hold them are read (a 64 KiB window,
 * moved further on when a header points past it), so it costs next to nothing beside a decode. Pure: works on
 * the page, in a worker and in Node tests.
 */
import { matchesAscii } from '../files';

export type HeaderType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageHeader {
  type: HeaderType;
  /** The size as stored, before any EXIF rotation. */
  width: number;
  height: number;
  /**
   * EXIF orientation 1-8 (PNG `eXIf`, JPEG APP1, WebP `EXIF`): 1 = upright as stored, also when the file has
   * none; 5-8 turn the picture a quarter, so it shows `height` wide.
   */
  orientation: number;
}

/** Bytes `offset` to `offset + length` of the file; shorter at its end. */
type Read = (offset: number, length: number) => Promise<Uint8Array>;

const WINDOW = 64 * 1024;
/** Guards against files whose structure loops or never ends. */
const MAX_PARTS = 256;
/** The largest EXIF block worth reading: orientation sits in its first directory. */
const MAX_EXIF_BYTES = 64 * 1024;

function blobReader(blob: Blob): Read {
  let start = 0;
  let bytes = new Uint8Array(0);
  return async (offset, length) => {
    const end = start + bytes.length;
    const cached = offset >= start && (offset + length <= end || end >= blob.size);
    if (!cached) {
      start = offset;
      bytes = new Uint8Array(
        await blob.slice(offset, offset + Math.max(length, WINDOW)).arrayBuffer(),
      );
    }
    return bytes.subarray(offset - start, offset - start + length);
  };
}

const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number): number => u16be(b, i) * 0x10000 + u16be(b, i + 2);
const u16le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number): number => u16le(b, i) + (b[i + 2] ?? 0) * 0x10000;
const u32le = (b: Uint8Array, i: number): number => u16le(b, i) + u16le(b, i + 2) * 0x10000;

/** The orientation tag (0x0112) of a TIFF block's first directory, or 1. */
export function exifOrientation(tiff: Uint8Array): number {
  const little = matchesAscii(tiff, 0, 'II');
  if (!little && !matchesAscii(tiff, 0, 'MM')) return 1;
  const u16 = (i: number): number => (little ? u16le(tiff, i) : u16be(tiff, i));
  const u32 = (i: number): number => (little ? u32le(tiff, i) : u32be(tiff, i));
  if (tiff.length < 8 || u16(2) !== 42) return 1;
  const directory = u32(4);
  if (directory + 2 > tiff.length) return 1;
  const count = u16(directory);
  for (let k = 0; k < count; k++) {
    const entry = directory + 2 + k * 12;
    if (entry + 12 > tiff.length) break;
    if (u16(entry) !== 0x0112) continue;
    const type = u16(entry + 2); // 3 = SHORT (the standard), 4 = LONG (seen in the wild)
    const value = type === 3 ? u16(entry + 8) : type === 4 ? u32(entry + 8) : 0;
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

/** EXIF payloads in PNG and WebP are a bare TIFF block, but some writers keep JPEG's `Exif\0\0` prefix. */
const tiffOf = (bytes: Uint8Array): Uint8Array =>
  matchesAscii(bytes, 0, 'Exif\0\0') ? bytes.subarray(6) : bytes;

const header = (
  type: HeaderType,
  width: number,
  height: number,
  orientation: number,
): ImageHeader | null => (width > 0 && height > 0 ? { type, width, height, orientation } : null);

async function png(read: Read): Promise<ImageHeader | null> {
  const head = await read(0, 24);
  if (head.length < 24 || !matchesAscii(head, 12, 'IHDR')) return null;
  let orientation = 1;
  // `eXIf` must come before the image data.
  for (let offset = 8, part = 0; part < MAX_PARTS; part++) {
    const chunk = await read(offset, 8);
    if (chunk.length < 8 || matchesAscii(chunk, 4, 'IDAT') || matchesAscii(chunk, 4, 'IEND')) break;
    const length = u32be(chunk, 0);
    if (matchesAscii(chunk, 4, 'eXIf')) {
      orientation = exifOrientation(
        tiffOf(await read(offset + 8, Math.min(length, MAX_EXIF_BYTES))),
      );
      break;
    }
    offset += 12 + length;
  }
  return header('image/png', u32be(head, 16), u32be(head, 20), orientation);
}

/** Start-of-frame markers (C0-CF except DHT C4, JPG C8 and DAC CC): they carry the size. */
const isFrameHeader = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

async function jpeg(read: Read): Promise<ImageHeader | null> {
  let orientation = 1;
  let exifSeen = false;
  for (let offset = 2, part = 0; part < MAX_PARTS; part++) {
    const head = await read(offset, 4);
    if (head.length < 2 || head[0] !== 0xff) return null;
    const marker = head[1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markers without a length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda || head.length < 4) return null; // image data before any frame
    const length = u16be(head, 2);
    if (length < 2) return null;
    if (isFrameHeader(marker)) {
      const frame = await read(offset + 4, 5); // precision, height, width
      if (frame.length < 5) return null;
      return header('image/jpeg', u16be(frame, 3), u16be(frame, 1), orientation);
    }
    if (marker === 0xe1 && !exifSeen) {
      const app = await read(offset + 4, Math.min(length - 2, MAX_EXIF_BYTES));
      if (matchesAscii(app, 0, 'Exif\0\0')) {
        exifSeen = true;
        orientation = exifOrientation(app.subarray(6));
      }
    }
    offset += 2 + length;
  }
  return null;
}

async function webp(read: Read): Promise<ImageHeader | null> {
  const head = await read(0, 30);
  if (matchesAscii(head, 12, 'VP8 ')) {
    // Frame tag (3 bytes), start code 9D 01 2A, then 14-bit width and height.
    if (head.length < 30 || head[23] !== 0x9d || head[24] !== 0x01 || head[25] !== 0x2a)
      return null;
    return header('image/webp', u16le(head, 26) & 0x3fff, u16le(head, 28) & 0x3fff, 1);
  }
  if (matchesAscii(head, 12, 'VP8L')) {
    if (head.length < 25 || head[20] !== 0x2f) return null;
    const bits = u32le(head, 21);
    return header('image/webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, 1);
  }
  if (!matchesAscii(head, 12, 'VP8X') || head.length < 30) return null;
  let orientation = 1;
  if (((head[20] ?? 0) & 0x08) !== 0) {
    // The EXIF chunk follows the image data: walk the chunk headers to it.
    for (let offset = 12, part = 0; part < MAX_PARTS; part++) {
      const chunk = await read(offset, 8);
      if (chunk.length < 8) break;
      const size = u32le(chunk, 4);
      if (matchesAscii(chunk, 0, 'EXIF')) {
        orientation = exifOrientation(
          tiffOf(await read(offset + 8, Math.min(size, MAX_EXIF_BYTES))),
        );
        break;
      }
      offset += 8 + size + (size % 2);
    }
  }
  return header('image/webp', u24le(head, 24) + 1, u24le(head, 27) + 1, orientation);
}

async function gif(read: Read): Promise<ImageHeader | null> {
  const head = await read(0, 10);
  return head.length < 10 ? null : header('image/gif', u16le(head, 6), u16le(head, 8), 1);
}

/**
 * The format, stored size and EXIF orientation of a PNG, JPEG, WebP or GIF file, from its header alone.
 * `null` for any other format, a header it cannot follow, or a file that cannot be read: decode it instead.
 * It does not check that the rest of the file decodes.
 */
export async function readImageHeader(blob: Blob): Promise<ImageHeader | null> {
  const read = blobReader(blob);
  try {
    const head = await read(0, 16);
    if (head[0] === 0x89 && matchesAscii(head, 1, 'PNG\r\n\x1a\n')) return await png(read);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return await jpeg(read);
    if (matchesAscii(head, 0, 'RIFF') && matchesAscii(head, 8, 'WEBP')) return await webp(read);
    if (matchesAscii(head, 0, 'GIF87a') || matchesAscii(head, 0, 'GIF89a')) return await gif(read);
    return null;
  } catch {
    return null; // an unreadable file: the decoder that runs next reports it
  }
}
