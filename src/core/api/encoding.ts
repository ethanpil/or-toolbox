/** Binary helpers for request and response bodies (base64 and data URLs, format detection). */

import { fromBase64, toBase64 } from '../crypto';

/** Detects common image types from magic bytes; falls back to `fallback`. */
export function sniffImageType(bytes: Uint8Array, fallback = 'image/png'): string {
  const b = (i: number): number => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57)
    return 'image/webp';
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'image/gif';
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')))
    return 'image/svg+xml';
  return fallback;
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
  const mediaType = declared || sniffImageType(bytes);
  return { blob: new Blob([bytes], { type: mediaType }), mediaType, bytes: bytes.length };
}

/** Raw base64 of a Blob (no `data:` prefix), as STT `input_audio.data` wants it. */
export async function blobToBase64(blob: Blob): Promise<string> {
  return toBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * A `data:` URL for image references (`/images` `input_references`, video `frame_images`). OpenRouter accepts
 * data URLs for images only; audio and video references must be public HTTPS URLs.
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  return `data:${blob.type || 'application/octet-stream'};base64,${await blobToBase64(blob)}`;
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

/** Splits `audio/pcm;rate=24000;channels=1` into its base type and numeric parameters. */
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
