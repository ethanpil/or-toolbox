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
});
