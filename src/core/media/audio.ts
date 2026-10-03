/**
 * Audio helpers for speech-to-text, text-to-speech and music.
 *
 * - Decoding any browser-playable audio (or the audio track of a video) to
 *   float samples, resampled by the browser (`decodeAudio`).
 * - Cutting long recordings into chunks a transcription model accepts, at the
 *   quietest point near each boundary (`splitForTranscription`).
 * - Waveform peaks, durations.
 * - WAV and MP3 byte handling, re-exported from wav.ts and mp3.ts so tools
 *   import everything audio from here.
 *
 * Memory limits for long audio. `decodeAudio` holds the whole recording as
 * Float32 (4 bytes per sample per channel) and the browser decodes it in one
 * go, so peak memory is roughly the decoded size plus the source file:
 *
 * | Recording (60 min)           | Decoded (Float32)  |
 * | ---------------------------- | ------------------ |
 * | 16 kHz mono                  | 230 MB             |
 * | 16 kHz stereo (before mono)  | 460 MB             |
 * | 44.1 kHz stereo              | 1.27 GB (will fail on many devices) |
 *
 * So: ask for `{ sampleRate: 16000, mono: true }` (the default for speech
 * work); the browser then resamples while decoding, and a 60-minute file needs
 * about 460 MB at the peak, less once downmixed. For anything longer or
 * larger, or for formats `decodeAudioData` refuses, convert first with
 * `transcodeAudio` from ffmpeg-ops.ts (16 kHz mono WAV) and decode that.
 * `splitForTranscription` then adds 2 bytes per sample (115 MB per hour of
 * 16 kHz mono) as WAV Blobs, which the browser may keep outside the JS heap.
 */
import { InvalidInputError } from '../errors';
import { sniffBlobMime } from '../files';
import { sleep } from '../util';
import { mediaDuration } from './media-element';
import { mp3Duration } from './mp3';
import { encodeWav, wavDuration } from './wav';

export * from './mp3';
export * from './wav';

/** Decoded audio: one Float32Array of samples (-1 to 1) per channel, all the same length. */
export interface AudioData {
  sampleRate: number;
  channels: Float32Array[];
}

/** Samples per channel. */
export function audioLength(audio: AudioData): number {
  return audio.channels[0]?.length ?? 0;
}

/** Length in seconds. */
export function audioSeconds(audio: AudioData): number {
  return audioLength(audio) / audio.sampleRate;
}

// --- decoding ---------------------------------------------------------------

export interface DecodeOptions {
  /** Output sample rate; the browser resamples while decoding. Default 44100. */
  sampleRate?: number;
  /** Average all channels into one. Default false. */
  mono?: boolean;
}

/**
 * Decodes an audio Blob (MP3, WAV, Ogg, AAC/M4A, FLAC, WebM and the audio of
 * MP4/WebM videos where the browser supports it) with an
 * `OfflineAudioContext`, which resamples to `sampleRate` during decoding.
 * Browser only. See the module note for memory use.
 */
export async function decodeAudio(blob: Blob, options: DecodeOptions = {}): Promise<AudioData> {
  const rate = options.sampleRate ?? 44100;
  if (typeof OfflineAudioContext === 'undefined') {
    throw new InvalidInputError('This browser cannot decode audio.');
  }
  const bytes = await blob.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    buffer = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'EncodingError') {
      throw new InvalidInputError(
        'This audio cannot be decoded. The format may not be supported by this browser.',
        { cause: error },
      );
    }
    if (error instanceof RangeError) {
      throw new InvalidInputError(
        'This recording is too long to decode in the browser. Try a shorter file.',
        { cause: error },
      );
    }
    throw error;
  }

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  if (options.mono && channels.length > 1) {
    // Average into the first channel in place: no extra copy of a long recording.
    const target = channels[0];
    if (target) {
      const count = channels.length;
      for (let i = 0; i < target.length; i++) {
        let sum = 0;
        for (const channel of channels) sum += channel[i] ?? 0;
        target[i] = sum / count;
      }
      channels.length = 1;
    }
  }
  return { sampleRate: buffer.sampleRate, channels };
}

// --- resampling and mixing --------------------------------------------------

/** Averages all channels of `[start, end)` into one new array (or returns a view when already mono). */
export function mixToMono(channels: Float32Array[], start = 0, end?: number): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  const stop = end ?? first.length;
  if (channels.length === 1) return first.subarray(start, stop);
  const mixed = new Float32Array(stop - start);
  for (let i = 0; i < mixed.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[start + i] ?? 0;
    mixed[i] = sum / channels.length;
  }
  return mixed;
}

