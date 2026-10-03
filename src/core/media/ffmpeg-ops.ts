/**
 * Everyday ffmpeg jobs on top of the shared loader in ffmpeg.ts: transcode
 * audio, trim, probe, and join video clips into one MP4.
 *
 * Rules every operation follows:
 *
 * - One job at a time. The wasm instance is single-tasking and its log and
 *   progress events are global, so jobs queue up behind each other.
 * - Files live in ffmpeg's in-memory file system (it counts against the
 *   2 GB wasm heap: input + output + temporaries, so budget about three times
 *   the size of the inputs). Every file a job wrote is deleted when it ends,
 *   whether it succeeded or failed.
 * - An `AbortSignal` stops the job by terminating the instance and calling
 *   `disposeFfmpeg()`; the promise rejects with an `AbortError`. The next job
 *   starts a fresh instance (a few seconds, plus the 32 MB core from cache).
 * - `onProgress` gets 0 to 1. `onLoadProgress` reports the one-time core download.
 *
 * The multi-threaded core, used when the page is cross-origin isolated, is
 * several times faster than the single-threaded one for H.264 encoding.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { InvalidInputError } from '../errors';
import { extensionForMime, sniffBlobMime } from '../files';
import { abortError, throwIfAborted } from '../util';
import { disposeFfmpeg, loadFfmpeg, type LoadFfmpegOptions } from './ffmpeg';
import { type MediaInfo, parseMediaInfo } from './ffmpeg-probe';

export type { MediaInfo } from './ffmpeg-probe';

export interface FfmpegOpOptions {
  /** 0 to 1. Approximate: ffmpeg reports progress against the input length. */
  onProgress?: (ratio: number) => void;
  /** Reports the one-time download of the ffmpeg core (about 32 MB). */
  onLoadProgress?: LoadFfmpegOptions['onProgress'];
  /**
   * Aborting rejects with an `AbortError` at once: while the job waits its turn
   * it leaves the queue without ever starting, while the core loads it stops
   * waiting (the load itself finishes in the background for the next job), and
   * while ffmpeg runs it terminates the instance.
   */
  signal?: AbortSignal;
  /** Use the single-threaded core even when threads are available. */
  singleThread?: boolean;
}

// --- job plumbing -----------------------------------------------------------

/** Resolves when every job queued so far has finished (or has left the queue). Never rejects. */
let queue: Promise<void> = Promise.resolve();
let jobCounter = 0;

interface Job {
  ffmpeg: FFmpeg;
  /** True when the multi-threaded core is running. */
  multiThreaded: boolean;
  /** Thread limits for video work on this core (see `threadLimits`). */
  threads: ThreadArgs;
  /** A file name unique to this job, with an extension. Remembered for cleanup. */
  name: (label: string, extension: string) => string;
  /** Writes a Blob into the file system and returns its name. */
  write: (blob: Blob, label: string, extension: string) => Promise<string>;
  /** Runs ffmpeg and throws if it fails. */
  run: (args: string[], onTime?: (seconds: number, ratio: number) => void) => Promise<void>;
  /** Runs ffmpeg and returns the log text, whatever the exit code (for `-i` probing). */
  capture: (args: string[]) => Promise<string>;
  /** Reads a finished file as a Blob and deletes it. */
  read: (name: string, type: string) => Promise<Blob>;
  remove: (name: string) => Promise<void>;
}

interface ThreadArgs {
  /** Before `-i`: decoder threads. */
  decode: string[];
  /** Before the output file: encoder threads. */
  encode: string[];
  /** Global: threads of the filter graph. */
  filter: string[];
}

/**
 * Explicit thread limits for video work on the multi-threaded core. Left to
 * itself, libx264 starts 1.5 x the number of cores plus look-ahead threads and
 * the decoder one per core; beyond what the core's thread pool can supply,
 * Emscripten fails with "Cannot read properties of undefined (reading
 * 'startsWith')" (reproduced with an H.264 clip on a 4-core machine). With
 * these limits the same encode works, and runs about twice as fast as with a
 * single thread. The single-threaded core needs and takes no options.
 */
