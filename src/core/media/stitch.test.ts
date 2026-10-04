// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidInputError, isAbortError } from '../errors';
import type * as AudioModule from './audio';
import type { AudioData } from './audio';
import { stitchAudio } from './stitch';
import { encodeWav, parseWav } from './wav';

/** What the mocked decoder returns for each segment, keyed by the Blob it is given. */
const decoded = vi.hoisted(() => ({
  byBlob: new Map<Blob, AudioData>(),
  calls: [] as { blob: Blob; sampleRate: number | undefined }[],
}));

vi.mock('./audio', async (importOriginal) => ({
  ...(await importOriginal<typeof AudioModule>()),
  decodeAudio: (blob: Blob, options: { sampleRate?: number } = {}): Promise<AudioData> => {
    decoded.calls.push({ blob, sampleRate: options.sampleRate });
    const audio = decoded.byBlob.get(blob);
    return audio ? Promise.resolve(audio) : Promise.reject(new Error('unexpected blob'));
  },
}));

const transcode = vi.hoisted(() => ({
  calls: [] as { blob: Blob; format: string; options: unknown }[],
}));

vi.mock('./ffmpeg-ops', () => ({
  transcodeAudio: (blob: Blob, format: string, options: unknown): Promise<Blob> => {
    transcode.calls.push({ blob, format, options });
    return Promise.resolve(new Blob(['mp3 bytes'], { type: 'audio/mpeg' }));
  },
}));

/** A segment: a WAV Blob whose header matches `samples`, and what decoding it gives. */
function segment(rate: number, ...channels: number[][]): Blob {
  const data = channels.map((channel) => new Float32Array(channel));
  const blob = encodeWav(data, rate);
  decoded.byBlob.set(blob, { sampleRate: rate, channels: data });
  return blob;
}

async function samplesOf(blob: Blob): Promise<{ rate: number; channels: number; pcm: number[] }> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info = parseWav(bytes);
  return {
    rate: info.sampleRate,
    channels: info.channels,
    pcm: [...new Int16Array(bytes.slice(info.dataOffset, info.dataOffset + info.dataBytes).buffer)],
  };
}

beforeEach(() => {
  decoded.byBlob.clear();
  decoded.calls.length = 0;
  transcode.calls.length = 0;
});

describe('stitchAudio', () => {
  it('joins decoded segments sample for sample, with nothing added between them', async () => {
    const a = segment(24000, [0, 1, -1]);
    const b = segment(24000, [0.5, -0.5]);
    const out = await stitchAudio([a, b], 'wav');
    expect(out.type).toBe('audio/wav');
    expect(await samplesOf(out)).toEqual({
      rate: 24000,
      channels: 1,
      pcm: [0, 32767, -32768, 16384, -16384],
    });
  });

  it('decodes every segment at the first segment’s own sample rate', async () => {
    const a = segment(24000, [0.1]);
    const b = segment(44100, [0.1]);
    await stitchAudio([a, b], 'wav');
    expect(decoded.calls.map((call) => call.sampleRate)).toEqual([24000, 24000]);
  });

  it('writes stereo when any segment is stereo, repeating mono segments in both channels', async () => {
    const mono = segment(16000, [0.5, 0.25]);
    const stereo = segment(16000, [1, 0], [-1, 0]);
    const out = await samplesOf(await stitchAudio([mono, stereo], 'wav'));
    expect(out.channels).toBe(2);
    expect(out.pcm).toEqual([16384, 16384, 8192, 8192, 32767, -32768, 0, 0]);
  });

  it('mixes a stereo segment down when the output is mono', async () => {
    const mono = segment(16000, [0.5]);
    const stereo = segment(16000, [1, 1], [0, 0]);
    // The header of `stereo` says two channels, so the output is stereo...
    expect((await samplesOf(await stitchAudio([mono, stereo], 'wav'))).channels).toBe(2);
    // ...but a segment of an unknown format that decodes to stereo is mixed into a mono output.
    const unknown = new Blob(['not a wav or mp3']);
    decoded.byBlob.set(unknown, {
      sampleRate: 44100,
      channels: [new Float32Array([1]), new Float32Array([0])],
    });
    const out = await samplesOf(await stitchAudio([mono, unknown], 'wav'));
    expect(out.channels).toBe(1);
    expect(out.pcm).toEqual([16384, 16384]); // (1 + 0) / 2
  });

  it('encodes once to MP3 through ffmpeg, from the joined WAV', async () => {
    const a = segment(24000, [0, 1]);
    const b = segment(24000, [1, 0]);
    const out = await stitchAudio([a, b], 'mp3', { bitrate: 96 });
    expect(out.type).toBe('audio/mpeg');
    expect(transcode.calls).toHaveLength(1);
    const call = transcode.calls[0];
    expect(call?.format).toBe('mp3');
    expect(call?.options).toMatchObject({ bitrate: 96 });
    expect((await samplesOf(call?.blob as Blob)).pcm).toEqual([0, 32767, 32767, 0]);
  });

  it('returns a single segment already in the target format as it is: no decode, no ffmpeg', async () => {
    const wav = segment(24000, [0.5]);
    const progress: number[] = [];
    expect(await stitchAudio([wav], 'wav', { onProgress: (ratio) => progress.push(ratio) })).toBe(
      wav,
    );
    // An MPEG audio frame header (MPEG-1 Layer III), typed as MP3...
    const mp3 = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])], {
      type: 'audio/mpeg',
    });
    expect(await stitchAudio([mp3], 'mp3')).toBe(mp3);
    // ...and one with no type: same bytes, typed for the target.
    const untyped = new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0])]);
    const typed = await stitchAudio([untyped], 'mp3');
    expect(typed.type).toBe('audio/mpeg');
    expect(new Uint8Array(await typed.arrayBuffer())).toEqual(
      new Uint8Array(await untyped.arrayBuffer()),
    );
    expect(decoded.calls).toHaveLength(0);
    expect(transcode.calls).toHaveLength(0);
    expect(progress).toEqual([1]);
  });

  it('converts a single segment of another format the usual way', async () => {
    const only = segment(24000, [0.5]);
    await stitchAudio([only], 'mp3');
    expect(decoded.calls).toHaveLength(1);
    expect(transcode.calls).toHaveLength(1);
    expect((await samplesOf(transcode.calls[0]?.blob as Blob)).pcm).toEqual([16384]);
  });

  it('rejects an empty list as input error', async () => {
    await expect(stitchAudio([], 'wav')).rejects.toThrow(InvalidInputError);
  });

  it('stops between segments when aborted', async () => {
    const a = segment(24000, [0.5]);
    const b = segment(24000, [0.5]);
    const controller = new AbortController();
    controller.abort();
    await expect(stitchAudio([a, b], 'wav', { signal: controller.signal })).rejects.toSatisfy(
      isAbortError,
    );
    expect(decoded.calls).toHaveLength(0);
  });
});
