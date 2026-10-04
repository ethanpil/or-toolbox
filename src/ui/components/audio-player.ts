/**
 * `audioPlayer()`: the browser's own audio controls (fully keyboard and screen-reader accessible) with a
 * waveform drawn above them from `peaks` (src/core/media/audio.ts `peaks()`). Without `peaks`, a Blob under
 * 64 MB and 30 minutes (`seconds`, else measured) is decoded lazily (8 kHz, mono) to draw one. Clicking the
 * waveform seeks; the played part is drawn in the accent colour.
 *
 * A stream with no length in its header (a MediaRecorder WebM: `duration` is Infinity) cannot be seeked until
 * the browser has found its end, so the player probes it once (`resolveDuration`) when its metadata loads, and
 * a waveform click waits for that before seeking.
 */
import { resolveDuration } from '../../core/media/media-element';
import { h } from '../dom';

export interface AudioPlayerOptions {
  src?: string;
  blob?: Blob;
  /** Loudest absolute sample (0–1) per bucket; given, nothing is decoded for the waveform. */
  peaks?: Float32Array;
  /** Known length in seconds (from the recorder, the decoder, the model): given, the file is not measured. */
  seconds?: number;
  /** Accessible name, e.g. the file name. */
  label: string;
  testId?: string;
}

export interface AudioPlayer {
  readonly element: HTMLElement;
  readonly audio: HTMLAudioElement;
  /**
   * Moves playback to `seconds` once that can stick: after the metadata, and after the probe of a stream with no
   * length (its rewind to 0 would otherwise undo a seek made meanwhile). Use it instead of setting `currentTime`.
   */
  seek(seconds: number): Promise<void>;
  setPeaks(peaks: Float32Array): void;
  dispose(): void;
}

const MAX_DECODE_BYTES = 64 * 1024 * 1024;
/** Longer recordings get no waveform (the controls still work). */
const MAX_WAVEFORM_SECONDS = 30 * 60;
/** Enough for 240 bars, at a fraction of the memory of a full-rate decode. */
const WAVEFORM_SAMPLE_RATE = 8000;
const BUCKETS = 240;

export function audioPlayer(options: AudioPlayerOptions): AudioPlayer {
  const ownUrl = options.blob ? URL.createObjectURL(options.blob) : null;
  let peaks: Float32Array | null = options.peaks ?? null;
  const known = options.seconds !== undefined && options.seconds > 0 ? options.seconds : null;

  const audio = h('audio', {
    controls: true,
    preload: 'metadata',
    src: ownUrl ?? options.src ?? '',
    class: 'w-100',
    'aria-label': options.label,
  });
  const canvas = h('canvas', { class: 'or-waveform', 'aria-hidden': 'true', height: 64 });
  const element = h(
    'div',
    { class: 'or-audio', 'data-testid': options.testId ?? 'audio-player' },
    canvas,
    audio,
  );

  /** The length to draw and seek against: the element's once it knows it, else the caller's. */
  const length = (): number =>
    Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (known ?? 0);

  let probe: Promise<void> | null = null;
  /** Settles once the element knows its length: an Infinity one is probed (once). */
  const measured = (): Promise<void> => {
    if (audio.duration === Infinity) probe ??= resolveDuration(audio);
    return probe ?? Promise.resolve();
  };
  /** Settles once the metadata is in (or the element failed), so a probe that is due has started. */
  const metadata = (): Promise<void> =>
    audio.readyState >= HTMLMediaElement.HAVE_METADATA || audio.error
      ? Promise.resolve()
      : new Promise((resolve) => {
          const done = (): void => {
            audio.removeEventListener('loadedmetadata', done);
            audio.removeEventListener('error', done);
            resolve();
          };
          audio.addEventListener('loadedmetadata', done);
          audio.addEventListener('error', done);
        });

  const draw = (): void => {
    const context = canvas.getContext('2d');
    if (!context || !peaks) {
      canvas.hidden = !peaks;
      return;
    }
    canvas.hidden = false;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, canvas.clientWidth);
    const height = 64;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(document.documentElement);
    const played = styles.getPropertyValue('--bs-primary').trim() || '#4f46e5';
    const rest = styles.getPropertyValue('--bs-secondary-color').trim() || '#6c757d';
    const total = length();
    const progress = total > 0 ? audio.currentTime / total : 0;
    const bar = width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const value = Math.max(0.03, peaks[i] ?? 0);
      const barHeight = value * (height - 4);
      context.fillStyle = i / peaks.length < progress ? played : rest;
      context.fillRect(i * bar, (height - barHeight) / 2, Math.max(1, bar - 1), barHeight);
    }
  };

  canvas.addEventListener('click', (event) => {
    const box = canvas.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    void measured().then(() => {
      const total = length();
      if (total > 0 && Number.isFinite(ratio)) audio.currentTime = ratio * total;
    });
  });
  audio.addEventListener('timeupdate', draw);
  audio.addEventListener('loadedmetadata', () => {
    draw();
    void measured();
  });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  observer?.observe(canvas);

  if (!peaks && options.blob && options.blob.size <= MAX_DECODE_BYTES) {
    const blob = options.blob;
    // A waveform needs little detail: decode at a low rate, in mono, and skip it for long recordings (a full
    // decode of an hour of audio would hold hundreds of megabytes of samples).
    void import('../../core/media/audio')
      .then(async (media) => {
        const seconds = known ?? (await media.getAudioDuration(blob).catch(() => Number.NaN));
        if (!(seconds > 0) || seconds > MAX_WAVEFORM_SECONDS) return null;
        const decoded = await media.decodeAudio(blob, {
          sampleRate: WAVEFORM_SAMPLE_RATE,
          mono: true,
        });
        return media.peaks(decoded, BUCKETS);
      })
      .then((computed) => {
        if (!computed) return;
        peaks = computed;
        draw();
      })
      .catch(() => undefined); // no waveform; the controls still work
  }
  draw();

  return {
    element,
    audio,
    async seek(seconds) {
      await metadata();
      await measured();
      audio.currentTime = Math.max(0, seconds);
    },
    setPeaks(next) {
      peaks = next;
      draw();
    },
    dispose() {
      observer?.disconnect();
      audio.pause();
      if (ownUrl) URL.revokeObjectURL(ownUrl);
    },
  };
}
