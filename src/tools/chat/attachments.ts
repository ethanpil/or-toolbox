/**
 * Files attached to a chat message: what kind each is, the size limits, reading them, and the content part each
 * becomes in the request (docs/openrouter-api.md §2.4, §2.5).
 *
 * - Images (PNG, JPEG, WebP, GIF) go as `image_url` data URLs; the model needs image input.
 * - PDFs go as a `file` part with a data URL; the request adds the `file-parser` plugin (engine chosen in
 *   Settings; the free `cloudflare-ai` by default).
 * - Audio goes as base64 `input_audio`; only models with audio input take it.
 * - Text, Markdown and code files are inlined as text.
 *
 * Only the text of text files is kept with the thread. Image, PDF and audio bytes stay in memory (the session
 * map, keyed by attachment id) and are gone after a reload: such attachments then go to the model as a short note.
 */
import type { ContentPart } from '../../core/api/types';
import { InvalidInputError } from '../../core/errors';
import { readAsDataUrl, readAsText } from '../../core/files';
import { isPlainObject, isString } from '../../core/util';
import { formatBytes } from '../../ui/format';
import { type AttachmentKind, type AttachmentRef, newId } from './thread';

const MB = 1024 * 1024;

/** Largest file per kind. Base64 adds a third on the wire; these keep a request well under OpenRouter's limits. */
export const SIZE_LIMITS: Readonly<Record<AttachmentKind, number>> = {
  image: 10 * MB,
  pdf: 25 * MB,
  audio: 25 * MB,
  text: 1 * MB,
};

/** At most this many attachments on one message. */
export const MAX_ATTACHMENTS = 10;

/** All text files of one message together: they are inlined into the prompt (and stored with the thread). */
export const TEXT_TOTAL_LIMIT = 2 * MB;

/** The longest parser text of a PDF kept with a thread; a longer one is uploaded and parsed again. */
export const PARSED_LIMIT = 1 * MB;

const KIND_LABELS: Readonly<Record<AttachmentKind, string>> = {
  image: 'Images',
  pdf: 'PDFs',
  audio: 'Audio files',
  text: 'Text files',
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** `input_audio.format` per MIME type. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
  'audio/webm': 'webm',
};
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  oga: 'ogg',
  flac: 'flac',
  aac: 'aac',
  m4a: 'm4a',
  aif: 'aiff',
  aiff: 'aiff',
};

/** Extensions read as text whatever type the browser reports (it often reports none, or a wrong one). */
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown csv tsv json jsonl ndjson xml yaml yml toml ini cfg conf env log html htm css scss less ' +
    'js mjs cjs jsx ts tsx vue svelte py rb go rs java kt kts scala c h cc cpp hpp cs php sh bash zsh ps1 bat ' +
    'sql swift m r lua pl dart ex exs erl hs clj tex srt vtt diff patch rst adoc org gitignore dockerfile makefile'
  ).split(' '),
);
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/sql',
  'application/x-subrip',
]);

/** What `accept` on the composer's file input lists: every type and extension we read. */
export const ACCEPT_ATTRIBUTE = [
  ...IMAGE_TYPES,
  'application/pdf',
  'audio/*',
  'text/*',
  ...TEXT_TYPES,
  ...[...TEXT_EXTENSIONS].map((extension) => `.${extension}`),
].join(',');

const extensionOf = (name: string): string =>
  /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? name.toLowerCase();

/** The kind of a file, from its type and its extension; null when chat cannot use it. */
export function classifyFile(file: { name: string; type: string }): AttachmentKind | null {
  const type = file.type.toLowerCase();
  const extension = extensionOf(file.name);
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  if (IMAGE_TYPES.has(type) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) {
    return 'image';
  }
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type.startsWith('audio/') || extension in AUDIO_EXTENSIONS) return 'audio';
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) return 'text';
  return null;
}

/** `input_audio.format` for an audio attachment (`mp3` when nothing better is known). */
export function audioFormat(ref: Pick<AttachmentRef, 'name' | 'type'>): string {
  return (
    AUDIO_FORMATS[ref.type.toLowerCase().split(';')[0] ?? ''] ??
    AUDIO_EXTENSIONS[extensionOf(ref.name)] ??
    'mp3'
  );
}

/** The MIME type to keep for a file whose browser type is empty or generic. */
function mimeFor(file: File, kind: AttachmentKind): string {
  if (file.type) return file.type;
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'text') return 'text/plain';
  if (kind === 'image') {
    const extension = extensionOf(file.name);
    return extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  }
  return `audio/${audioFormat({ name: file.name, type: '' })}`;
}

export interface ReadAttachment {
  ref: AttachmentRef;
  /** A data URL for images, PDFs and audio (kept in memory only); undefined for text. */
  data?: string;
}

