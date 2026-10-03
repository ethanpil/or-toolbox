/**
 * File helpers shared by every tool: reading Blobs, recognising formats from
 * their first bytes, formatting sizes and durations, building safe file
 * names, and saving a Blob to disk.
 *
 * Nothing here touches the network or storage. The readers work in browsers
 * and in jsdom (Vitest); `downloadBlob` needs a document.
 */

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
      reject(reader.error ?? new Error('Could not read the file.'));
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

const ascii = (bytes: Uint8Array, start: number, text: string): boolean => {
  if (bytes.length < start + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[start + i] !== text.charCodeAt(i)) return false;
  }
  return true;
};

const startsWith = (bytes: Uint8Array, signature: number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, i) => bytes[i] === value);

/**
 * Recognises a file from its magic bytes (at least the first 16, ideally 64).
 * Returns the MIME type, or `null` when the format is not one of: PNG, JPEG,
 * WebP, GIF, PDF, MP3 (ID3 tag or frame sync), WAV, MP4 (also M4A and
 * QuickTime/MOV), WebM, Ogg, ZIP.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF')) {
    if (ascii(bytes, 8, 'WEBP')) return 'image/webp';
    if (ascii(bytes, 8, 'WAVE')) return 'audio/wav';
    return null;
  }
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  if (ascii(bytes, 0, 'ID3')) return 'audio/mpeg';
  if (ascii(bytes, 0, 'OggS')) return 'audio/ogg';
  if (ascii(bytes, 4, 'ftyp')) {
    if (ascii(bytes, 8, 'M4A ') || ascii(bytes, 8, 'M4B ')) return 'audio/mp4';
    if (ascii(bytes, 8, 'qt  ')) return 'video/quicktime';
    return 'video/mp4';
  }
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
  return null;
}

/** `sniffMime` on the first bytes of a Blob. */
export async function sniffBlobMime(blob: Blob): Promise<string | null> {
  return sniffMime(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
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
 * `< > : " / \ | ? *`, control characters and bidirectional overrides,
 * removes trailing dots and spaces, avoids reserved names (`CON`, `NUL`,
 * `COM1`, …) and caps the length while keeping the extension. Never returns
 * an empty string.
 */
export function sanitizeFilename(name: string, fallback = 'file'): string {
  let clean = name
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here.
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
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
  // Windows reserves these names whatever follows the first dot (`NUL.tar.gz` too).
  if (RESERVED_WINDOWS_NAMES.test(base.split('.')[0] ?? '')) base = `_${base}`;
  base = base.slice(0, MAX_NAME_LENGTH - extension.length).replace(/[. ]+$/, '');
  clean = base + extension;
  return clean || fallback;
}

/**
 * Fills `{placeholders}` in a file name pattern and sanitises the result.
 * `{n:3}` zero-pads a number to three digits. Placeholders without a value
 * stay as written, so a typo is visible in the name.
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
      const value = vars[key];
      if (value === undefined) return placeholder;
      return width ? String(value).padStart(Number(width), '0') : String(value);
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
  if (used.has(key(candidate))) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let n = 2;
    do {
      candidate = `${base} (${n++})${extension}`;
    } while (used.has(key(candidate)));
  }
  used.add(key(candidate));
  return candidate;
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