/**
 * Resamples one channel with a triangle filter (an average over the covered
 * input when shrinking, linear interpolation when growing). Good enough for
 * speech; not for mastering.
 */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(length);
  const support = Math.max(ratio, 1);
  for (let j = 0; j < length; j++) {
    const center = (j + 0.5) * ratio;
    const from = Math.max(0, Math.floor(center - support + 0.5));
    const to = Math.min(samples.length, Math.floor(center + support + 0.5));
    let sum = 0;
    let weights = 0;
    for (let i = from; i < to; i++) {
      const distance = Math.abs((i + 0.5 - center) / support);
      const weight = distance < 1 ? 1 - distance : 0;
      sum += (samples[i] ?? 0) * weight;
      weights += weight;
    }
    out[j] =
      weights > 0
        ? sum / weights
        : (samples[Math.min(samples.length - 1, Math.floor(center))] ?? 0);
  }
  return out;
}

// --- chunking for transcription ---------------------------------------------

export const TRANSCRIPTION_SAMPLE_RATE = 16000;

export interface SplitOptions {
  /** Longest chunk in seconds. Default 600. Chunks never exceed it. */
  maxSeconds?: number;
  /** A pause at least this long counts as silence to cut in. Default 0.3. */
  minSilenceSeconds?: number;
  /** How far before each boundary to look for a quiet spot, in seconds. Default a quarter of `maxSeconds`, at most 30. */
  searchSeconds?: number;
}

export interface SampleRange {
  /** First sample of the chunk (in the input audio's own sample rate). */
  start: number;
  /** One past the last sample. */
  end: number;
}

export interface TranscriptionChunk {
  /** 16 kHz mono 16-bit WAV. */
  blob: Blob;
  /** Where the chunk starts in the original recording, in seconds: add it to the chunk's own timestamps. */
  start: number;
  /** Length in seconds. */
  duration: number;
}

