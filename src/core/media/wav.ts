/**
 * WAV files: writing 16-bit PCM, wrapping raw PCM, reading headers, and
 * joining files.
 *
 * Pure byte handling, no DOM or Web Audio, so it is unit-tested in Node.
 */
import { InvalidInputError } from '../errors';
import { matchesAscii } from '../files';

/** Bytes of a canonical PCM WAV header (RIFF, `fmt ` and the `data` chunk header). */
export const WAV_HEADER_BYTES = 44;

/** RIFF sizes are 32-bit, so a WAV cannot hold more than this much audio data. */
const MAX_WAV_DATA_BYTES = 0xffffffff - (WAV_HEADER_BYTES - 8);

/** `fmt ` format tags: plain integer PCM, and the extensible form many tools write for it. */
const FORMAT_PCM = 1;
const FORMAT_EXTENSIBLE = 0xfffe;

export interface WavFormat {
  /** 1 = integer PCM, 3 = IEEE float, 0xFFFE = extensible. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface WavInfo extends WavFormat {
  /** Offset of the first audio byte. */
  dataOffset: number;
  /**
   * Length of the audio data in bytes: whole frames only (a trailing partial
   * sample is dropped), and to the end of the file when the header says 0 or
   * 0xFFFFFFFF, as streamed files do.
   */
  dataBytes: number;
  /** Length in seconds. */
  duration: number;
}

/** The 44-byte header for 16-bit PCM audio of `dataBytes` bytes. */
export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new RangeError('Invalid sample rate.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new RangeError('Invalid channel count.');
  }
  if (dataBytes > MAX_WAV_DATA_BYTES) {
    throw new InvalidInputError('This audio is too long for a WAV file (the limit is 4 GB).');
  }
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) header[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * Float samples (-1 to 1, one array per channel, all the same length) as
 * interleaved 16-bit integers; values outside the range are clipped.
 */
export function interleaveToInt16(channels: readonly Float32Array[]): Int16Array<ArrayBuffer> {
  const first = channels[0];
  if (!first) throw new RangeError('Need at least one channel of audio.');
  const length = first.length;
  if (channels.some((channel) => channel.length !== length)) {
    throw new RangeError('All channels must have the same length.');
  }
  const count = channels.length;
  const pcm = new Int16Array(length * count);
  for (let c = 0; c < count; c++) {
    const samples = channels[c] ?? first;
    for (let i = 0; i < length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
      pcm[i * count + c] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
    }
  }
  return pcm;
}

/**
 * Encodes float samples (-1 to 1, one array per channel, all the same length)
 * as a 16-bit PCM WAV. Values outside the range are clipped.
 *
 * Memory: the Int16 copy is 2 bytes per sample per channel (115 MB for an
 * hour of 16 kHz mono), plus the Float32 input the caller already holds.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const pcm = interleaveToInt16(channels);
  return new Blob([wavHeader(pcm.byteLength, sampleRate, channels.length), pcm], {
    type: 'audio/wav',
  });
}

/**
 * Wraps raw little-endian 16-bit PCM (what `POST /audio/speech` returns for
 * `response_format: "pcm"`) in a WAV header. A trailing partial sample is dropped.
 */
export function pcmToWav(bytes: Uint8Array<ArrayBuffer>, sampleRate: number, channels = 1): Blob {
  const frame = channels * 2;
  const usable = bytes.byteLength - (bytes.byteLength % frame);
  return new Blob([wavHeader(usable, sampleRate, channels), bytes.subarray(0, usable)], {
    type: 'audio/wav',
  });
}

// --- reading headers ----------------------------------------------------------

const notWav = (): InvalidInputError => new InvalidInputError('This is not a WAV file.');
const noAudio = (): InvalidInputError => new InvalidInputError('This WAV file has no audio data.');

/** Chunks a reader walks through before it gives up: a real file has a handful. */
const MAX_CHUNKS = 10_000;

function chunkId(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
}

function readFormat(bytes: Uint8Array): WavFormat {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    audioFormat: view.getUint16(0, true),
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    bitsPerSample: view.getUint16(14, true),
  };
}

