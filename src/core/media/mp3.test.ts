// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { concatMp3, mp3Duration, parseFrameHeader, parseMp3, stripId3 } from './mp3';

const speech = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    readFileSync(new URL('../../../tests/fixtures/media/speech.mp3', import.meta.url)),
  );

const MPEG1_128K_44K_STEREO = [0xff, 0xfb, 0x90, 0x00]; // 417-byte frames, 1152 samples
const MPEG2_32K_24K_MONO = [0xff, 0xf3, 0x44, 0xc0]; // 96-byte frames, 576 samples

const join = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

function frame(
  header: number[],
  length: number,
  tag?: { at: number; text: string },
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length).fill(0x55);
  out.set(header, 0);
  if (tag)
    out.set(
      [...tag.text].map((char) => char.charCodeAt(0)),
      tag.at,
    );
  return out;
}

const frames = (header: number[], length: number, count: number): Uint8Array<ArrayBuffer> =>
  join(...Array.from({ length: count }, () => frame(header, length)));

/** An ID3v2 tag whose body is `size` bytes of padding. */
function id3v2(size: number, flags = 0): Uint8Array<ArrayBuffer> {
  const tag = new Uint8Array(10 + size + (flags & 0x10 ? 10 : 0));
  tag.set([
    0x49,
    0x44,
    0x33,
    3,
    0,
    flags,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
  return tag;
}

function id3v1(): Uint8Array<ArrayBuffer> {
  const tag = new Uint8Array(128);
  tag.set([0x54, 0x41, 0x47]);
  return tag;
}

describe('parseFrameHeader', () => {
  it('reads MPEG-1 Layer III', () => {
    expect(parseFrameHeader(new Uint8Array(MPEG1_128K_44K_STEREO), 0)).toMatchObject({
      version: 'MPEG1',
      layer: 3,
      sampleRate: 44100,
      channels: 2,
      bitrateKbps: 128,
      samples: 1152,
      length: 417,
    });
    expect(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x92, 0x00]), 0)?.length).toBe(418); // padding bit
  });

  it('reads MPEG-2 Layer III mono', () => {
    expect(parseFrameHeader(new Uint8Array(MPEG2_32K_24K_MONO), 0)).toMatchObject({
      version: 'MPEG2',
      layer: 3,
      sampleRate: 24000,
      channels: 1,
      bitrateKbps: 32,
      samples: 576,
      length: 96,
    });
  });

  it('rejects invalid headers', () => {
    const header = (...values: number[]): Uint8Array => new Uint8Array(values);
    expect(parseFrameHeader(header(0x12, 0xfb, 0x90, 0x00), 0)).toBeNull(); // no sync
    expect(parseFrameHeader(header(0xff, 0xeb, 0x90, 0x00), 0)).toBeNull(); // reserved version
    expect(parseFrameHeader(header(0xff, 0xf9, 0x90, 0x00), 0)).toBeNull(); // reserved layer (ADTS)
    expect(parseFrameHeader(header(0xff, 0xfb, 0xf0, 0x00), 0)).toBeNull(); // bad bit rate
    expect(parseFrameHeader(header(0xff, 0xfb, 0x00, 0x00), 0)).toBeNull(); // free format
    expect(parseFrameHeader(header(0xff, 0xfb, 0x9c, 0x00), 0)).toBeNull(); // bad sample rate
    expect(parseFrameHeader(header(0xff, 0xfb), 0)).toBeNull(); // too short
  });
});

describe('stripId3', () => {
  it('removes an ID3v2 tag, several tags, and a footer', () => {
    const audio = frames(MPEG1_128K_44K_STEREO, 417, 2);
    expect(stripId3(join(id3v2(300), audio))).toEqual(audio);
    expect(stripId3(join(id3v2(30), id3v2(70), audio))).toEqual(audio);
    expect(stripId3(join(id3v2(40, 0x10), audio))).toEqual(audio);
  });

  it('removes an ID3v1 tag from the end only', () => {
    const audio = frames(MPEG1_128K_44K_STEREO, 417, 2);
    expect(stripId3(join(audio, id3v1()))).toEqual(audio);
    const trailing = join(audio, id3v1(), new Uint8Array(3));
    expect(stripId3(trailing)).toEqual(trailing);
  });

  it('returns a view, not a copy, and leaves untagged data alone', () => {
    const audio = frames(MPEG1_128K_44K_STEREO, 417, 1);
    expect(stripId3(audio)).toEqual(audio);
    const tagged = join(id3v2(10), audio);
    expect(stripId3(tagged).buffer).toBe(tagged.buffer);
    expect(stripId3(new Uint8Array(0))).toEqual(new Uint8Array(0));
  });
});

