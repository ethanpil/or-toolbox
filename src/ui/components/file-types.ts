/**
 * Matching files against a tool's `accepts` list (`image/png`, `image/*`, …). Browsers leave `File.type` empty
 * for some files (Markdown, subtitles, some audio), so the extension is the fallback.
 */

const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/** The file's MIME type, from `type` or else its extension; '' when unknown. */
export function fileMime(file: { type: string; name?: string }): string {
  if (file.type) return file.type.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(file.name ?? '')?.[1]?.toLowerCase();
  return (extension && BY_EXTENSION[extension]) || '';
}

/** True when `mime` matches an entry of `accept` (`type/subtype`, `type/*` or `*\/*`). */
export function mimeMatches(mime: string, accept: readonly string[]): boolean {
  if (!mime) return false;
  const [type] = mime.split('/');
  return accept.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    if (wanted === '*/*' || wanted === mime) return true;
    return wanted.endsWith('/*') && wanted.slice(0, -2) === type;
  });
}

export function acceptsFile(
  file: { type: string; name?: string },
  accept: readonly string[],
): boolean {
  return mimeMatches(fileMime(file), accept);
}

/** Splits files into the ones `accept` takes and the rest. */
export function partitionFiles<T extends { type: string; name?: string }>(
  files: readonly T[],
  accept: readonly string[],
): { accepted: T[]; rejected: T[] } {
  const accepted: T[] = [];
  const rejected: T[] = [];
  for (const file of files) (acceptsFile(file, accept) ? accepted : rejected).push(file);
  return { accepted, rejected };
}

const LABELS: Readonly<Record<string, string>> = {
  'image/*': 'images',
  'audio/*': 'audio',
  'video/*': 'video',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
  'application/pdf': 'PDF',
  'text/plain': 'text',
  'text/markdown': 'Markdown',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'video/webm': 'WebM',
};

/** `["image/png","image/jpeg","application/pdf"]` → `PNG, JPEG or PDF`. */
export function describeAccept(accept: readonly string[]): string {
  const names = [
    ...new Set(accept.map((entry) => LABELS[entry] ?? entry.split('/')[1]?.toUpperCase() ?? entry)),
  ];
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}