/** The info for a `data` chunk of declared `size` with `remaining` bytes left in the file. */
function dataInfo(
  format: WavFormat | undefined,
  offset: number,
  size: number,
  remaining: number,
): WavInfo {
  if (!format) throw new InvalidInputError('This WAV file has no format chunk.');
  // Streamed WAVs write 0 or 0xFFFFFFFF here; treat the rest of the file as audio.
  let dataBytes = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
  const frame = (format.channels * format.bitsPerSample) / 8;
  if (Number.isInteger(frame) && frame > 0) dataBytes -= dataBytes % frame;
  return {
    ...format,
    dataOffset: offset,
    dataBytes,
    duration: frame > 0 && format.sampleRate > 0 ? dataBytes / frame / format.sampleRate : 0,
  };
}

/** Reads the header of a WAV held in memory, walking its chunks (RIFF/WAVE, `fmt `, `data`, others skipped). */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WAVE')) throw notWav();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let offset = 12;
  for (let chunks = 0; chunks < MAX_CHUNKS && offset + 8 <= bytes.length; chunks++) {
    const id = chunkId(bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = readFormat(bytes.subarray(body, body + 16));
    } else if (id === 'data') {
      return dataInfo(format, body, size, bytes.length - body);
    }
    offset = body + size + (size % 2);
  }
  throw noAudio();
}

/**
 * Reads the header of a WAV Blob. Unlike `parseWav` it never loads the file:
 * it reads each chunk header (8 bytes) where it lies, so a `LIST` or `id3 `
 * chunk of any size in front of the audio is skipped for the price of one
 * read, and the data length is taken from the Blob's own size.
 */
export async function readWavInfo(blob: Blob): Promise<WavInfo> {
  const read = async (from: number, to: number): Promise<Uint8Array> =>
    new Uint8Array(await blob.slice(from, to).arrayBuffer());

  const riff = await read(0, 12);
  if (!matchesAscii(riff, 0, 'RIFF') || !matchesAscii(riff, 8, 'WAVE')) throw notWav();
  let format: WavFormat | undefined;
  let offset = 12;
  for (let chunks = 0; chunks < MAX_CHUNKS && offset + 8 <= blob.size; chunks++) {
    const header = await read(offset, offset + 8);
    const id = chunkId(header);
    const size = new DataView(header.buffer).getUint32(4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      const fmt = await read(body, body + 16);
      if (fmt.length >= 16) format = readFormat(fmt);
    } else if (id === 'data') {
      return dataInfo(format, body, size, blob.size - body);
    }
    offset = body + size + (size % 2);
  }
  throw noAudio();
}

/** Duration in seconds of a WAV Blob, from its header. */
export async function wavDuration(blob: Blob): Promise<number> {
  return (await readWavInfo(blob)).duration;
}

/**
 * Joins WAV files into one. They must share sample rate and channel count and
 * be 16-bit PCM. Only the headers are read; the audio is concatenated as Blob
 * slices without being copied into memory, and only whole frames are used.
 */
export async function concatWav(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new InvalidInputError('There is no audio to join.');
  const infos = await Promise.all(blobs.map(readWavInfo));
  const first = infos[0];
  if (!first) throw new InvalidInputError('There is no audio to join.');
  const isPcm = (info: WavInfo): boolean =>
    info.audioFormat === FORMAT_PCM || info.audioFormat === FORMAT_EXTENSIBLE;
  for (const info of infos) {
    if (
      isPcm(info) !== isPcm(first) ||
      info.channels !== first.channels ||
      info.sampleRate !== first.sampleRate ||
      info.bitsPerSample !== first.bitsPerSample
    ) {
      throw new InvalidInputError(
        'These WAV files differ in sample rate, channels or format and cannot be joined.',
      );
    }
  }
  if (!isPcm(first) || first.bitsPerSample !== 16) {
    throw new InvalidInputError('Only 16-bit PCM WAV files can be joined.');
  }
  const parts: Blob[] = infos.map((info, i) =>
    (blobs[i] as Blob).slice(info.dataOffset, info.dataOffset + info.dataBytes),
  );
  const total = infos.reduce((sum, info) => sum + info.dataBytes, 0);
  return new Blob([wavHeader(total, first.sampleRate, first.channels), ...parts], {
    type: 'audio/wav',
  });
}
