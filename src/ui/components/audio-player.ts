/**
 * `audioPlayer()`: the browser's own audio controls (fully keyboard and screen-reader accessible) with a
 * waveform drawn above them from `peaks` (src/core/media/audio.ts `peaks()`). Without `peaks`, a Blob under
 * 64 MB and 30 minutes is decoded lazily (8 kHz, mono) to draw one. Clicking the waveform seeks; the played
 * part is drawn in the accent colour.
 */
import { h } from '../dom';

export interface AudioPlayerOptions {
  src?: string;
  blob?: Blob;
  /** Loudest absolute sample (0–1) per bucket. */
  peaks?: Float32Array;
  /** Accessible name, e.g. the file name. */
  label: string;
  testId?: string;
}

export interface AudioPlayer {
  readonly element: HTMLElement;
  readonly audio: HTMLAudioElement;
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
    const progress = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    const bar = width / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const value = Math.max(0.03, peaks[i] ?? 0);
      const barHeight = value * (height - 4);
      context.fillStyle = i / peaks.length < progress ? played : rest;
      context.fillRect(i * bar, (height - barHeight) / 2, Math.max(1, bar - 1), barHeight);
    }
  };

  canvas.addEventListener('click', (event) => {
    if (!(audio.duration > 0)) return;
    const box = canvas.getBoundingClientRect();
    audio.currentTime = ((event.clientX - box.left) / box.width) * audio.duration;
  });
  audio.addEventListener('timeupdate', draw);
  audio.addEventListener('loadedmetadata', draw);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  observer?.observe(canvas);

  if (!peaks && options.blob && options.blob.size <= MAX_DECODE_BYTES) {
    const blob = options.blob;
    // A waveform needs little detail: decode at a low rate, in mono, and skip it for long recordings (a full
    // decode of an hour of audio would hold hundreds of megabytes of samples).
    void import('../../core/media/audio')
      .then(async (media) => {
        const seconds = await media.getAudioDuration(blob).catch(() => Number.NaN);
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
