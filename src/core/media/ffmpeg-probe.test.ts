// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseMediaInfo } from './ffmpeg-probe';

const MP4_LOG = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'c0.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
  Duration: 00:00:01.04, start: 0.000000, bitrate: 981 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 544x544 [SAR 1:1 DAR 1:1], 902 kb/s, 24 fps, 24 tbr, 12288 tbn (default)
    Metadata:
      handler_name    : VideoHandler
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706d), 44100 Hz, stereo, fltp, 69 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified`;

describe('parseMediaInfo', () => {
  it('reads duration, video and audio streams', () => {
    expect(parseMediaInfo(MP4_LOG)).toEqual({
      duration: 1.04,
      video: {
        codec: 'h264',
        profile: 'High',
        pixelFormat: 'yuv420p',
        width: 544,
        height: 544,
        fps: 24,
        sar: '1:1',
        rotation: 0,
      },
      audio: { codec: 'aac', sampleRate: 44100, channels: 2 },
      signature: 'h264:High:yuv420p:544x544:1:1:24.00:0|aac:44100:2',
    });
  });

  it('reads hours, minutes and the frame rate from tbr when fps is missing', () => {
    const log = `  Duration: 01:02:03.50, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv), 1920x1080, 29.97 tbr, 1k tbn`;
    const info = parseMediaInfo(log);
    expect(info.duration).toBeCloseTo(3723.5);
    expect(info.video).toMatchObject({
      codec: 'vp9',
      profile: 'Profile 0',
      width: 1920,
      height: 1080,
      fps: 29.97,
    });
    expect(info.audio).toBeNull();
    expect(info.signature.endsWith('|no-audio')).toBe(true);
  });

  it('reads mono audio, channel counts, and a display-matrix rotation', () => {
    const log = `  Duration: 00:00:05.00, start: 0.000000, bitrate: 8000 kb/s
  Stream #0:0(und): Video: hevc (Main), yuv420p(tv), 1080x1920, 30 fps, 30 tbr, 600 tbn
    Side data:
      displaymatrix: rotation of -90.00 degrees
  Stream #0:1(und): Audio: aac (LC), 48000 Hz, mono, fltp, 96 kb/s`;
    const info = parseMediaInfo(log);
    expect(info.video?.rotation).toBe(-90);
    expect(info.audio).toEqual({ codec: 'aac', sampleRate: 48000, channels: 1 });
    expect(parseMediaInfo(log.replace('mono', '5.1(side)')).audio?.channels).toBe(6);
    expect(parseMediaInfo(log.replace('mono', '2 channels')).audio?.channels).toBe(2);
  });

  it('ignores cover art and audio-only files', () => {
    const log = `  Duration: 00:03:00.00, start: 0.025057, bitrate: 192 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 192 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`;
    const info = parseMediaInfo(log);
    expect(info.video).toBeNull();
    expect(info.audio?.codec).toBe('mp3');
    expect(info.signature).toBe('no-video|mp3:44100:2');
  });

  it('gives equal signatures to clips that can be joined without re-encoding, and different ones otherwise', () => {
    const same = parseMediaInfo(
      MP4_LOG.replace('902 kb/s', '1200 kb/s').replace('00:00:01.04', '00:00:03.00'),
    );
    expect(same.signature).toBe(parseMediaInfo(MP4_LOG).signature);
    expect(parseMediaInfo(MP4_LOG.replace('24 fps', '30 fps')).signature).not.toBe(same.signature);
    expect(parseMediaInfo(MP4_LOG.replace('544x544', '720x720')).signature).not.toBe(
      same.signature,
    );
    expect(parseMediaInfo(MP4_LOG.replace('44100 Hz', '48000 Hz')).signature).not.toBe(
      same.signature,
    );
    expect(parseMediaInfo(MP4_LOG.replace('(High)', '(Main)')).signature).not.toBe(same.signature);
  });

  it('copes with unknown duration and empty logs', () => {
    expect(parseMediaInfo('  Duration: N/A, bitrate: N/A').duration).toBe(0);
    expect(parseMediaInfo('')).toEqual({
      duration: 0,
      video: null,
      audio: null,
      signature: 'no-video|no-audio',
    });
  });
});
