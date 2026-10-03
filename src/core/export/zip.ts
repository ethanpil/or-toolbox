/**
 * ZIP archives of several results (the isolated-image ZIP, batch exports).
 *
 * Uses fflate's synchronous `zipSync`: its async API starts workers from
 * `blob:` URLs, which our CSP (`worker-src 'self'`) forbids. The work blocks
 * the page for as long as compressing takes, so files that are already
 * compressed (JPEG, PNG, MP3, MP4, ZIP, ...) are stored, not deflated, which
 * makes a ZIP of photos nearly as fast as copying them.
 */
import { InvalidInputError } from '../errors';
import { numberedFilename, sanitizeFilename } from '../files';

export interface ZipEntry {
  /**
   * File name, optionally with folders (`photos/shoe.jpg`; `\` also separates).
   * Unsafe characters are replaced. A name that climbs out of the archive
   * (`../x`) or is absolute (`/x`, `C:\x`) is rejected.
   */
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

/** The sanitised parts of a path, without empty and `.` parts. Throws for `..` and absolute paths. */
function pathParts(name: string): string[] {
  const normalised = name.replace(/\\/g, '/');
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised)) {
    throw new InvalidInputError(`The file name "${name}" is an absolute path; use a relative one.`);
  }
  const parts = normalised
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new InvalidInputError(`The file name "${name}" leaves the archive folder.`);
  }
  return parts.map((part) => sanitizeFilename(part));
}

/**
 * Chooses the final path of every entry. Windows and macOS compare names
 * ignoring case, so two paths that differ only in case are the same path; a
 * file and a folder cannot share a name either. A clash renames the later
 * one (`a.txt` → `a (2).txt`, a folder `a` → `a (2)`); folders that differ
 * only in case are merged under the spelling that came first.
 */
class PathAllocator {
  /** Lower-case full paths of files. */
  private readonly files = new Set<string>();
  /** Lower-case folder path → the folder path chosen for it. */
  private readonly folders = new Map<string, string>();

  allocate(name: string): string {
    const parts = pathParts(name);
    const file = parts.pop() ?? 'file';

    let folder = '';
    for (const part of parts) {
      const wanted = folder ? `${folder}/${part}` : part;
      let chosen = this.folders.get(wanted.toLowerCase());
      if (chosen === undefined) {
        chosen = wanted;
        for (let n = 2; this.files.has(chosen.toLowerCase()); n++) {
          chosen = folder ? `${folder}/${numberedFilename(part, n)}` : numberedFilename(part, n);
        }
        this.folders.set(wanted.toLowerCase(), chosen);
        this.folders.set(chosen.toLowerCase(), chosen);
      }
      folder = chosen;
    }

    const path = (leaf: string): string => (folder ? `${folder}/${leaf}` : leaf);
    let leaf = file;
    for (let n = 2; this.taken(path(leaf).toLowerCase()); n++) leaf = numberedFilename(file, n);
    this.files.add(path(leaf).toLowerCase());
    return path(leaf);
  }

  private taken(lowerPath: string): boolean {
    return this.files.has(lowerPath) || this.folders.has(lowerPath);
  }
}

/**
 * Packs files into a ZIP Blob. Names are made safe and unique (see
 * `ZipEntry.name`); Blobs are read into memory first.
 */
export async function zipFiles(
  files: readonly ZipEntry[],
  options: ZipOptions = {},
): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate');
  const paths = new PathAllocator();
  const entries: Record<string, [Uint8Array, { level: 0 | 6; mtime: Date }]> = {};
  const mtime = options.mtime ?? new Date();

  for (const entry of files) {
    const path = paths.allocate(entry.name);
    const { data } = entry;
    const bytes =
      typeof data === 'string'
        ? strToU8(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
    entries[path] = [bytes, { level: STORED.test(path) ? 0 : 6, mtime }];
  }

  return new Blob([zipSync(entries)], { type: 'application/zip' });
}
