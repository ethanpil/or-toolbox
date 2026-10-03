// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  concatWav,
  encodeWav,
  parseWav,
  pcmToWav,
  WAV_HEADER_BYTES,
  wavDuration,
  wavHeader,
} from './wav';

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());
const text = (bytes: Uint8Array, at: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + length));

describe('wavHeader', () => {
  it('writes a canonical 44-byte PCM header', () => {
    const header = wavHeader(4, 16000, 1);
    const view = new DataView(header.buffer);
    expect(header.length).toBe(WAV_HEADER_BYTES);
    expect(text(header, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(40); // 36 + data bytes
    expect(text(header, 8, 8)).toBe('WAVEfmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(text(header, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(4);
  });

  it('computes byte rate and block align for stereo', () => {
    const view = new DataView(wavHeader(0, 44100, 2).buffer);
    expect(view.getUint32(28, true)).toBe(176400);
    expect(view.getUint16(32, true)).toBe(4);
  });

  it('rejects impossible formats and sizes', () => {
    expect(() => wavHeader(0, 0, 1)).toThrow(/sample rate/);
    expect(() => wavHeader(0, 16000, 0)).toThrow(/channel/);
    expect(() => wavHeader(0xffffffff, 16000, 1)).toThrow(/too long/);
  });
});

describe('encodeWav', () => {
  it('converts float samples to 16-bit, clipping out-of-range values', async () => {
    const bytes = await bytesOf(encodeWav([new Float32Array([0, 1, -1, 0.5, 2, -2])], 8000));
    const pcm = new Int16Array(bytes.slice(WAV_HEADER_BYTES).buffer);
    expect([...pcm]).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(12);
  });

  it('interleaves channels', async () => {
    const blob = encodeWav([new Float32Array([1, 0]), new Float32Array([-1, 0.5])], 44100);
    expect(blob.type).toBe('audio/wav');
    const bytes = await bytesOf(blob);
    const pcm = new Int16Array(bytes.slice(WAV_HEADER_BYTES).buffer);
    expect([...pcm]).toEqual([32767, -32768, 0, 16384]);
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(2);
  });

  it('rejects no channels and channels of different lengths', () => {
    expect(() => encodeWav([], 8000)).toThrow(/at least one/);
    expect(() => encodeWav([new Float32Array(2), new Float32Array(3)], 8000)).toThrow(
      /same length/,
    );
  });
});

describe('pcmToWav', () => {
  it('wraps raw PCM and drops a trailing partial sample', async () => {
    const pcm = new Uint8Array([1, 0, 2, 0, 3, 0, 9]); // three samples and one stray byte
    const bytes = await bytesOf(pcmToWav(pcm, 24000, 1));
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 6);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint32(40, true)).toBe(6);
    expect([...bytes.slice(WAV_HEADER_BYTES)]).toEqual([1, 0, 2, 0, 3, 0]);
  });

  it('drops incomplete stereo frames', async () => {
    const bytes = await bytesOf(pcmToWav(new Uint8Array(10), 44100, 2));
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 8);
  });
});

describe('parseWav', () => {
  it('reads the format and length', async () => {
    const blob = encodeWav([new Float32Array(16000)], 16000);
    const info = parseWav(await bytesOf(blob));
    expect(info).toMatchObject({
      audioFormat: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 32000,
    });
    expect(info.duration).toBe(1);
    expect(await wavDuration(blob)).toBe(1);
  });

  it('skips chunks between fmt and data', async () => {
    const wav = await bytesOf(encodeWav([new Float32Array(4)], 8000));
    // Insert a 6-byte LIST chunk (even size, so no padding byte) before `data`.
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 6, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
    const joined = new Uint8Array(wav.length + list.length);
    joined.set(wav.subarray(0, 36), 0);
    joined.set(list, 36);
    joined.set(wav.subarray(36), 36 + list.length);
    const info = parseWav(joined);
    expect(info.dataOffset).toBe(44 + list.length);
    expect(info.dataBytes).toBe(8);
  });

  it('treats a streamed header (size 0) as running to the end of the file', async () => {
    const bytes = await bytesOf(encodeWav([new Float32Array(100)], 8000));
    new DataView(bytes.buffer).setUint32(40, 0, true);
    expect(parseWav(bytes).dataBytes).toBe(200);
  });

  it('rejects other files', () => {
    expect(() => parseWav(new Uint8Array(64))).toThrow(/not a WAV/i);
  });
});

