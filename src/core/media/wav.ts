/**
 * WAV files: writing 16-bit PCM, wrapping the raw PCM that OpenRouter's
 * text-to-speech returns, reading headers, and joining files.
 *
 * Pure byte handling, no DOM or Web Audio, so it is unit-tested in Node.
 */

/** Bytes of a canonical PCM WAV header (RIFF, `fmt ` and the `data` chunk header). */
export const WAV_HEADER_BYTES = 44;

/** RIFF sizes are 32-bit, so a WAV cannot hold more than this much audio data. */
const MAX_WAV_DATA_BYTES = 0xffffffff - (WAV_HEADER_BYTES - 8);

export interface WavFormat {
  /** 1 = integer PCM, 3 = IEEE float. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

export interface WavInfo extends WavFormat {
  /** Offset of the first audio byte. */
  dataOffset: number;
  /** Length of the audio data in bytes (to the end of the file when the header says 0 or 0xFFFFFFFF). */
  dataBytes: number;
  /** Length in seconds. */
  duration: number;
}

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return bytes.length >= offset + text.length;
}

/** The 44-byte header for 16-bit PCM audio of `dataBytes` bytes. */
export function wavHeader(
  dataBytes: number,
  sampleRate: number,
  channels: number,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate < 1) throw new Error('Invalid sample rate.');
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new Error('Invalid channel count.');
  }
  if (dataBytes > MAX_WAV_DATA_BYTES) throw new Error('This audio is too long for a WAV file.');
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
  view.setUint16(20, 1, true);
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
 * Encodes float samples (-1 to 1, one array per channel, all the same length)
 * as a 16-bit PCM WAV. Values outside the range are clipped.
 *
 * Memory: the Int16 copy is 2 bytes per sample per channel (115 MB for an
 * hour of 16 kHz mono), plus the Float32 input the caller already holds.
 */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const first = channels[0];
  if (!first) throw new Error('Need at least one channel of audio.');
  const length = first.length;
  if (channels.some((channel) => channel.length !== length)) {
    throw new Error('All channels must have the same length.');
  }
  const pcm = new Int16Array(length * channels.length);
  const count = channels.length;
  for (let c = 0; c < count; c++) {
    const samples = channels[c] ?? first;
    for (let i = 0; i < length; i++) {
      const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
      pcm[i * count + c] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
    }
  }
  return new Blob([wavHeader(pcm.byteLength, sampleRate, count), pcm], { type: 'audio/wav' });
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

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

/**
 * Reads the format of headerless PCM from a `Content-Type` such as
 * `audio/pcm;rate=24000;channels=1`. Returns `null` when the type is not
 * `audio/pcm`. A missing `rate` or `channels` falls back to 24000 Hz mono, the
 * OpenAI-compatible default.
 */
export function parsePcmContentType(contentType: string | null | undefined): PcmFormat | null {
  if (!contentType) return null;
  const [mime, ...params] = contentType.split(';');
  if (mime?.trim().toLowerCase() !== 'audio/pcm') return null;
  const read = (name: string): number | undefined => {
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() === name && value !== undefined) {
        const number = Number(value.trim().replace(/^"|"$/g, ''));
        if (Number.isInteger(number) && number > 0) return number;
      }
    }
    return undefined;
  };
  return { sampleRate: read('rate') ?? 24000, channels: read('channels') ?? 1 };
}

/** Reads a WAV header (RIFF/WAVE with a `fmt ` and a `data` chunk, other chunks skipped). */
export function parseWav(bytes: Uint8Array): WavInfo {
  if (!ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WAVE')) throw new Error('Not a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let format: WavFormat | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(
      bytes[offset] ?? 0,
      bytes[offset + 1] ?? 0,
      bytes[offset + 2] ?? 0,
      bytes[offset + 3] ?? 0,
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.length) {
      format = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('This WAV file has no format chunk.');
      const remaining = bytes.length - body;
      // Streamed WAVs write 0 or 0xFFFFFFFF here; treat the rest of the file as audio.
      const dataBytes = size === 0 || size === 0xffffffff || size > remaining ? remaining : size;
      const frame = (format.channels * format.bitsPerSample) / 8;
      return {
        ...format,
        dataOffset: body,
        dataBytes,
        duration: frame > 0 && format.sampleRate > 0 ? dataBytes / frame / format.sampleRate : 0,
      };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('This WAV file has no audio data.');
}

/** How many bytes of a WAV file to read to find its header (a `LIST` chunk can precede the audio). */
const HEADER_SCAN_BYTES = 64 * 1024;

async function wavInfoOf(blob: Blob): Promise<WavInfo> {
  const head = new Uint8Array(await blob.slice(0, HEADER_SCAN_BYTES).arrayBuffer());
  const info = parseWav(head);
  // Data sizes were clamped to the bytes we read; take the real remainder from the Blob.
  const remaining = blob.size - info.dataOffset;
  const declared = new DataView(head.buffer).getUint32(info.dataOffset - 4, true);
  const dataBytes =
    declared === 0 || declared === 0xffffffff || declared > remaining ? remaining : declared;
  const frame = (info.channels * info.bitsPerSample) / 8;
  return { ...info, dataBytes, duration: dataBytes / frame / info.sampleRate };
}

/** Duration in seconds of a WAV Blob, from its header. */
export async function wavDuration(blob: Blob): Promise<number> {
  return (await wavInfoOf(blob)).duration;
}

/**
 * Joins WAV files into one. They must share sample rate, channel count and
 * sample format. Only the headers are read; the audio is concatenated as Blob
 * slices without being copied into memory.
 */
export async function concatWav(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new Error('Nothing to join.');
  const infos = await Promise.all(blobs.map(wavInfoOf));
  const first = infos[0];
  if (!first) throw new Error('Nothing to join.');
  for (const info of infos) {
    if (
      info.audioFormat !== first.audioFormat ||
      info.channels !== first.channels ||
      info.sampleRate !== first.sampleRate ||
      info.bitsPerSample !== first.bitsPerSample
    ) {
      throw new Error(
        'These WAV files differ in sample rate, channels or format and cannot be joined.',
      );
    }
  }
  if (first.audioFormat !== 1 || first.bitsPerSample !== 16) {
    throw new Error('Only 16-bit PCM WAV files can be joined.');
  }
  const parts: Blob[] = infos.map((info, i) =>
    (blobs[i] as Blob).slice(info.dataOffset, info.dataOffset + info.dataBytes),
  );
  const total = infos.reduce((sum, info) => sum + info.dataBytes, 0);
  return new Blob([wavHeader(total, first.sampleRate, first.channels), ...parts], {
    type: 'audio/wav',
  });
}
