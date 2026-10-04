/**
 * The audio Speech-to-text transcribes: a dropped or chosen file, a recording or the sample. `inspectSource` reads
 * what it is (audio or video, duration) without decoding it; `prepareParts` turns it into the requests' audio.
 *
 * - A short audio file in a format the API takes (`input_audio.format`, docs/openrouter-api.md §5.1) is sent as it
 *   is: one part, no decoding, the smallest body.
 * - Everything else (long audio, video, other formats) is decoded to 16 kHz mono (`decodeAudio`; a video's sound
 *   track where the browser can read it) and cut near pauses into 16 kHz WAV parts (`splitForTranscription`).
 *   When the browser cannot decode it, ffmpeg extracts a 16 kHz mono WAV first (one 32 MB download, cached).
 *   Memory for an hour: about 115 MB of source WAV, 230 MB decoded while cutting, then 115 MB of parts (the
 *   decoded samples are dropped once cut); see src/core/media/audio.ts.
 *
 * The media modules load on first use (one cached import each: Vitest never settles concurrent dynamic imports
 * of one mocked module, and a page should not fetch them twice).
 */
import { InvalidInputError } from '../../core/errors';
import { sniffBlobMime } from '../../core/files';
import type * as audioMedia from '../../core/media/audio';
import type { AudioData } from '../../core/media/audio';
import { mediaDuration } from '../../core/media/media-element';

export interface AudioSource {
  /** Changes whenever the source does (keys the cached parts). */
  id: string;
  name: string;
  blob: Blob;
  kind: 'audio' | 'video';
  /** Sniffed type, e.g. `audio/mpeg`; null when the bytes did not say. */
  mime: string | null;
  /** Seconds, or null when the browser could not tell before decoding. */
  duration: number | null;
  origin: 'file' | 'recording' | 'sample';
}

export interface AudioPart {
  index: number;
  /** Where it starts in the recording, in seconds. */
  start: number;
  duration: number;
  blob: Blob;
  /** `input_audio.format`. */
  format: string;
}

type AudioModule = typeof audioMedia;
let audioModule: Promise<AudioModule> | null = null;

/** The audio helpers, imported once (a failed import is tried again next time). */
export function loadAudioModule(): Promise<AudioModule> {
  audioModule ??= import('../../core/media/audio').catch((error: unknown) => {
    audioModule = null;
    throw error;
  });
  return audioModule;
}

/** Formats sent as they are, by sniffed type and by file extension. */
const FORMAT_BY_MIME: Readonly<Record<string, string>> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
};
const FORMAT_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  m4a: 'm4a',
  ogg: 'ogg',
  oga: 'ogg',
  opus: 'ogg',
  webm: 'webm',
  aac: 'aac',
};
/** Larger files are re-encoded even when short (the request limit is 25 MB of base64, §5.2). */
const PASSTHROUGH_MAX_BYTES = 15 * 1024 * 1024;

export const SPEECH_DECODE = { sampleRate: 16000, mono: true } as const;

let sourceCounter = 0;

/** What a file or recording is, and how long. Never throws for an unreadable duration (it stays null). */
export async function inspectSource(
  blob: Blob,
  name: string,
  origin: AudioSource['origin'],
): Promise<AudioSource> {
  const mime = await sniffBlobMime(blob).catch(() => null);
  const kind = (mime ?? blob.type.toLowerCase()).startsWith('video/') ? 'video' : 'audio';
  const duration = await (
    kind === 'video'
      ? mediaDuration(blob, 'video')
      : loadAudioModule().then((media) => media.getAudioDuration(blob))
  ).catch(() => null);
  return {
    id: `source-${++sourceCounter}`,
    name,
    blob,
    kind,
    mime,
    duration: duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
    origin,
  };
}

