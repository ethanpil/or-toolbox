/**
 * MP3 files: finding the audio frames, stripping tags, and joining files.
 *
 * Text-to-speech returns long text as several MP3 segments of one encoding;
 * joining them is a matter of cutting every file down to its MPEG frames and
 * appending those. Lyria's songs start with an ID3v2 tag (about 6 KB, holding
 * a C2PA manifest) that must not end up in the middle of a joined file.
 *
 * Pure byte handling, no DOM, so it is unit-tested in Node. Not handled:
 * free-format streams (bitrate index 0) and MPEG audio inside other containers.
 *
 * A joined file keeps the encoder delay and padding of each segment (tens of
 * milliseconds of near-silence at every seam) and carries no Xing header, so
 * players estimate its length from the bitrate: exact for constant-bitrate
 * files such as TTS output. Use `mp3Duration` for the true length.
 */

export type MpegVersion = 'MPEG1' | 'MPEG2' | 'MPEG2.5';

export interface Mp3Info {
  version: MpegVersion;
  /** 1, 2 or 3. */
  layer: 1 | 2 | 3;
  sampleRate: number;
  channels: 1 | 2;
  /** Average over all frames, in kbit/s. */
  bitrateKbps: number;
  frames: number;
  samplesPerFrame: number;
  /** Seconds, summed over the frames (not estimated). */
  duration: number;
}

export interface ParsedMp3 {
  info: Mp3Info;
  /** The MPEG frames only: no ID3 tags, no Xing/Info/VBRI header frame, no trailing junk. */
  audio: Uint8Array<ArrayBuffer>;
}

export interface FrameHeader {
  version: MpegVersion;
  layer: 1 | 2 | 3;
  sampleRate: number;
  channels: 1 | 2;
  bitrateKbps: number;
  samples: number;
  /** Bytes, header included. */
  length: number;
  /** True when a 16-bit CRC follows the header. */
  crc: boolean;
}

// Bit rates in kbit/s by table: [MPEG1 L1, MPEG1 L2, MPEG1 L3, MPEG2 L1, MPEG2 L2/L3].
const BITRATES: number[][] = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const SAMPLE_RATES: Record<MpegVersion, number[]> = {
  MPEG1: [44100, 48000, 32000],
  MPEG2: [22050, 24000, 16000],
  'MPEG2.5': [11025, 12000, 8000],
};

/** Reads the 4-byte MPEG audio frame header at `offset`, or `null` if it is not a valid one. */
export function parseFrameHeader(bytes: Uint8Array, offset: number): FrameHeader | null {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b0 !== 0xff || b1 === undefined || b2 === undefined || b3 === undefined) return null;
  if ((b1 & 0xe0) !== 0xe0) return null;

  const versionBits = (b1 >> 3) & 3;
  const layerBits = (b1 >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version: MpegVersion =
    versionBits === 3 ? 'MPEG1' : versionBits === 2 ? 'MPEG2' : 'MPEG2.5';
  const layer = (4 - layerBits) as 1 | 2 | 3;

  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const table = version === 'MPEG1' ? layer - 1 : layer === 1 ? 3 : 4;
  const bitrateKbps = BITRATES[table]?.[bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][rateIndex];
  if (bitrateKbps === undefined || sampleRate === undefined) return null;

  const padding = (b2 >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 2 || version === 'MPEG1' ? 1152 : 576;
  const length =
    layer === 1
      ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + padding) * 4
      : Math.floor(((samples / 8) * bitrateKbps * 1000) / sampleRate) + padding;
  return {
    version,
    layer,
    sampleRate,
    channels: b3 >> 6 === 3 ? 1 : 2,
    bitrateKbps,
    samples,
    length,
    crc: (b1 & 1) === 0,
  };
}