function threadLimits(multiThreaded: boolean): ThreadArgs {
  if (!multiThreaded) return { decode: [], encode: [], filter: [] };
  const cores = Math.max(1, navigator.hardwareConcurrency || 2);
  return {
    decode: ['-threads', String(Math.min(2, cores))],
    encode: ['-threads', String(Math.min(4, cores))],
    filter: ['-filter_threads', String(Math.min(2, cores))],
  };
}

/** `promise`, but rejecting with an AbortError as soon as `signal` aborts (the promise itself is left alone). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * Runs `work` with a ready ffmpeg instance, one job at a time (the instance
 * runs one command at a time and its log and progress events are global).
 */
async function withFfmpeg<T>(options: FfmpegOpOptions, work: (job: Job) => Promise<T>): Promise<T> {
  const { signal } = options;
  throwIfAborted(signal);

  // Take a place in the queue. `finished` is what the next job waits for after the one before us:
  // it is resolved when we are done, or when we give up our place (an abort while waiting must not
  // let the jobs behind us overtake the one still running).
  let finish = (): void => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const turn = queue;
  queue = turn.then(() => finished);

  try {
    await abortable(turn, signal);
    throwIfAborted(signal);
    return await runJob(options, work);
  } finally {
    finish();
  }
}

async function runJob<T>(options: FfmpegOpOptions, work: (job: Job) => Promise<T>): Promise<T> {
  const { signal } = options;
  // The load cannot be cancelled (other jobs share it), but the caller need not wait for it.
  const { ffmpeg, multiThreaded } = await abortable(
    loadFfmpeg({
      ...(options.onLoadProgress ? { onProgress: options.onLoadProgress } : {}),
      ...(options.singleThread ? { singleThread: true } : {}),
    }),
    signal,
  );
  throwIfAborted(signal);

  const id = ++jobCounter;
  const files = new Set<string>();
  let sink: string[] | undefined;
  const recent: string[] = [];
  let onTime: ((seconds: number, ratio: number) => void) | undefined;
  let aborted = false;

  const onLog = ({ message }: { message: string }): void => {
    sink?.push(message);
    recent.push(message);
    if (recent.length > 8) recent.shift();
  };
  const onProgress = ({ progress, time }: { progress: number; time: number }): void => {
    onTime?.(Math.max(0, time) / 1e6, Math.min(1, Math.max(0, progress)));
  };
  const onAbort = (): void => {
    aborted = true;
    disposeFfmpeg();
  };
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgress);
  signal?.addEventListener('abort', onAbort, { once: true });

  const name = (label: string, extension: string): string => {
    const file = `j${id}-${label}.${extension}`;
    files.add(file);
    return file;
  };
  const remove = async (file: string): Promise<void> => {
    files.delete(file);
    await ffmpeg.deleteFile(file).catch(() => false);
  };

  const job: Job = {
    ffmpeg,
    multiThreaded,
    threads: threadLimits(multiThreaded),
    name,
    write: async (blob, label, extension) => {
      const file = name(label, extension);
      await ffmpeg.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
      return file;
    },
    run: async (args, listener) => {
      onTime = listener;
      recent.length = 0;
      try {
        const code = await ffmpeg.exec(args);
        if (code !== 0) {
          throw new InvalidInputError(
            `Could not process this file: ffmpeg stopped with exit code ${code}. Its format may be unsupported or damaged.`,
            { cause: new Error(recent.slice(-3).join(' ')) },
          );
        }
      } finally {
        onTime = undefined;
      }
    },
    capture: async (args) => {
      const lines: string[] = [];
      sink = lines;
      try {
        await ffmpeg.exec(args);
      } finally {
        sink = undefined;
      }
      return lines.join('\n');
    },
    read: async (file, type) => {
      const data = await ffmpeg.readFile(file);
      await remove(file);
      if (typeof data === 'string') throw new InvalidInputError('ffmpeg wrote no output.');
      // A worker message delivers a plain ArrayBuffer, so the cast only narrows the type.
      return new Blob([data as Uint8Array<ArrayBuffer>], { type });
    },
    remove,
  };

  try {
    return await work(job);
  } catch (error) {
    if (aborted || signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!aborted) {
      ffmpeg.off('log', onLog);
      ffmpeg.off('progress', onProgress);
      for (const file of [...files]) await remove(file);
    }
  }
}