describe('parseMp3', () => {
  it('finds the frames and totals the duration', () => {
    const audio = frames(MPEG1_128K_44K_STEREO, 417, 10);
    const { info, audio: found } = parseMp3(join(id3v2(100), new Uint8Array(6), audio, id3v1()));
    expect(found).toEqual(audio);
    expect(info).toMatchObject({
      version: 'MPEG1',
      layer: 3,
      sampleRate: 44100,
      channels: 2,
      bitrateKbps: 128,
      frames: 10,
      samplesPerFrame: 1152,
    });
    expect(info.duration).toBeCloseTo((10 * 1152) / 44100, 9);
  });

  it.each(['Xing', 'Info', 'VBRI'])('skips a %s header frame', (tag) => {
    const header = frame(MPEG1_128K_44K_STEREO, 417, { at: 36, text: tag });
    const audio = frames(MPEG1_128K_44K_STEREO, 417, 4);
    const { info, audio: found } = parseMp3(join(header, audio));
    expect(info.frames).toBe(4);
    expect(found).toEqual(audio);
  });

  it('skips junk between frames and drops a truncated last frame', () => {
    const five = frames(MPEG1_128K_44K_STEREO, 417, 5);
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const partial = frame(MPEG1_128K_44K_STEREO, 417).subarray(0, 200);
    const { info, audio } = parseMp3(join(five, junk, five, partial));
    expect(info.frames).toBe(10);
    expect(audio).toEqual(join(five, five));
  });

  it('ignores a stray header that is not followed by a frame', () => {
    const real = frames(MPEG2_32K_24K_MONO, 96, 20);
    const stray = new Uint8Array([...MPEG1_128K_44K_STEREO, 0x11]);
    const { info, audio } = parseMp3(join(id3v2(20), stray, real));
    expect(info.sampleRate).toBe(24000);
    expect(audio).toEqual(real);
  });

  it('throws when there is no audio', () => {
    expect(() => parseMp3(new Uint8Array(500))).toThrow(/No MP3 audio/);
    expect(() => parseMp3(join(id3v2(100)))).toThrow(/No MP3 audio/);
  });

  it('reads the recorded TTS file (ID3v2 tag, Info frame, 24 kHz mono)', () => {
    const file = speech();
    const { info, audio } = parseMp3(file);
    expect(info).toMatchObject({ version: 'MPEG2', layer: 3, sampleRate: 24000, channels: 1 });
    expect(info.duration).toBeGreaterThan(3.1);
    expect(info.duration).toBeLessThan(3.4);
    expect(audio[0]).toBe(0xff);
    expect(audio.length).toBeLessThan(file.length);
    // Parsing the result again finds the same audio: nothing but frames is left.
    const again = parseMp3(audio);
    expect(again.info.frames).toBe(info.frames);
    expect(again.audio.length).toBe(audio.length);
  });

  it('copes with tags, padding and junk around the recorded file', () => {
    const clean = parseMp3(speech()).audio;
    const noisy = join(
      id3v2(20),
      new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11]),
      clean,
      id3v1(),
      new Uint8Array([1, 2, 3]),
    );
    const parsed = parseMp3(noisy);
    expect(parsed.audio).toEqual(clean);
  });
});

describe('concatMp3', () => {
  it('joins TTS segments into one tag-free stream', async () => {
    const one = parseMp3(speech());
    const joined = await concatMp3([new Blob([speech()]), new Blob([speech()])]);
    expect(joined.type).toBe('audio/mpeg');
    const bytes = new Uint8Array(await joined.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    const parsed = parseMp3(bytes);
    expect(parsed.info.frames).toBe(one.info.frames * 2);
    expect(parsed.audio.length).toBe(one.audio.length * 2);
    expect(parsed.info.duration).toBeCloseTo(one.info.duration * 2, 6);
  });

  it('refuses segments encoded differently', async () => {
    const a = new Blob([frames(MPEG1_128K_44K_STEREO, 417, 5)]);
    const b = new Blob([frames(MPEG2_32K_24K_MONO, 96, 5)]);
    await expect(concatMp3([a, b])).rejects.toThrow(/encoded differently/);
  });

  it('refuses an empty list and a segment without audio', async () => {
    await expect(concatMp3([])).rejects.toThrow(/Nothing/);
    await expect(concatMp3([new Blob([new Uint8Array(100)])])).rejects.toThrow(/No MP3 audio/);
  });

  it('measures a Blob exactly', async () => {
    expect(await mp3Duration(new Blob([speech()]))).toBeCloseTo(
      parseMp3(speech()).info.duration,
      9,
    );
  });
});
