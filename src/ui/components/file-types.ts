/**
 * Matching files against a tool's `accepts` list (`image/png`, `image/*`, …). Browsers leave `File.type` empty
 * for some files (Markdown, subtitles, some audio) and get others wrong, so the extension counts too. Which
 * extensions are text is Chat's `classifyFile` (one classifier for the drop, the paste, Send to… and Chat).
 */
import { classifyFile } from '../../core/attachments/attachments';

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
  // Source and data files browsers often leave untyped; specific types, so only `text/*` tools take them.
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/x-toml',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  h: 'text/x-c',
  cpp: 'text/x-c++',
  cs: 'text/x-csharp',
  php: 'text/x-php',
  sh: 'text/x-sh',
  sql: 'text/x-sql',
  log: 'text/x-log',
};

/**
 * The type a file's extension says. Text is decided by the one text classifier, Chat's `classifyFile`
 * (src/core/attachments): an extension it reads as text (`.tsx`, `.vue`, `.kt`…) that has no entry above
 * becomes `text/x-<extension>`, so `text/*` tools take it and `text/plain` ones (read aloud) do not.
 */
function extensionMime(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (!extension) return '';
  const known = BY_EXTENSION[extension];
  if (known) return known;
  return classifyFile({ name, type: '' }) === 'text' ? `text/x-${extension}` : '';
}

/** The file's MIME type, from `type` or else its extension; '' when unknown. */
export function fileMime(file: { type: string; name?: string }): string {
  if (file.type) return file.type.toLowerCase();
  return extensionMime(file.name ?? '');
}

/**
 * Every type a file can count as: the browser's and its extension's. Browsers report some text files wrongly
 * (Windows calls `.ts` an MPEG transport stream, `.csv` an Excel sheet), so a match on either is a match.
 */
export function fileMimes(file: { type: string; name?: string }): string[] {
  return [...new Set([file.type.toLowerCase(), extensionMime(file.name ?? '')].filter(Boolean))];
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
  return fileMimes(file).some((mime) => mimeMatches(mime, accept));
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
  'text/*': 'text and code',
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
