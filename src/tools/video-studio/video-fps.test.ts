import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastFrameTime } from '../../core/media/video';
import { frameCount, frameTime } from './frame-grabber';
import { DEFAULT_FPS, frameRateOf } from './video-fps';

const fixture = (name: string): Blob =>
  new Blob([readFileSync(join(import.meta.dirname, '../../../tests/fixtures/media', name))]);

describe('frame rate', () => {
  it('reads the video track of an MP4 (the recorded grok clip is 24 fps)', async () => {
    expect(await frameRateOf(fixture('video-1s.mp4'))).toBeCloseTo(24, 3);
  });

  it('steps frame by frame up to the true last frame', () => {
    const duration = 25 / 24;
    expect(frameCount(duration, 24)).toBe(25);
    expect(frameTime(0, 24, duration)).toBeCloseTo(1 / 48);
    expect(frameTime(12, 24, duration)).toBeCloseTo(12.5 / 24);
    // The last position shows the final frame (inside its interval), not the clip's end.
    expect(frameTime(24, 24, duration)).toBeCloseTo(lastFrameTime(duration, 24));
    expect(frameCount(0, 30)).toBe(1);
  });

  it('falls back to 30 fps for files it cannot read', async () => {
    expect(DEFAULT_FPS).toBe(30);
    expect(await frameRateOf(fixture('speech.mp3'))).toBe(DEFAULT_FPS);
    expect(
      await frameRateOf(new Blob([new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76])])),
    ).toBe(DEFAULT_FPS);
    expect(await frameRateOf(new Blob([]))).toBe(DEFAULT_FPS);
  });
});