/** Root-mean-square level of `[from, to)` across all channels. */
function rms(channels: Float32Array[], from: number, to: number): number {
  let sum = 0;
  for (const channel of channels) {
    for (let i = from; i < to; i++) {
      const value = channel[i] ?? 0;
      sum += value * value;
    }
  }
  const count = (to - from) * channels.length;
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/** A level so low (-100 dBFS) that it is digital silence whatever else the window holds. */
const DIGITAL_SILENCE = 1e-5;
/** Analysis frame length in seconds. */
const FRAME_SECONDS = 0.02;

/**
 * Where to cut inside `[low, high)`: the middle of the latest pause of at
 * least `minSilence` samples (or `high` itself if the pause runs to the end of
 * the window), or, when there is no such pause, the middle of the single
 * quietest frame.
 *
 * "Pause" is relative to the window, so a recording made at any volume has
 * them: a frame is quiet when its level is within 1.5x of the window's low
 * end (the 10th percentile), but never above half the window's median level,
 * so ordinary speech is not mistaken for silence; the quietest frame always
 * qualifies. Nothing here depends on an absolute level.
 */
function quietestCut(
  channels: Float32Array[],
  sampleRate: number,
  low: number,
  high: number,
  minSilence: number,
): number {
  const frame = Math.max(1, Math.round(sampleRate * FRAME_SECONDS));
  const count = Math.floor((high - low) / frame);
  if (count < 1) return high;
  const levels = new Float32Array(count);
  let quietest = Infinity;
  let quietestIndex = count - 1;
  for (let f = 0; f < count; f++) {
    const level = rms(channels, low + f * frame, low + (f + 1) * frame);
    levels[f] = level;
    // `<=` prefers the later of equally quiet frames: longer chunks.
    if (level <= quietest) {
      quietest = level;
      quietestIndex = f;
    }
  }

  const sorted = Float32Array.from(levels).sort();
  const median = sorted[count >> 1] ?? quietest;
  const lowEnd = sorted[Math.floor(count * 0.1)] ?? quietest;
  const limit = Math.max(Math.min(Math.max(lowEnd * 1.5, DIGITAL_SILENCE), median * 0.5), quietest);
  const minFrames = Math.max(1, Math.ceil(minSilence / frame));
  let bestMiddle = -1;
  let runStart = -1;
  for (let f = 0; f <= count; f++) {
    const quiet = f < count && (levels[f] ?? Infinity) <= limit;
    if (quiet && runStart < 0) runStart = f;
    if (!quiet && runStart >= 0) {
      // A pause that is still going at the end of the window can be cut at the limit itself.
      if (f - runStart >= minFrames) bestMiddle = f === count ? count : (runStart + f) / 2;
      runStart = -1;
    }
  }
  const middleFrame = bestMiddle >= 0 ? bestMiddle : quietestIndex + 0.5;
  return Math.min(high, Math.max(low + 1, low + Math.round(middleFrame * frame)));
}

/** A last chunk shorter than this is merged into the one before it. */
const MIN_TAIL_SECONDS = 1;

/**
 * Decides where to cut a recording: sample ranges, each at most `maxSeconds`
 * long, with every cut placed at the quietest point (preferably inside a real
 * pause) in the last `searchSeconds` before the limit. A cut is never made in
 * the first half of a chunk.
 *
 * The one exception to the limit: a tail shorter than one second (which a
 * transcription model may refuse, or answer with nothing) is merged into the
 * chunk before it, so that chunk can run up to one second over `maxSeconds`.
 * A caller with a hard limit passes a `maxSeconds` that leaves that margin.
 */
export function planChunks(audio: AudioData, options: SplitOptions = {}): SampleRange[] {
  const total = audioLength(audio);
  if (total === 0) return [];
  const rate = audio.sampleRate;
  const maxSeconds = options.maxSeconds ?? 600;
  if (!(maxSeconds > 0)) throw new RangeError('maxSeconds must be positive.');
  const maxSamples = Math.max(1, Math.floor(maxSeconds * rate));
  const searchSamples = Math.min(
    Math.floor((options.searchSeconds ?? Math.min(30, maxSeconds / 4)) * rate),
    Math.floor(maxSamples / 2),
  );
  const minSilence = (options.minSilenceSeconds ?? 0.3) * rate;

  const ranges: SampleRange[] = [];
  let start = 0;
  while (total - start > maxSamples) {
    const limit = start + maxSamples;
    const cut = quietestCut(audio.channels, rate, limit - searchSamples, limit, minSilence);
    ranges.push({ start, end: cut });
    start = cut;
  }
  const previous = ranges.at(-1);
  if (previous && total - start < Math.floor(MIN_TAIL_SECONDS * rate)) previous.end = total;
  else ranges.push({ start, end: total });
  return ranges;
}

/**
 * Splits a recording into 16 kHz mono WAV chunks that fit a transcription
 * model's length limit, cutting at pauses so words are not split. Add each
 * chunk's `start` to the timestamps its transcript returns to get one
 * continuous timeline. Input at another rate or with several channels is
 * mixed down and resampled here.
 */
export async function splitForTranscription(
  audio: AudioData,
  options: SplitOptions = {},
): Promise<TranscriptionChunk[]> {
  const chunks: TranscriptionChunk[] = [];
  for (const { start, end } of planChunks(audio, options)) {
    let samples = mixToMono(audio.channels, start, end);
    samples = resample(samples, audio.sampleRate, TRANSCRIPTION_SAMPLE_RATE);
    chunks.push({
      blob: encodeWav([samples], TRANSCRIPTION_SAMPLE_RATE),
      start: start / audio.sampleRate,
      duration: (end - start) / audio.sampleRate,
    });
    // Let the page breathe between chunks of a long recording.
    await sleep(0);
  }
  return chunks;
}

// --- waveform and duration --------------------------------------------------

/** For drawing a waveform: the loudest absolute sample (0 to 1) in each of `buckets` equal slices. */
export function peaks(audio: AudioData, buckets: number): Float32Array {
  const count = Math.max(1, Math.floor(buckets));
  const out = new Float32Array(count);
  const length = audioLength(audio);
  for (let b = 0; b < count; b++) {
    const from = Math.floor((b * length) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * length) / count));
    let peak = 0;
    for (const channel of audio.channels) {
      for (let i = from; i < to && i < length; i++) {
        const value = Math.abs(channel[i] ?? 0);
        if (value > peak) peak = value;
      }
    }
    out[b] = peak;
  }
  return out;
}

/**
 * Length in seconds of an audio file. WAV and MP3 are measured from their
 * bytes (exact, no decoding); anything else is loaded into an `<audio>`
 * element. Browser only for the last case.
 */
export async function getAudioDuration(blob: Blob): Promise<number> {
  const type = await sniffBlobMime(blob);
  try {
    if (type === 'audio/wav') return await wavDuration(blob);
    if (type === 'audio/mpeg') return await mp3Duration(blob);
  } catch {
    // Not readable as the format its first bytes claim (truncated, odd header): let the browser have a go.
  }
  return mediaDuration(blob, 'audio');
}

/** Seconds of audio in raw 16-bit PCM. */
export function pcmDuration(byteLength: number, sampleRate: number, channels = 1): number {
  return byteLength / (2 * channels) / sampleRate;
}
