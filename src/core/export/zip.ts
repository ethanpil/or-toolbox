/**
 * ZIP archives of several results (the isolated-image ZIP, batch exports).
 *
 * Uses fflate's synchronous `zipSync`: its async API starts workers from
 * `blob:` URLs, which our CSP (`worker-src 'self'`) forbids. The work blocks
 * the page for as long as compressing takes, so files that are already
 * compressed (JPEG, PNG, MP3, MP4, ZIP, ...) are stored, not deflated, which
 * makes a ZIP of photos nearly as fast as copying them.
 */
import { sanitizeFilename, uniqueFilename } from '../files';

export interface ZipEntry {
  /** File name, optionally with folders (`photos/shoe.jpg`). Unsafe characters are replaced. */
  name: string;
  data: Blob | Uint8Array | ArrayBuffer | string;
}

export interface ZipOptions {
  /** Modification time for every entry. Default: now. */
  mtime?: Date;
}

/** Formats that do not shrink under deflate. */
const STORED =
  /\.(jpe?g|png|gif|webp|avif|mp3|m4a|aac|ogg|opus|flac|mp4|mov|webm|mkv|zip|gz|7z|pdf)$/i;

/** Splits a path, sanitises each part, and drops empty, `.` and `..` parts. */
function cleanPath(name: string): { directory: string; file: string } {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map((part) => sanitizeFilename(part));
  const file = parts.pop() ?? 'file';
  return { directory: parts.length ? `${parts.join('/')}/` : '', file };
}

/**
 * Packs files into a ZIP Blob. Names are made safe and unique (the second
 * `a.txt` becomes `a (2).txt`); Blobs are read into memory first.
 */
export async function zipFiles(
  files: readonly ZipEntry[],
  options: ZipOptions = {},
): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate');
  const used = new Map<string, Set<string>>();
  const entries: Record<string, [Uint8Array, { level: 0 | 6; mtime: Date }]> = {};
  const mtime = options.mtime ?? new Date();

  for (const entry of files) {
    const { directory, file } = cleanPath(entry.name);
    let names = used.get(directory);
    if (!names) used.set(directory, (names = new Set()));
    const unique = uniqueFilename(file, names);
    const { data } = entry;
    const bytes =
      typeof data === 'string'
        ? strToU8(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    entries[directory + unique] = [bytes, { level: STORED.test(unique) ? 0 : 6, mtime }];
  }

  return new Blob([zipSync(entries)], { type: 'application/zip' });
}
