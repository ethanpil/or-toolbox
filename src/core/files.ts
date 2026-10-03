/**
 * File helpers shared by every tool: reading Blobs, recognising formats from
 * their first bytes, formatting sizes and durations, building safe file
 * names, and saving a Blob to disk.
 *
 * Nothing here touches the network or storage. The readers work in browsers
 * and in jsdom (Vitest); `downloadBlob` needs a document.
 */
import { InvalidInputError } from './errors';

// --- reading ----------------------------------------------------------------

/** Reads a Blob as a `data:` URL. A Blob without a type gets one sniffed from its bytes. */
export async function readAsDataUrl(blob: Blob): Promise<string> {
  let source = blob;
  if (!source.type) {
    const sniffed = await sniffBlobMime(source);
    if (sniffed) source = source.slice(0, source.size, sniffed);
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(new InvalidInputError('Could not read the file.', { cause: reader.error }));
    };
    reader.readAsDataURL(source);
  });
}

/** Reads a Blob as base64 without the `data:…;base64,` prefix, which is what OpenRouter's audio and file parts want. */
export async function readAsBase64(blob: Blob): Promise<string> {
  const url = await readAsDataUrl(blob);
  return url.slice(url.indexOf(',') + 1);
}

/** Reads a Blob as UTF-8 text. */
export function readAsText(blob: Blob): Promise<string> {
  return blob.text();
}

/** Reads a Blob into memory. */
export function readAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}

// --- format sniffing --------------------------------------------------------

/** True if `bytes` holds the ASCII `text` at `start`. */
export function matchesAscii(bytes: Uint8Array, start: number, text: string): boolean {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, i) => bytes[i] === value);

/** How many bytes `sniffMime` looks at: enough for an SVG's prolog, comments and doctype. */
const SNIFF_BYTES = 1024;

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['mif1', 'msf1']);
const MP4_AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);

/** The major brand and the compatible brands of an `ftyp` box at the start of `bytes`. */
function ftypBrands(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = Math.min(view.getUint32(0), bytes.length);
  const brand = (at: number): string =>
    String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
  const brands = [brand(8)];
  // Bytes 12-15 are the minor version; compatible brands follow.
  for (let at = 16; at + 4 <= size; at += 4) brands.push(brand(at));
  return brands;
}

function classifyFtyp(bytes: Uint8Array): string {
  const [major = '', ...compatible] = ftypBrands(bytes);
  if (HEIC_BRANDS.has(major)) return 'image/heic';
  if (AVIF_BRANDS.has(major)) return 'image/avif';
  if (HEIF_BRANDS.has(major)) {
    // `mif1` is the generic HEIF brand: the compatible brands say which codec is inside.
    if (compatible.some((brand) => AVIF_BRANDS.has(brand))) return 'image/avif';
    if (compatible.some((brand) => HEIC_BRANDS.has(brand))) return 'image/heic';
    return 'image/heif';
  }
  if (MP4_AUDIO_BRANDS.has(major)) return 'audio/mp4';
  if (major === 'qt  ') return 'video/quicktime';
  // `isom`, `mp42` and friends: video unless the tracks say otherwise (see `sniffBlobMime`).
  return 'video/mp4';
}

const SVG_START =
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;

/**
 * True if the text starts like an SVG document: optional XML prolog, comments
 * and doctype, then `<svg`. (TextDecoder drops a leading byte order mark.)
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
  // Cheap rejection before decoding: the first byte of the text is `<`, a space, or a byte order mark.
  const first = bytes[0];
  if (
    first !== 0x3c &&
    first !== 0x20 &&
    first !== 0x0a &&
    first !== 0x0d &&
    first !== 0x09 &&
    first !== 0xef
  ) {
    return false;
  }
  return SVG_START.test(new TextDecoder().decode(bytes.subarray(0, SNIFF_BYTES)));
}

/**
 * Recognises a file from its magic bytes (the first 64 are enough, except for
 * SVG, which can need up to 1,024). Returns the MIME type, or `null` when the
 * format is not one of: PNG, JPEG, WebP, GIF, SVG, HEIC/HEIF/AVIF, PDF, MP3
 * (ID3 tag or frame sync), WAV, MP4/M4A/QuickTime, WebM, Ogg, ZIP.
 *
 * The first bytes cannot say whether an MP4 or WebM holds video: those come
 * back as `video/mp4` and `video/webm` (M4A and friends as `audio/mp4`). Use
 * `sniffBlobMime`, which looks at the tracks, when audio-only files matter.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (matchesAscii(bytes, 0, 'GIF87a') || matchesAscii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (matchesAscii(bytes, 0, 'RIFF')) {
    if (matchesAscii(bytes, 8, 'WEBP')) return 'image/webp';
    if (matchesAscii(bytes, 8, 'WAVE')) return 'audio/wav';
    return null;
  }
  if (matchesAscii(bytes, 0, '%PDF-')) return 'application/pdf';
  if (matchesAscii(bytes, 0, 'ID3')) return 'audio/mpeg';
  if (matchesAscii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (matchesAscii(bytes, 4, 'ftyp')) return classifyFtyp(bytes);
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return 'application/zip';
  }
  // MPEG audio frame sync: 11 set bits, a valid version (not 01) and layer (not 00).
  if (
    bytes.length >= 2 &&
    bytes[0] === 0xff &&
    ((bytes[1] ?? 0) & 0xe0) === 0xe0 &&
    ((bytes[1] ?? 0) & 0x18) !== 0x08 &&
    ((bytes[1] ?? 0) & 0x06) !== 0x00
  ) {
    return 'audio/mpeg';
  }
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  return null;
}

/** The largest `moov` box `sniffBlobMime` reads to look at an MP4's tracks. */
const MAX_MOOV_BYTES = 8 * 1024 * 1024;

