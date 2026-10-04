// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { transcode } from './transcode';

const ffmpeg = vi.hoisted(() => ({
  /** How often the mocked ffmpeg-ops module was evaluated: 0 until something imports it. */
  loaded: 0,
  transcodeAudio: vi.fn<(blob: Blob, format: string, options?: unknown) => Promise<Blob>>(
    (_blob, format) =>
      Promise.resolve(new Blob([format], { type: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' })),
  ),
}));

vi.mock('./ffmpeg-ops', () => {
  ffmpeg.loaded++;
  return { transcodeAudio: ffmpeg.transcodeAudio };
});

describe('transcode', () => {
  it('loads ffmpeg-ops only when a conversion runs, and passes everything through', async () => {
    expect(ffmpeg.loaded).toBe(0);
    const blob = new Blob(['song'], { type: 'audio/mpeg' });
    const signal = new AbortController().signal;
    const onProgress = (): void => undefined;

    const out = await transcode(blob, 'wav', {
      sampleRate: 16000,
      channels: 1,
      signal,
      onProgress,
    });

    expect(ffmpeg.loaded).toBe(1);
    expect(ffmpeg.transcodeAudio).toHaveBeenCalledWith(blob, 'wav', {
      sampleRate: 16000,
      channels: 1,
      signal,
      onProgress,
    });
    expect(out.type).toBe('audio/wav');

    await transcode(blob, 'mp3');
    expect(ffmpeg.transcodeAudio).toHaveBeenLastCalledWith(blob, 'mp3', {});
    expect(ffmpeg.loaded).toBe(1);
  });

  it('rejects with what ffmpeg rejects with', async () => {
    ffmpeg.transcodeAudio.mockRejectedValueOnce(new Error('broken input'));
    await expect(transcode(new Blob(['x']), 'mp3')).rejects.toThrow('broken input');
  });
});
