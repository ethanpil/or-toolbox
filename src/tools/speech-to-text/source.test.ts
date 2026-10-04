import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError } from '../../core/errors';
import type * as AudioModule from '../../core/media/audio';
import type { AudioData } from '../../core/media/audio';
import {
  type AudioSource,
  expectedParts,
  passthroughFormat,
  prepareParts,
  sentAsIs,
} from './source';

const { decodeAudio, transcodeAudio } = vi.hoisted(() => ({
  decodeAudio: vi.fn<(blob: Blob) => Promise<AudioData>>(),
  transcodeAudio: vi.fn<(blob: Blob, format: string, options: object) => Promise<Blob>>(),
}));

vi.mock('../../core/media/audio', async (importOriginal) => ({
  ...(await importOriginal<typeof AudioModule>()),
  decodeAudio: (blob: Blob) => decodeAudio(blob),
}));
vi.mock('../../core/media/ffmpeg-ops', () => ({
  transcodeAudio: (blob: Blob, format: string, options: object) =>
    transcodeAudio(blob, format, options),
}));

const source = (patch: Partial<AudioSource>): AudioSource => ({
  id: 's',
  name: 'talk.mp3',
  blob: new Blob(['x'], { type: 'audio/mpeg' }),
  kind: 'audio',
  mime: 'audio/mpeg',
  duration: 30,
  origin: 'file',
  ...patch,
});

/** `seconds` of a quiet tone at 16 kHz. */
const tone = (seconds: number): AudioData => ({
  sampleRate: 16000,
  channels: [Float32Array.from({ length: seconds * 16000 }, (_, i) => 0.2 * Math.sin(i / 5))],
});

const options = () => ({
  partSeconds: 60,
  signal: new AbortController().signal,
  onStatus: vi.fn(),
});

beforeEach(() => {
  decodeAudio.mockReset();
  transcodeAudio.mockReset();
});

describe('what is sent as it is', () => {
  it('takes short audio in a format the API reads, by sniffed type or extension', () => {
    expect(passthroughFormat(source({}))).toBe('mp3');
    expect(passthroughFormat(source({ mime: 'audio/webm' }))).toBe('webm');
    expect(passthroughFormat(source({ mime: null, name: 'a.FLAC' }))).toBe('flac');
    expect(passthroughFormat(source({ mime: null, name: 'a.amr' }))).toBeNull();
    expect(passthroughFormat(source({ kind: 'video', mime: 'video/mp4' }))).toBeNull();
    expect(sentAsIs(source({}), 60)).toBe(true);
    expect(sentAsIs(source({ duration: 61 }), 60)).toBe(false);
    expect(sentAsIs(source({ duration: null }), 60)).toBe(false);
    expect(expectedParts(source({ duration: 3600 }), 300)).toBe(13);
    expect(expectedParts(source({ duration: 20 }), 300)).toBe(1);
  });
});

describe('prepareParts', () => {
  it('sends short audio unchanged, without decoding', async () => {
    const input = source({});
    const parts = await prepareParts(input, options());
    expect(parts).toEqual([{ index: 0, start: 0, duration: 30, blob: input.blob, format: 'mp3' }]);
    expect(decodeAudio).not.toHaveBeenCalled();
  });

  it('decodes a video and cuts its sound into 16 kHz WAV parts', async () => {
    decodeAudio.mockResolvedValue(tone(150));
    const opts = options();
    const parts = await prepareParts(
      source({ kind: 'video', mime: 'video/mp4', duration: 150 }),
      opts,
    );
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.every((part) => part.format === 'wav' && part.duration <= 60)).toBe(true);
    expect(parts[0]!.blob.type).toBe('audio/wav');
    expect(parts.reduce((sum, part) => sum + part.duration, 0)).toBeCloseTo(150);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.start).toBeCloseTo(parts[i - 1]!.start + parts[i - 1]!.duration);
    }
    expect(opts.onStatus).toHaveBeenCalledWith('Reading the sound track of the video…');
  });

  it('extracts the audio with ffmpeg when the browser cannot decode it', async () => {
    const wav = new Blob(['wav'], { type: 'audio/wav' });
    decodeAudio
      .mockRejectedValueOnce(new InvalidInputError('This audio cannot be decoded.'))
      .mockResolvedValueOnce(tone(20));
    transcodeAudio.mockResolvedValue(wav);
    const input = source({ name: 'clip.mkv', mime: null, kind: 'video', duration: null });
    const parts = await prepareParts(input, options());
    expect(transcodeAudio).toHaveBeenCalledWith(
      input.blob,
      'wav',
      expect.objectContaining({ sampleRate: 16000, channels: 1 }),
    );
    expect(decodeAudio).toHaveBeenLastCalledWith(wav);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.duration).toBeCloseTo(20);
  });

  it('stops when the run is stopped, and refuses silence of no length', async () => {
    const controller = new AbortController();
    decodeAudio.mockImplementation(() => {
      controller.abort();
      return Promise.resolve(tone(90));
    });
    await expect(
      prepareParts(source({ duration: 90 }), { ...options(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    decodeAudio.mockResolvedValue({ sampleRate: 16000, channels: [new Float32Array(0)] });
    await expect(prepareParts(source({ duration: null }), options())).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});