/**
 * What kind of file this is, from one sniff (`sniffBlobMime`, which looks at
 * the tracks of MP4 and WebM), and the extension to give ffmpeg's copy of it:
 * ffmpeg probes by content, so the name only needs to be plausible.
 */
async function describeInput(blob: Blob): Promise<{ type: string; extension: string }> {
  const type = (await sniffBlobMime(blob)) ?? blob.type;
  return { type, extension: extensionForMime(type) ?? 'bin' };
}

function seconds(value: number): string {
  return value.toFixed(3);
}

// --- probe ------------------------------------------------------------------

/** What ffmpeg reports about a media file: duration, video and audio stream formats. Works without a browser decoder. */
export function probeMedia(blob: Blob, options: FfmpegOpOptions = {}): Promise<MediaInfo> {
  return withFfmpeg(options, async (job) => {
    const input = await job.write(blob, 'probe', (await describeInput(blob)).extension);
    return parseMediaInfo(await job.capture(['-i', input]));
  });
}

// --- audio ------------------------------------------------------------------

export interface TranscodeAudioOptions extends FfmpegOpOptions {
  /** MP3 bit rate in kbit/s. Default 128. */
  bitrate?: number;
  /** Resample, for example 16000 for speech-to-text. */
  sampleRate?: number;
  /** 1 to mix down to mono. */
  channels?: number;
}

/**
 * Converts audio (or the audio track of a video) to MP3 or 16-bit WAV. This is
 * how headerless PCM from a PCM-only TTS model becomes an MP3: wrap it with
 * `pcmToWav` first, then transcode.
 */
