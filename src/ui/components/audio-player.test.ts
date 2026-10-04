import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { audioPlayer } from './audio-player';

const media = vi.hoisted(() => ({
  getAudioDuration: vi.fn<(blob: Blob) => Promise<number>>(),
  decodeAudio: vi.fn(() => Promise.resolve({})),
  peaks: vi.fn(() => new Float32Array(240)),
}));
vi.mock('../../core/media/audio', () => media);

beforeAll(() => {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  // jsdom has no canvas; the waveform's drawing is not what is tested here.
  HTMLCanvasElement.prototype.getContext = () => null;
});
afterEach(() => vi.clearAllMocks());

const clip = (): Blob => new Blob([new Uint8Array(1024)], { type: 'audio/wav' });

describe('audioPlayer waveform', () => {
  it('decodes at a low sample rate, in mono', async () => {
    media.getAudioDuration.mockResolvedValue(90);
    audioPlayer({ blob: clip(), label: 'Clip' });
    await vi.waitFor(() => expect(media.peaks).toHaveBeenCalled());
    expect(media.decodeAudio).toHaveBeenCalledWith(expect.any(Blob), {
      sampleRate: 8000,
      mono: true,
    });
  });

  it('draws no waveform for recordings over 30 minutes, or of unknown length', async () => {
    media.getAudioDuration.mockResolvedValueOnce(31 * 60);
    audioPlayer({ blob: clip(), label: 'Long' });
    await vi.waitFor(() => expect(media.getAudioDuration).toHaveBeenCalledTimes(1));
    media.getAudioDuration.mockRejectedValueOnce(new Error('Unreadable'));
    audioPlayer({ blob: clip(), label: 'Broken' });
    await vi.waitFor(() => expect(media.getAudioDuration).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(media.decodeAudio).not.toHaveBeenCalled();
  });

  it('takes a known length instead of measuring the file', async () => {
    audioPlayer({ blob: clip(), label: 'Known', seconds: 90 });
    await vi.waitFor(() => expect(media.peaks).toHaveBeenCalled());
    expect(media.getAudioDuration).not.toHaveBeenCalled();

    audioPlayer({ blob: clip(), label: 'Known and long', seconds: 31 * 60 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(media.getAudioDuration).not.toHaveBeenCalled();
    expect(media.decodeAudio).toHaveBeenCalledTimes(1);
  });

  it('decodes nothing when peaks are given', async () => {
    audioPlayer({ blob: clip(), label: 'Drawn', peaks: new Float32Array(240) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(media.getAudioDuration).not.toHaveBeenCalled();
    expect(media.decodeAudio).not.toHaveBeenCalled();
  });
});

describe('audioPlayer seeking', () => {
  /**
   * The player's <audio> as a MediaRecorder WebM: `duration` is Infinity until something seeks past the end,
   * which is when the browser finds the real length (40 s here) and fires `durationchange`.
   */
  function recording(): { audio: HTMLAudioElement; canvas: HTMLCanvasElement; seeks: number[] } {
    const player = audioPlayer({ blob: clip(), label: 'Recording', peaks: new Float32Array(240) });
    const { audio } = player;
    const canvas = player.element.querySelector('canvas')!;
    canvas.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    const seeks: number[] = [];
    let duration = Infinity;
    let time = 0;
    Object.defineProperty(audio, 'duration', { configurable: true, get: () => duration });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => time,
      set: (value: number) => {
        seeks.push(value);
        time = value;
        if (value > 1e100) {
          duration = 40;
          time = 40;
          audio.dispatchEvent(new Event('durationchange'));
        }
      },
    });
    return { audio, canvas, seeks };
  }

  it('finds the length of a stream with none in its header once its metadata loads', async () => {
    const { audio, seeks } = recording();
    audio.dispatchEvent(new Event('loadedmetadata'));
    await vi.waitFor(() => expect(seeks).toEqual([1e101, 0]));
    expect(audio.duration).toBe(40);
  });

  it('finds the length before a waveform click seeks, then seeks within it', async () => {
    const { canvas, seeks } = recording();
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 50 }));
    await vi.waitFor(() => expect(seeks).toEqual([1e101, 0, 10]));
  });
});