/** The format a short source can be sent in as it is, or null when it must be decoded and re-encoded. */
export function passthroughFormat(
  source: Pick<AudioSource, 'kind' | 'mime' | 'name'>,
): string | null {
  if (source.kind !== 'audio') return null;
  if (source.mime) return FORMAT_BY_MIME[source.mime] ?? null;
  const extension = /\.([a-z0-9]{2,5})$/i.exec(source.name)?.[1]?.toLowerCase() ?? '';
  return FORMAT_BY_EXTENSION[extension] ?? null;
}

/** True when the source goes out as one request without decoding. */
export function sentAsIs(source: AudioSource, partSeconds: number, pcmWavOnly = false): boolean {
  return (
    !pcmWavOnly &&
    passthroughFormat(source) !== null &&
    source.duration !== null &&
    source.duration <= partSeconds &&
    source.blob.size <= PASSTHROUGH_MAX_BYTES
  );
}

/** How many parts a source of `duration` seconds is expected to be cut into (cuts land at pauses, so roughly). */
export function expectedParts(
  source: AudioSource,
  partSeconds: number,
  pcmWavOnly = false,
): number {
  if (sentAsIs(source, partSeconds, pcmWavOnly)) return 1;
  return Math.max(1, Math.ceil((source.duration ?? 0) / Math.max(1, partSeconds - 1)));
}

export interface PrepareOptions {
  /** Longest part in seconds. */
  partSeconds: number;
  /** The model takes only mono 16-bit PCM WAV: never send the file as it is (model-support.ts). */
  pcmWavOnly?: boolean;
  signal: AbortSignal;
  /** Short progress lines ("Decoding the audio…"). */
  onStatus: (text: string) => void;
}

/** Decodes a source to 16 kHz mono, through ffmpeg when the browser cannot. */
async function decodeForSpeech(source: AudioSource, options: PrepareOptions): Promise<AudioData> {
  const media = await loadAudioModule();
  options.signal.throwIfAborted();
  options.onStatus(
    source.kind === 'video' ? 'Reading the sound track of the video…' : 'Decoding the audio…',
  );
  try {
    return await media.decodeAudio(source.blob, SPEECH_DECODE);
  } catch (error) {
    if (!(error instanceof InvalidInputError)) throw error;
    options.signal.throwIfAborted();
    options.onStatus('Extracting the audio with ffmpeg…');
    const { transcodeAudio } = await import('../../core/media/ffmpeg-ops');
    const wav = await transcodeAudio(source.blob, 'wav', {
      sampleRate: SPEECH_DECODE.sampleRate,
      channels: 1,
      signal: options.signal,
      onLoadProgress: ({ loaded, total }) =>
        options.onStatus(
          `Downloading the audio converter (once)… ${total > 0 ? Math.round((loaded / total) * 100) : 0}%`,
        ),
      onProgress: (ratio) =>
        options.onStatus(`Extracting the audio with ffmpeg… ${Math.round(ratio * 100)}%`),
    });
    options.signal.throwIfAborted();
    return media.decodeAudio(wav, SPEECH_DECODE);
  }
}

/** The audio of every request: the source itself when short, else 16 kHz WAV parts cut at pauses. */
export async function prepareParts(
  source: AudioSource,
  options: PrepareOptions,
): Promise<AudioPart[]> {
  const format = passthroughFormat(source);
  if (format && sentAsIs(source, options.partSeconds, options.pcmWavOnly)) {
    return [{ index: 0, start: 0, duration: source.duration ?? 0, blob: source.blob, format }];
  }
  const audio = await decodeForSpeech(source, options);
  options.signal.throwIfAborted();
  options.onStatus('Cutting the recording at pauses…');
  const media = await loadAudioModule();
  // The planner may run one second over its limit to avoid a tiny last part.
  const chunks = await media.splitForTranscription(audio, {
    maxSeconds: Math.max(1, options.partSeconds - 1),
  });
  if (chunks.length === 0) throw new InvalidInputError('This recording has no audio in it.');
  return chunks.map((chunk, index) => ({
    index,
    start: chunk.start,
    duration: chunk.duration,
    blob: chunk.blob,
    format: 'wav',
  }));
}