/**
 * A 16-bit WAV whose `data` chunk follows `junk` bytes of a LIST chunk, and holds `dataBytes`
 * bytes (the RIFF size field is left as the plain header wrote it; readers must not depend on it).
 */
function wavAfterJunk(junk: number, dataBytes: number, channels = 1, rate = 8000): Blob {
  const header = wavHeader(dataBytes, rate, channels);
  const list = new Uint8Array(8 + junk + (junk % 2));
  list.set([0x4c, 0x49, 0x53, 0x54]);
  new DataView(list.buffer).setUint32(4, junk, true);
  return new Blob([
    header.subarray(0, 36),
    list,
    header.subarray(36, 44),
    new Uint8Array(dataBytes),
  ]);
}

describe('WAV files with large chunks before the audio', () => {
  it('finds the data chunk however far into the file it is', async () => {
    for (const junk of [0, 5, 1000, 70_000, 300_001]) {
      const blob = wavAfterJunk(junk, 16_000);
      expect(await wavDuration(blob), `${junk} bytes of LIST`).toBe(1);
    }
  });

  it('joins files like that, copying only their audio', async () => {
    const joined = await concatWav([wavAfterJunk(70_000, 1000), wavAfterJunk(3, 600)]);
    const bytes = await bytesOf(joined);
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 1600);
    expect(parseWav(bytes).dataBytes).toBe(1600);
  });

  it('reports a file with no data chunk as unreadable', async () => {
    const header = wavHeader(0, 8000, 1);
    await expect(wavDuration(new Blob([header.subarray(0, 36)]))).rejects.toThrow(/no audio data/);
    await expect(wavDuration(new Blob([new Uint8Array(100)]))).rejects.toThrow(/not a WAV/i);
  });
});

describe('WAV data is counted in whole frames', () => {
  it('rounds the length down in parseWav and wavDuration', async () => {
    const mono = wavAfterJunk(0, 7);
    expect(parseWav(await bytesOf(mono)).dataBytes).toBe(6);
    expect(await wavDuration(mono)).toBe(3 / 8000);
    const stereo = wavAfterJunk(0, 10, 2);
    expect(parseWav(await bytesOf(stereo)).dataBytes).toBe(8);
    expect(await wavDuration(stereo)).toBe(2 / 8000);
  });

  it('rounds streamed files (size 0) down too', async () => {
    const bytes = await bytesOf(wavAfterJunk(0, 9));
    new DataView(bytes.buffer).setUint32(40, 0, true);
    expect(parseWav(bytes).dataBytes).toBe(8);
  });

  it('concatenates whole frames only', async () => {
    const joined = await bytesOf(await concatWav([wavAfterJunk(0, 7), wavAfterJunk(0, 9)]));
    expect(parseWav(joined).dataBytes).toBe(6 + 8);
    expect(joined.length).toBe(WAV_HEADER_BYTES + 14);
    expect(new DataView(joined.buffer).getUint32(40, true)).toBe(14);
  });
});

describe('concatWav', () => {
  const tone = (samples: number, rate: number): Blob =>
    encodeWav([new Float32Array(samples).fill(0.25)], rate);

  it('joins files without copying their headers into the audio', async () => {
    const joined = await concatWav([tone(100, 16000), tone(200, 16000)]);
    const bytes = await bytesOf(joined);
    const info = parseWav(bytes);
    expect(info.dataBytes).toBe(600);
    expect(bytes.length).toBe(WAV_HEADER_BYTES + 600);
    expect(info.sampleRate).toBe(16000);
    const pcm = new Int16Array(bytes.slice(WAV_HEADER_BYTES).buffer);
    expect(new Set(pcm).size).toBe(1);
  });

  it('refuses files with different formats', async () => {
    await expect(concatWav([tone(10, 16000), tone(10, 24000)])).rejects.toThrow(/differ/);
    await expect(
      concatWav([tone(10, 16000), encodeWav([new Float32Array(10), new Float32Array(10)], 16000)]),
    ).rejects.toThrow(/differ/);
  });

  it('refuses an empty list', async () => {
    await expect(concatWav([])).rejects.toThrow(/no audio to join/);
  });
});