export function transcodeAudio(
  blob: Blob,
  format: 'mp3' | 'wav',
  options: TranscodeAudioOptions = {},
): Promise<Blob> {
  return withFfmpeg(options, async (job) => {
    const input = await job.write(blob, 'in', (await describeInput(blob)).extension);
    const output = job.name('out', format);
    const codec =
      format === 'mp3'
        ? ['-c:a', 'libmp3lame', '-b:a', `${options.bitrate ?? 128}k`]
        : ['-c:a', 'pcm_s16le'];
    await job.run(
      [
        '-i',
        input,
        '-vn',
        '-map_metadata',
        '-1',
        ...(options.sampleRate ? ['-ar', String(options.sampleRate)] : []),
        ...(options.channels ? ['-ac', String(options.channels)] : []),
        ...codec,
        output,
      ],
      (_time, ratio) => options.onProgress?.(ratio),
    );
    options.onProgress?.(1);
    return job.read(output, format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
  });
}

// --- trim -------------------------------------------------------------------

export interface TrimOptions extends FfmpegOpOptions {
  /**
   * What the file is, when the caller knows: `'video'` or `'audio'`. Without it
   * the streams decide: sound only (also in an MP4 or WebM, whose container
   * says "video") means audio, and a file that has a video stream is video.
   */
  kind?: 'audio' | 'video';
}

/** Even width and height: H.264 in yuv420p cannot carry odd sizes. Adds at most one black pixel row and column. */
const EVEN_SIZE_FILTER = 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:black';

/**
 * Cuts `[start, end)` seconds out of a media file (`end` omitted: to the
 * end), frame-accurately. Video becomes an H.264/AAC MP4 (odd dimensions are
 * padded to even ones, as in `concatVideos`); audio stays MP3 as MP3 and
 * anything else becomes WAV. Which of the two a file is comes from
 * `options.kind` or from its streams (see `TrimOptions`). Always re-encodes,
 * so it takes about as long as the clip is.
 */
export function trimMedia(
  blob: Blob,
  start: number,
  end: number | undefined,
  options: TrimOptions = {},
): Promise<Blob> {
  if (!(start >= 0)) throw new RangeError('start must be 0 or more.');
  if (end !== undefined && !(end > start)) throw new RangeError('end must be after start.');
  return withFfmpeg(options, async (job) => {
    const { type, extension } = await describeInput(blob);
    const input = await job.write(blob, 'in', extension);
    // A sniffed audio type is trusted; a video container (or an unknown one) is checked for a video stream.
    let kind = options.kind;
    if (!kind) {
      kind = type.startsWith('audio/')
        ? 'audio'
        : parseMediaInfo(await job.capture(['-i', input])).video
          ? 'video'
          : 'audio';
    }
    const isVideo = kind === 'video';
    const format = isVideo ? 'mp4' : type === 'audio/mpeg' ? 'mp3' : 'wav';
    const output = job.name('out', format);
    const codec = isVideo
      ? [
          '-vf',
          EVEN_SIZE_FILTER,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '160k',
          '-movflags',
          '+faststart',
        ]
      : format === 'mp3'
        ? ['-c:a', 'libmp3lame', '-b:a', '128k']
        : ['-c:a', 'pcm_s16le'];
    await job.run(
      [
        ...(isVideo ? job.threads.filter : []),
        ...(start > 0 ? ['-ss', seconds(start)] : []),
        ...(end !== undefined ? ['-t', seconds(end - start)] : []),
        ...(isVideo ? job.threads.decode : []),
        '-i',
        input,
        ...(isVideo ? [] : ['-vn']),
        ...codec,
        ...(isVideo ? job.threads.encode : []),
        output,
      ],
      (time, ratio) => {
        options.onProgress?.(end !== undefined ? Math.min(1, time / (end - start)) : ratio);
      },
    );
    options.onProgress?.(1);
    return job.read(output, isVideo ? 'video/mp4' : format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
  });
}

// --- join video clips -------------------------------------------------------

export interface ConcatClip {
  blob: Blob;
  /** Seconds to cut from the start of this clip. */
  trimStart?: number;
  /** Seconds to cut from the end of this clip. */
  trimEnd?: number;
  /** Remove the first frame: for chained clips, whose first frame repeats the previous clip's last. */
  dropFirstFrame?: boolean;
}

export interface ConcatOptions extends FfmpegOpOptions {
  /** Re-encode even if the clips would allow a lossless join. */
  reencode?: boolean;
}

/** Settings of the re-encode path; every clip goes through the same ones, so the joined streams match exactly. */
const ENCODE_VIDEO = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
];
const ENCODE_AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2'];

/** Even, positive size (H.264 with yuv420p needs even dimensions). */
const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/**
 * Joins clips, in order, into one MP4.
 *
 * - **Stream copy** (fast, lossless) when no clip is trimmed, every clip is
 *   H.264 (+ AAC or no audio) and all share the same codec parameters, size,
 *   frame rate and audio format. Clips from one video model normally do.
 * - **Re-encode** otherwise (and always when a clip has `trimStart`, `trimEnd`
 *   or `dropFirstFrame`, because a cut inside a GOP needs new frames): each
 *   clip is converted on its own to the first clip's size and frame rate
 *   (letterboxed if the shape differs) as H.264/AAC 44.1 kHz stereo, with
 *   silence added to clips that have no sound when others do; then the
 *   results are stream-copied together. One clip in memory at a time keeps
 *   long sequences inside the wasm heap.
 *
 * Re-encoding costs roughly the length of the footage in processing time on
 * the single-threaded core. Joins can leave a click of a few milliseconds at
 * seams in the audio.
 */
export function concatVideos(clips: ConcatClip[], options: ConcatOptions = {}): Promise<Blob> {
  if (clips.length === 0) throw new RangeError('Nothing to join.');
  return withFfmpeg(options, async (job) => {
    // 1. Load and probe every clip.
    const sources: { name: string; info: MediaInfo }[] = [];
    for (const [index, clip] of clips.entries()) {
      const name = await job.write(
        clip.blob,
        `c${index}`,
        (await describeInput(clip.blob)).extension,
      );
      const info = parseMediaInfo(await job.capture(['-i', name]));
      if (!info.video) throw new InvalidInputError(`Clip ${index + 1} has no video.`);
      sources.push({ name, info });
    }

    const trimmed = clips.some(
      (clip) => (clip.trimStart ?? 0) > 0 || (clip.trimEnd ?? 0) > 0 || clip.dropFirstFrame,
    );
    const first = sources[0]?.info;
    const matching =
      first !== undefined && sources.every(({ info }) => info.signature === first.signature);
    const copyable = sources.every(
      ({ info }) => info.video?.codec === 'h264' && (!info.audio || info.audio.codec === 'aac'),
    );

    if (!options.reencode && !trimmed && matching && copyable) {
      const total = sources.reduce((sum, { info }) => sum + info.duration, 0);
      const list = job.name('list', 'txt');
      await job.ffmpeg.writeFile(list, sources.map(({ name }) => `file '${name}'`).join('\n'));
      const output = job.name('out', 'mp4');
      await job.run(
        ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output],
        (time, ratio) => options.onProgress?.(total > 0 ? Math.min(1, time / total) : ratio),
      );
      options.onProgress?.(1);
      return job.read(output, 'video/mp4');
    }

    // 2. Re-encode every clip to one common format.
    const reference = first?.video;
    if (!reference) throw new InvalidInputError('Clip 1 has no video.');
    const width = even(reference.rotation % 180 !== 0 ? reference.height : reference.width);
    const height = even(reference.rotation % 180 !== 0 ? reference.width : reference.height);
    const fps = Math.min(60, Math.max(1, reference.fps || 24));
    const withAudio = sources.some(({ info }) => info.audio);
    const filter = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      `fps=${fps}`,
      'format=yuv420p',
    ].join(',');

    const plans = clips.map((clip, index) => {
      const info = sources[index]?.info;
      const clipFps = info?.video?.fps || fps;
      // 0.75 of a frame lands between the first and second frame, whatever the rounding.
      const start = (clip.trimStart ?? 0) + (clip.dropFirstFrame ? 0.75 / clipFps : 0);
      const length = (info?.duration ?? 0) - start - (clip.trimEnd ?? 0);
      return { start, length };
    });
    for (const [index, { length }] of plans.entries()) {
      if (sources[index] && sources[index].info.duration > 0 && length <= 0.01) {
        throw new InvalidInputError(`Nothing is left of clip ${index + 1} after trimming.`);
      }
    }
    const lengths = plans.map(({ length }, index) =>
      length > 0 ? length : (sources[index]?.info.duration ?? 0),
    );
    const total = lengths.reduce((sum, value) => sum + value, 0) || 1;

    const encoded: string[] = [];
    let done = 0;
    for (const [index, source] of sources.entries()) {
      const plan = plans[index];
      const length = lengths[index] ?? 0;
      if (!plan) continue;
      const output = job.name(`n${index}`, 'mp4');
      const needsSilence = withAudio && !source.info.audio;
      const args = [
        ...job.threads.filter,
        ...(plan.start > 0 ? ['-ss', seconds(plan.start)] : []),
        ...(length > 0 ? ['-t', seconds(length)] : []),
        ...job.threads.decode,
        '-i',
        source.name,
        ...(needsSilence
          ? [
              '-f',
              'lavfi',
              '-t',
              seconds(length > 0 ? length : 1),
              '-i',
              'anullsrc=channel_layout=stereo:sample_rate=44100',
            ]
          : []),
        '-map',
        '0:v:0',
        ...(withAudio ? ['-map', needsSilence ? '1:a:0' : '0:a:0'] : []),
        '-vf',
        filter,
        ...ENCODE_VIDEO,
        ...job.threads.encode,
        ...(withAudio ? ENCODE_AUDIO : ['-an']),
        '-movflags',
        '+faststart',
        output,
      ];
      await job.run(args, (time) => {
        const within = length > 0 ? Math.min(1, time / length) : 0;
        options.onProgress?.(Math.min(0.97, ((done + within * length) / total) * 0.97));
      });
      done += length;
      encoded.push(output);
      // Free the source before the next clip is loaded into the wasm heap.
      await job.remove(source.name);
    }

    // 3. The clips now share every parameter: join them without another encode.
    const list = job.name('list', 'txt');
    await job.ffmpeg.writeFile(list, encoded.map((name) => `file '${name}'`).join('\n'));
    const output = job.name('out', 'mp4');
    await job.run([
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ]);
    options.onProgress?.(1);
    return job.read(output, 'video/mp4');
  });
}