/** Length of one ID3v2 tag starting at `offset`, or 0 if there is none. */
function id3v2Length(bytes: Uint8Array, offset: number): number {
  if (
    bytes[offset] !== 0x49 ||
    bytes[offset + 1] !== 0x44 ||
    bytes[offset + 2] !== 0x33 ||
    bytes.length < offset + 10
  ) {
    return 0;
  }
  const size =
    ((bytes[offset + 6] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[offset + 7] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[offset + 8] ?? 0) & 0x7f) * 0x80 +
    ((bytes[offset + 9] ?? 0) & 0x7f);
  const footer = ((bytes[offset + 5] ?? 0) & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/**
 * Removes ID3 tags: any ID3v2 tags at the start and an ID3v1 tag (the last 128
 * bytes, starting `TAG`) at the end. Returns a view of the same memory.
 */
export function stripId3<T extends Uint8Array>(bytes: T): T {
  let start = 0;
  for (let length = id3v2Length(bytes, start); length > 0; length = id3v2Length(bytes, start)) {
    start = Math.min(bytes.length, start + length);
  }
  let end = bytes.length;
  if (
    end - start >= 128 &&
    bytes[end - 128] === 0x54 &&
    bytes[end - 127] === 0x41 &&
    bytes[end - 126] === 0x47
  ) {
    end -= 128;
  }
  return bytes.subarray(start, end) as T;
}

/** True if the frame at `offset` is a Xing/Info (LAME) or VBRI header frame rather than audio. */
function isInfoFrame(bytes: Uint8Array, offset: number, frame: FrameHeader): boolean {
  const limit = Math.min(offset + frame.length, offset + 4 + 2 + 32 + 4);
  for (let i = offset + 4; i + 4 <= limit; i++) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const d = bytes[i + 3];
    if (
      (a === 0x58 && b === 0x69 && c === 0x6e && d === 0x67) || // Xing
      (a === 0x49 && b === 0x6e && c === 0x66 && d === 0x6f) || // Info
      (a === 0x56 && b === 0x42 && c === 0x52 && d === 0x49) // VBRI
    ) {
      return true;
    }
  }
  return false;
}

/** A frame is trusted when the next frame (or the end of the data) follows right after it, with the same stream parameters. */
function followedByFrame(bytes: Uint8Array, offset: number, frame: FrameHeader): boolean {
  const next = offset + frame.length;
  if (next === bytes.length) return true;
  const following = parseFrameHeader(bytes, next);
  return (
    following !== null &&
    following.version === frame.version &&
    following.layer === frame.layer &&
    following.sampleRate === frame.sampleRate
  );
}

/**
 * Finds the MPEG frames in an MP3 file, skipping tags, a Xing/Info/VBRI header
 * frame and any junk between or after frames. Throws if no audio is found.
 */
export function parseMp3(file: Uint8Array<ArrayBuffer>): ParsedMp3 {
  const bytes = stripId3(file);
  const ranges: [number, number][] = [];
  let first: FrameHeader | undefined;
  let frames = 0;
  let samples = 0;
  let bitrateSum = 0;

  let offset = 0;
  // Where the last accepted frame ended: a frame that starts right there needs no further proof.
  let contiguousAt = -1;
  while (offset + 4 <= bytes.length) {
    const frame = parseFrameHeader(bytes, offset);
    const valid =
      frame !== null &&
      offset + frame.length <= bytes.length &&
      (first
        ? frame.version === first.version &&
          frame.layer === first.layer &&
          frame.sampleRate === first.sampleRate
        : true) &&
      (offset === contiguousAt || followedByFrame(bytes, offset, frame));
    if (!frame || !valid) {
      offset++;
      continue;
    }
    if (!first) {
      if (isInfoFrame(bytes, offset, frame)) {
        // The tag frame describes the file; it carries no audio.
        offset += frame.length;
        contiguousAt = offset;
        continue;
      }
      first = frame;
    }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === offset) last[1] = offset + frame.length;
    else ranges.push([offset, offset + frame.length]);
    frames++;
    samples += frame.samples;
    bitrateSum += frame.bitrateKbps;
    offset += frame.length;
    contiguousAt = offset;
  }

  if (!first || frames === 0) throw new Error('No MP3 audio found in this file.');

  let audio: Uint8Array<ArrayBuffer>;
  const only = ranges[0];
  if (ranges.length === 1 && only) {
    audio = bytes.subarray(only[0], only[1]);
  } else {
    audio = new Uint8Array(ranges.reduce((sum, [from, to]) => sum + to - from, 0));
    let position = 0;
    for (const [from, to] of ranges) {
      audio.set(bytes.subarray(from, to), position);
      position += to - from;
    }
  }
  return {
    audio,
    info: {
      version: first.version,
      layer: first.layer,
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitrateKbps: Math.round(bitrateSum / frames),
      frames,
      samplesPerFrame: first.samples,
      duration: samples / first.sampleRate,
    },
  };
}

/** Exact duration in seconds, from the frame count. */
export async function mp3Duration(blob: Blob): Promise<number> {
  return parseMp3(new Uint8Array(await blob.arrayBuffer())).info.duration;
}

/**
 * Joins MP3 segments of the same encoding (version, layer and sample rate)
 * into one file, dropping their tags and header frames. Throws if the
 * segments were encoded differently, because the result would play at the
 * wrong speed. Mono and stereo can be mixed by the format, but TTS output
 * should not, and it is rejected too.
 */
export async function concatMp3(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new Error('Nothing to join.');
  const parsed: ParsedMp3[] = [];
  for (const blob of blobs) parsed.push(parseMp3(new Uint8Array(await blob.arrayBuffer())));
  const first = parsed[0]?.info;
  if (!first) throw new Error('Nothing to join.');
  for (const { info } of parsed) {
    if (
      info.version !== first.version ||
      info.layer !== first.layer ||
      info.sampleRate !== first.sampleRate ||
      info.channels !== first.channels
    ) {
      throw new Error('These MP3 segments were encoded differently and cannot be joined.');
    }
  }
  return new Blob(
    parsed.map(({ audio }) => audio),
    { type: 'audio/mpeg' },
  );
}
