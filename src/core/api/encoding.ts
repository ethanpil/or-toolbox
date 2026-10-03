/** Binary helpers for request and response bodies (base64 to Blob, format detection, Content-Type). */

import { fromBase64 } from '../crypto';
import { sniffMime } from '../files';

/** `<svg` (optionally after an XML prolog) at the start of the bytes. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/**
 * Type of a generated image from its bytes. SVG is checked locally until `sniffMime` recognises it; anything
 * unrecognised is treated as PNG (OpenRouter omits `media_type` only when it could not tell either).
 */
export function imageType(bytes: Uint8Array): string {
  return sniffMime(bytes) ?? (looksLikeSvg(bytes) ? 'image/svg+xml' : 'image/png');
}

/** Decodes base64 (or a `data:` URL) into a Blob. `type` wins; otherwise the data URL's or a sniffed type. */
export function base64ToBlob(
  input: string,
  type?: string,
): { blob: Blob; mediaType: string; bytes: number } {
  let base64 = input;
  let declared = type;
  const match = /^data:([^;,]+)?(?:;[^,]*)?,/.exec(input);
  if (match) {
    base64 = input.slice(match[0].length);
    declared ??= match[1];
  }
  const bytes = fromBase64(base64.replace(/\s+/g, ''));
  const mediaType = declared || imageType(bytes);
  return { blob: new Blob([bytes], { type: mediaType }), mediaType, bytes: bytes.length };
}

const AUDIO_FORMATS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/aiff': 'aiff',
  'audio/x-aiff': 'aiff',
};

/** `input_audio.format` for an STT upload, from the Blob type or the filename; `mp3` when unknown. */
export function audioFormat(blob: Blob, filename?: string): string {
  const type = blob.type.split(';')[0]?.trim().toLowerCase() ?? '';
  const fromType = AUDIO_FORMATS[type];
  if (fromType) return fromType;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(filename ?? '')?.[1]?.toLowerCase();
  if (ext && /^[a-z0-9][a-z0-9+._-]{0,15}$/.test(ext)) return ext === 'mpeg' ? 'mp3' : ext;
  return 'mp3';
}

/** Splits `audio/pcm;rate=24000;channels=1` into its base type and parameters (names lower-cased). */
export function parseContentType(header: string | null): {
  type: string;
  params: Record<string, string>;
} {
  const [base = '', ...rest] = (header ?? '').split(';');
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return { type: base.trim().toLowerCase(), params };
}