const fourcc = (view: DataView, at: number): string =>
  String.fromCharCode(
    view.getUint8(at),
    view.getUint8(at + 1),
    view.getUint8(at + 2),
    view.getUint8(at + 3),
  );

/**
 * Walks the top-level boxes of an MP4 to its `moov` box and reads the track
 * handler types (`vide`, `soun`). Returns `null` when it cannot tell.
 */
async function mp4Tracks(blob: Blob): Promise<{ video: boolean; sound: boolean } | null> {
  let offset = 0;
  for (let boxes = 0; boxes < 64 && offset + 8 <= blob.size; boxes++) {
    const head = await blob.slice(offset, offset + 16).arrayBuffer();
    if (head.byteLength < 8) return null;
    const view = new DataView(head);
    let size = view.getUint32(0);
    let headerBytes = 8;
    if (size === 1 && head.byteLength >= 16) {
      size = Number(view.getBigUint64(8));
      headerBytes = 16;
    } else if (size === 0) {
      size = blob.size - offset; // runs to the end of the file
    }
    if (size < headerBytes) return null;
    if (fourcc(view, 4) === 'moov') {
      if (size > MAX_MOOV_BYTES) return null;
      const body = new Uint8Array(
        await blob.slice(offset + headerBytes, offset + size).arrayBuffer(),
      );
      let video = false;
      let sound = false;
      // hdlr box: size, 'hdlr', version/flags, pre-defined, then the handler type, 12 bytes after the tag.
      for (
        let i = body.indexOf(0x68);
        i >= 0 && i + 16 <= body.length;
        i = body.indexOf(0x68, i + 1)
      ) {
        if (!matchesAscii(body, i, 'hdlr')) continue;
        if (matchesAscii(body, i + 12, 'vide')) video = true;
        if (matchesAscii(body, i + 12, 'soun')) sound = true;
      }
      return video || sound ? { video, sound } : null;
    }
    offset += size;
  }
  return null;
}

/** EBML element id of `Tracks`. */
const WEBM_TRACKS = [0x16, 0x54, 0xae, 0x6b];
/** How much of a WebM's start is searched for its `Tracks` element. */
const WEBM_SCAN_BYTES = 64 * 1024;

/** True/false for video present in a WebM's Tracks element, `null` if it cannot be found. */
async function webmHasVideo(blob: Blob): Promise<boolean | null> {
  const bytes = new Uint8Array(await blob.slice(0, WEBM_SCAN_BYTES).arrayBuffer());
  let at = -1;
  for (let i = 0; i + WEBM_TRACKS.length < bytes.length; i++) {
    if (WEBM_TRACKS.every((value, k) => bytes[i + k] === value)) {
      at = i + WEBM_TRACKS.length;
      break;
    }
  }
  if (at < 0) return null;
  // The element size is a variable-length integer: the leading zeros of the first byte give its length.
  const lead = bytes[at] ?? 0;
  const length = lead === 0 ? 8 : Math.clz32(lead) - 23;
  let size = lead & (0xff >> length);
  for (let k = 1; k < length; k++) size = size * 256 + (bytes[at + k] ?? 0);
  const start = at + length;
  // An unknown size is all ones; scan to the end of what was read.
  const end = Math.min(bytes.length, size >= 2 ** 40 ? bytes.length : start + size);
  const types: number[] = [];
  // TrackType element: id 0x83, one-byte size 0x81, value 1 (video) or 2 (audio).
  for (let i = start; i + 2 < end; i++) {
    if (bytes[i] === 0x83 && bytes[i + 1] === 0x81) types.push(bytes[i + 2] ?? 0);
  }
  if (types.includes(1)) return true;
  return types.includes(2) ? false : null;
}

/**
 * `sniffMime` on the first bytes of a Blob, plus a look inside MP4 and WebM
 * files: one with sound tracks only is `audio/mp4` / `audio/webm`.
 */
