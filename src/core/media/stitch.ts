/**
 * Joining audio segments into one gapless file: what text-to-speech needs
 * when long text was synthesised in pieces.
 *
 * MP3 segments cannot simply be appended (`concatMp3`): every encoder adds
 * silence at the start and end of its output, and a Layer III frame can lean
 * on bits of the frame before it, so seams click or pause. Here the segments
 * are decoded, their samples joined, and the result encoded once: a WAV
 * directly, or an MP3 through ffmpeg. The cost is a decode of every segment
 * and, for MP3, one encode (about a second per ten minutes of audio).
 *
 * Memory: each segment is decoded in turn and kept as 16-bit samples (2 bytes
 * per sample per channel: 170 MB for an hour at 24 kHz mono), so only one
 * segment is ever held as floats. For MP3 the joined WAV also goes into
 * ffmpeg's memory next to the result, so budget about three times the WAV.
 */
import { InvalidInputError } from '../errors';
import { sniffBlobMime } from '../files';
import { sleep, throwIfAborted } from '../util';
import { decodeAudio, mixToMono } from './audio';
import { type FfmpegOpOptions, transcodeAudio } from './ffmpeg-ops';
import { parseMp3 } from './mp3';
import { interleaveToInt16, readWavInfo, wavHeader } from './wav';

export interface StitchOptions {
  /** MP3 bit rate in kbit/s, for `'mp3'` output. Default 128. */
  bitrate?: number;
  /** Aborting rejects with an `AbortError`, between segments or in ffmpeg. */
  signal?: AbortSignal;
  /** 0 to 1 over decoding and, for MP3, encoding. */
  onProgress?: (ratio: number) => void;
  /** Reports the one-time download of the ffmpeg core, for MP3 output. */
  onLoadProgress?: FfmpegOpOptions['onLoadProgress'];
  singleThread?: boolean;
}

/** Output sample rate when no segment says what its own is. */
const DEFAULT_SAMPLE_RATE = 44100;

/** Sample rate and channel count from the header of a WAV or MP3, or `null` if the Blob is neither (or unreadable). */
async function headerFormat(blob: Blob): Promise<{ sampleRate: number; channels: number } | null> {
  try {
    const type = await sniffBlobMime(blob);
    if (type === 'audio/wav') {
      const { sampleRate, channels } = await readWavInfo(blob);
      return { sampleRate, channels };
    }
    if (type === 'audio/mpeg') {
      const { info } = parseMp3(new Uint8Array(await blob.arrayBuffer()));
      return { sampleRate: info.sampleRate, channels: info.channels };
    }
  } catch {
    // Not readable as what it claims to be: decoding will report the real problem.
  }
  return null;
}

/** The decoded channels as exactly `count` (1 or 2): mixed down, or the mono channel repeated. */
function toChannelCount(channels: Float32Array[], count: number): Float32Array[] {
  const first = channels[0];
  if (!first) return Array.from({ length: count }, () => new Float32Array(0));
  if (count === 1) return [mixToMono(channels)];
  return [first, channels[1] ?? first];
}

/**
 * Joins audio segments (anything the browser decodes: MP3, WAV, Ogg, …) into
 * one file with no gap, click or repeated padding at the seams.
 *
 * The output keeps the sample rate of the first segment that states one
 * (WAV and MP3 do), and is stereo if any segment is (mono segments are
 * repeated in both channels), else mono. Wrap raw PCM from a PCM-only TTS
 * model with `pcmToWav` first.
 */
export async function stitchAudio(
  segments: readonly Blob[],
  format: 'mp3' | 'wav',
  options: StitchOptions = {},
): Promise<Blob> {
  if (segments.length === 0) throw new InvalidInputError('There is no audio to join.');
  const { signal } = options;
  throwIfAborted(signal);

  const headers = await Promise.all(segments.map(headerFormat));
  const sampleRate = headers.find((header) => header !== null)?.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = Math.min(2, Math.max(1, ...headers.map((header) => header?.channels ?? 1)));
  const decodeShare = format === 'mp3' ? 0.5 : 1;

  const parts: Int16Array<ArrayBuffer>[] = [];
  let bytes = 0;
  for (const [index, segment] of segments.entries()) {
    throwIfAborted(signal);
    const audio = await decodeAudio(segment, { sampleRate });
    const pcm = interleaveToInt16(toChannelCount(audio.channels, channels));
    parts.push(pcm);
    bytes += pcm.byteLength;
    options.onProgress?.(((index + 1) / segments.length) * decodeShare);
    await sleep(0, signal);
  }

  const wav = new Blob([wavHeader(bytes, sampleRate, channels), ...parts], { type: 'audio/wav' });
  if (format === 'wav') return wav;

  return transcodeAudio(wav, 'mp3', {
    ...(options.bitrate === undefined ? {} : { bitrate: options.bitrate }),
    ...(signal ? { signal } : {}),
    ...(options.onLoadProgress ? { onLoadProgress: options.onLoadProgress } : {}),
    ...(options.singleThread ? { singleThread: true } : {}),
    onProgress: (ratio) => options.onProgress?.(decodeShare + ratio * (1 - decodeShare)),
  });
}
