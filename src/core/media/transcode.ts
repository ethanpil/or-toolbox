/**
 * `transcode()`: `transcodeAudio` (ffmpeg-ops.ts) behind a dynamic import, so a page that may convert audio
 * (an MP3 saved as WAV, a recording the browser cannot decode) loads the ffmpeg plumbing only when a
 * conversion actually runs. Use it from tools and components; use ffmpeg-ops directly only inside src/core/media.
 */
import type { TranscodeAudioOptions } from './ffmpeg-ops';

/** What `transcode` writes. */
export type TranscodeFormat = 'mp3' | 'wav';

/** Converts audio (or a video's sound) to MP3 or 16-bit WAV; options as `transcodeAudio`'s. */
export async function transcode(
  blob: Blob,
  format: TranscodeFormat,
  options: TranscodeAudioOptions = {},
): Promise<Blob> {
  const { transcodeAudio } = await import('./ffmpeg-ops');
  return transcodeAudio(blob, format, options);
}