export async function sniffBlobMime(blob: Blob): Promise<string | null> {
  const type = sniffMime(new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer()));
  if (type === 'video/mp4') {
    const tracks = await mp4Tracks(blob);
    return tracks && tracks.sound && !tracks.video ? 'audio/mp4' : type;
  }
  if (type === 'video/webm') {
    return (await webmHasVideo(blob)) === false ? 'audio/webm' : type;
  }
  return type;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

/** The usual file extension (no dot) for a MIME type from `sniffMime`, or `undefined`. */
export function extensionForMime(type: string | null | undefined): string | undefined {
  return type ? EXTENSIONS[type.toLowerCase()] : undefined;
}

// --- formatting -------------------------------------------------------------

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** `1536` → `'1.5 KB'`. Binary units (1 KB = 1024 B), one decimal at most. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
  return `${text} ${SIZE_UNITS[unit]}`;
}

/**
 * Seconds as `m:ss`, or `h:mm:ss` from one hour up (`83` → `'1:23'`,
 * `3725` → `'1:02:05'`). Fractions are dropped, like a media player's
 * display; anything negative or not finite shows as `'0:00'`.
 */
export function formatDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// --- file names -------------------------------------------------------------

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME_LENGTH = 180;

/**
 * Makes a string safe as a file name on Windows, macOS and Linux: replaces
 * `< > : " / \ | ? *` and control characters, removes bidirectional overrides,
 * removes trailing dots and spaces, avoids reserved names (`CON`, `NUL`,
 * `COM1`, …, also `CON .txt` and `nul.tar.gz`, which Windows treats the same)
 * and caps the length while keeping the extension. Never returns an empty string.
 */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  const clean = name
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, '_')
    .replace(/\p{Bidi_Control}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!clean || /^\.+$/.test(clean)) return fallback;

  const dot = clean.lastIndexOf('.');
  let base = dot > 0 ? clean.slice(0, dot) : clean;
  let extension = dot > 0 ? clean.slice(dot) : '';
  if (extension.length > 16) {
    base = clean.slice(0, MAX_NAME_LENGTH);
    extension = '';
  }
  // Spaces before the dot are dropped by Windows, so "CON .txt" is the device CON.
  base = base.trim();
  // Reserved whatever follows the first dot (`NUL.tar.gz` too).
  if (RESERVED_WINDOWS_NAMES.test((base.split('.')[0] ?? '').trim())) base = `_${base}`;
  base = base.slice(0, MAX_NAME_LENGTH - extension.length).replace(/[. ]+$/, '');
  return base + extension || fallback;
}

/** The widest zero padding `{n:3}` may ask for. */
const MAX_PADDING = 20;

/**
 * Fills `{placeholders}` in a file name pattern and sanitises the result.
 * `{n:3}` zero-pads a value to three digits (at most 20). Placeholders
 * without a value of their own in `vars` stay as written, so a typo is
 * visible in the name.
 *
 * ```ts
 * applyFilenamePattern('{name}-{n}.{ext}', { name: 'shoe', n: 2, ext: 'jpg' }); // 'shoe-2.jpg'
 * applyFilenamePattern('{name}-{n:3}.{ext}', { name: 'shoe', n: 2, ext: 'jpg' }); // 'shoe-002.jpg'
 * ```
 */
export function applyFilenamePattern(
  pattern: string,
  vars: Record<string, string | number | undefined>,
): string {
  const filled = pattern.replace(
    /\{(\w+)(?::(\d+))?\}/g,
    (placeholder: string, key: string, width: string | undefined) => {
      // Own properties only: `{constructor}` must not pick up Object's.
      const value = Object.hasOwn(vars, key) ? vars[key] : undefined;
      if (value === undefined) return placeholder;
      return width
        ? String(value).padStart(Math.min(Number(width), MAX_PADDING), '0')
        : String(value);
    },
  );
  return sanitizeFilename(filled);
}

/**
 * Returns `name`, or `name (2)`, `name (3)`, … (before the extension) until
 * it is not in `used`, and adds the result to `used`. Comparison ignores case,
 * because Windows and macOS file systems do.
 */
export function uniqueFilename(name: string, used: Set<string>): string {
  const key = (value: string): string => value.toLowerCase();
  let candidate = name;
  for (let n = 2; used.has(key(candidate)); n++) candidate = numberedFilename(name, n);
  used.add(key(candidate));
  return candidate;
}

/** `numberedFilename('a.png', 2)` → `'a (2).png'`: the number goes before the extension. */
export function numberedFilename(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

// --- saving -----------------------------------------------------------------

/** How long the object URL of a download stays valid. Chrome may take a moment to start a large save. */
const REVOKE_DELAY_MS = 60_000;

/** Offers a Blob to the user as a download. The object URL is revoked after a minute. */
export function downloadBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = sanitizeFilename(filename);
  anchor.rel = 'noopener';
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, REVOKE_DELAY_MS);
}
