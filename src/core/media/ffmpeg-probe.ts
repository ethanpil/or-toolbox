/**
 * Reads what `ffmpeg -i <file>` prints about a media file. Reading the log is
 * simpler than running ffprobe in wasm, and needs no browser decoder, so it
 * also works for codecs the browser cannot play (HEVC MOV, ProRes).
 *
 * Pure text handling, unit-tested in Node.
 */

export interface VideoStreamInfo {
  codec: string;
  /** For example `High` or `Main`; empty if the log gives none. */
  profile: string;
  pixelFormat: string;
  width: number;
  height: number;
  /** Frames per second, or 0 if the log does not say. */
  fps: number;
  /** Sample aspect ratio, for example `1:1`. */
  sar: string;
  /** Rotation from the display matrix in degrees, 0 if none. */
  rotation: number;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaInfo {
  /** Seconds, 0 if unknown. */
  duration: number;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
  /**
   * Identical for files whose streams can be joined without re-encoding:
   * codecs, profile, pixel format, size, frame rate, rotation, and audio
   * format all match.
   */
  signature: string;
}

const CHANNEL_NAMES: Record<string, number> = {
  mono: 1,
  stereo: 2,
  '2.1': 3,
  '3.0': 3,
  quad: 4,
  '4.0': 4,
  '5.0': 5,
  '5.1': 6,
  '6.1': 7,
  '7.1': 8,
};

function channelCount(text: string): number {
  const named = CHANNEL_NAMES[text.trim().split('(')[0] ?? ''];
  if (named) return named;
  const count = /^(\d+) channels?/.exec(text.trim());
  return count?.[1] ? Number(count[1]) : 2;
}

/** Parses the log lines ffmpeg prints for `ffmpeg -i`. */
export function parseMediaInfo(log: string): MediaInfo {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const seconds = duration
    ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    : 0;

  let video: VideoStreamInfo | null = null;
  let audio: AudioStreamInfo | null = null;
  const rotation = /displaymatrix:\s*rotation of\s*(-?[\d.]+)\s*degrees/.exec(log);

  for (const line of log.split(/\r?\n/)) {
    if (!video && /Stream #\d+:\d+.*: Video:/.test(line) && !line.includes('attached pic')) {
      const head = /Video:\s*([^\s,]+)(?:\s*\(([^)]*)\))?/.exec(line);
      const size = /,\s*([a-z][a-z0-9_]*)(?:\([^)]*\))?,\s*(\d{2,5})x(\d{2,5})/.exec(line);
      const fps = /([\d.]+)\s*fps/.exec(line) ?? /([\d.]+)\s*tbr/.exec(line);
      if (head?.[1] && size?.[2] && size[3]) {
        video = {
          codec: head[1],
          profile: head[2] ?? '',
          pixelFormat: size[1] ?? '',
          width: Number(size[2]),
          height: Number(size[3]),
          fps: fps?.[1] ? Number(fps[1]) : 0,
          sar: /SAR\s*(\d+:\d+)/.exec(line)?.[1] ?? '',
          rotation: rotation?.[1] ? Number(rotation[1]) : 0,
        };
      }
    } else if (!audio && /Stream #\d+:\d+.*: Audio:/.test(line)) {
      const head = /Audio:\s*([^\s,]+)/.exec(line);
      const rate = /(\d+)\s*Hz/.exec(line);
      const layout = /Hz,\s*([^,]+),/.exec(line);
      if (head?.[1]) {
        audio = {
          codec: head[1],
          sampleRate: rate?.[1] ? Number(rate[1]) : 0,
          channels: layout?.[1] ? channelCount(layout[1]) : 2,
        };
      }
    }
  }

  const signature = [
    video
      ? [
          video.codec,
          video.profile,
          video.pixelFormat,
          `${video.width}x${video.height}`,
          video.sar,
          video.fps.toFixed(2),
          video.rotation,
        ].join(':')
      : 'no-video',
    audio ? [audio.codec, audio.sampleRate, audio.channels].join(':') : 'no-audio',
  ].join('|');

  return { duration: seconds, video, audio, signature };
}