/**
 * Reads a file for attaching. Throws InvalidInputError (a message the user can act on) for files chat cannot
 * use and files over the size limit.
 */
export async function readAttachment(file: File): Promise<ReadAttachment> {
  const kind = classifyFile(file);
  if (!kind) {
    throw new InvalidInputError(
      `${file.name} can't be attached: chat takes images, PDFs, audio, and text or code files.`,
    );
  }
  const limit = SIZE_LIMITS[kind];
  if (file.size > limit) {
    throw new InvalidInputError(
      `${file.name} is ${formatBytes(file.size)}. ${KIND_LABELS[kind]} can be at most ${formatBytes(limit)}.`,
    );
  }
  const ref: AttachmentRef = {
    id: newId(),
    name: file.name || 'attachment',
    type: mimeFor(file, kind),
    size: file.size,
    kind,
  };
  if (kind === 'text') {
    const text = await readAsText(file);
    if (text.includes('\u0000')) {
      throw new InvalidInputError(`${file.name} looks like a binary file, not text.`);
    }
    return { ref: { ...ref, text } };
  }
  const blob = file.type ? file : file.slice(0, file.size, ref.type);
  return { ref, data: await readAsDataUrl(blob) };
}

/** A text item from "Send to…" as a text attachment. */
export function textAttachment(name: string, text: string, type = 'text/plain'): AttachmentRef {
  return { id: newId(), name, type, size: new Blob([text]).size, kind: 'text', text };
}

/**
 * Throws InvalidInputError when `size` bytes of text named `name` are over the per-file limit, or would take the
 * text files of the message (`pending`) over TEXT_TOTAL_LIMIT.
 */
export function checkText(pending: readonly AttachmentRef[], name: string, size: number): void {
  if (size > SIZE_LIMITS.text) {
    throw new InvalidInputError(
      `${name} is ${formatBytes(size)}. Text can be at most ${formatBytes(SIZE_LIMITS.text)}.`,
    );
  }
  const total = pending.reduce((sum, ref) => sum + (ref.kind === 'text' ? ref.size : 0), 0);
  if (total + size > TEXT_TOTAL_LIMIT) {
    throw new InvalidInputError(
      `${name} doesn't fit: one message takes at most ${formatBytes(TEXT_TOTAL_LIMIT)} of text files.`,
    );
  }
}

/**
 * The parser's text of each PDF a reply's `annotations` describe (`{ type: 'file', file: { name, content } }`,
 * docs/openrouter-api.md §2.5), in order: its text parts joined. Image parts (from OCR) are left out; texts over
 * PARSED_LIMIT are skipped.
 */
export function parsedFiles(annotations: unknown): { name: string; text: string }[] {
  if (!Array.isArray(annotations)) return [];
  const files: { name: string; text: string }[] = [];
  for (const annotation of annotations) {
    if (!isPlainObject(annotation) || annotation['type'] !== 'file') continue;
    const file = annotation['file'];
    if (!isPlainObject(file) || !isString(file['name']) || !Array.isArray(file['content']))
      continue;
    const text = file['content']
      .filter((part) => isPlainObject(part) && part['type'] === 'text' && isString(part['text']))
      .map((part) => (part as { text: string }).text)
      .join('\n');
    if (text && text.length <= PARSED_LIMIT) files.push({ name: file['name'], text });
  }
  return files;
}

/** A note in place of an attachment whose bytes are gone (the thread was reloaded). */
export function missingNote(ref: AttachmentRef): string {
  return `[Attachment "${ref.name}" (${ref.kind === 'pdf' ? 'PDF' : ref.kind}) is no longer available.]`;
}

/**
 * The content part an attachment becomes. `data` is its data URL from the session (absent after a reload, then
 * the part is a short note so the model knows something was there).
 */
export function toContentPart(ref: AttachmentRef, data: string | undefined): ContentPart {
  if (ref.kind === 'text') {
    return { type: 'text', text: `<file name="${ref.name}">\n${ref.text ?? ''}\n</file>` };
  }
  // A PDF the parser read before: its text, without uploading or parsing it again.
  if (ref.kind === 'pdf' && ref.parsed !== undefined) return { type: 'text', text: ref.parsed };
  if (!data) return { type: 'text', text: missingNote(ref) };
  switch (ref.kind) {
    case 'image':
      return { type: 'image_url', image_url: { url: data } };
    case 'pdf':
      return { type: 'file', file: { filename: ref.name, file_data: data } };
    case 'audio':
      return {
        type: 'input_audio',
        input_audio: { data: data.slice(data.indexOf(',') + 1), format: audioFormat(ref) },
      };
  }
}
