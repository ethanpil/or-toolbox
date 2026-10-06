/**
 * Video inspection and frame grabbing, using nothing but a `<video>` element
 * and a canvas (no ffmpeg). Browser only; covered by tests/e2e/media/.
 *
 * Used by Video studio for "Continue from last frame" (the final frame of a
 * clip becomes the next clip's first frame), the frame grabber and the
 * timeline thumbnails.
 */
import { InvalidInputError } from '../errors';
import { resizeCanvas, toBlob } from './image';
import { openMedia, waitForEvent } from './media-element';

export interface VideoMetadata {
  /** Seconds. */
  duration: number;
  width: number;
  height: number;
}

export interface CaptureOptions {
  /**
   * The video's frame rate, if known. Only used for `'last'`, to aim at the
   * middle of the final frame's interval. Without it the frame rate is assumed
   * to be under 120 fps.
   */
  fps?: number;
  signal?: AbortSignal;
}

/** Where to take a frame: seconds, or the first or last frame. */
export type FramePosition = number | 'first' | 'last';

/** How long a seek may take before we give up on it. */
const SEEK_TIMEOUT_MS = 15_000;
/** How long to wait for the browser to present the new frame after a seek (best effort). */
const PRESENT_TIMEOUT_MS = 120;

/** Duration and pixel size of a video file. Rejects for files without a video track. */
export async function getVideoMetadata(blob: Blob): Promise<VideoMetadata> {
  const { element, dispose } = await openMedia(blob, 'video');
  try {
    if (element.videoWidth === 0 || element.videoHeight === 0) {
      throw new InvalidInputError('This file has no video track.');
    }
    return {
      duration: Number.isFinite(element.duration) ? element.duration : 0,
      width: element.videoWidth,
      height: element.videoHeight,
    };
  } finally {
    dispose();
  }
}

/** Resolves when the browser has had a chance to present the current frame. */
function framePresented(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PRESENT_TIMEOUT_MS);
    if ('requestVideoFrameCallback' in video) {
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

/**
 * Moves the playhead (to `clampSeekTime(time, ...)`) and waits until the frame
 * there can be drawn. The same position as now counts as already there,
 * except while the first frame is still loading.
 */
async function seekTo(
  video: HTMLVideoElement,
  time: number,
  fps: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const target = clampSeekTime(time, video.duration, fps);

  if (Math.abs(video.currentTime - target) < 0.001 && !video.seeking) {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await waitForEvent(video, ['loadeddata', 'error'], SEEK_TIMEOUT_MS, signal);
    }
    return;
  }

  const finished = waitForEvent(video, ['seeked', 'error'], SEEK_TIMEOUT_MS, signal);
  video.currentTime = target;
  if ((await finished) === 'error') {
    throw new InvalidInputError('The browser could not seek in this video.');
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await waitForEvent(video, ['loadeddata', 'error'], SEEK_TIMEOUT_MS, signal);
  }
  await framePresented(video);
}

/**
 * The time to seek to for the final frame. Browsers clamp a seek to
 * `duration`, and some show nothing or the wrong frame there, so aim inside
 * the last frame's interval instead: half a frame (or 1/120 s without a frame
 * rate) before the end. If the audio runs longer than the video the browser
 * keeps showing the last video frame.
 */
export function lastFrameTime(duration: number, fps?: number): number {
  if (!(duration > 0)) return 0;
  const offset = fps && fps > 0 ? 0.5 / fps : 1 / 120;
  return Math.max(0, duration - offset);
}

/**
 * Where to seek for a requested time: negative or unknown times go to the
 * start, and anything at or past the final frame goes to `lastFrameTime`
 * instead of to `duration` itself, where browsers may show nothing or the
 * wrong frame. A video of unknown (not finite) length is not clamped at the end.
 */
export function clampSeekTime(time: number, duration: number, fps?: number): number {
  const wanted = Number.isNaN(time) ? 0 : Math.max(0, time);
  return Math.min(wanted, lastFrameTime(duration, fps));
}

/** Whether drawing `source` onto a canvas shows anything (a 16 x 16 copy with a pixel that is not transparent). */
function drawsSomething(source: CanvasImageSource): boolean {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return true; // nothing to check with: draw as usual
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
  return false;
}

/** WebCodecs' `VideoFrame` of the video's current frame, or null where the browser cannot make one. */
function videoFrameOf(video: HTMLVideoElement): VideoFrame | null {
  try {
    return new VideoFrame(video);
  } catch {
    return null;
  }
}

/**
 * What to draw for the video's current frame. Video frames are opaque, yet some browsers draw a `<video>` onto a
 * canvas as fully transparent pixels while WebCodecs' `VideoFrame` of it holds the picture (Playwright's WebKit on
 * Linux, measured in CI); then the `VideoFrame` is drawn. When neither gives a picture this throws: sent on
 * (Continue), a blank picture would start a paid clip from nothing. (A WebM frame that is wholly transparent is
 * refused too; there is nothing to continue from there.) Call `close()` when done.
 */
function currentFrame(video: HTMLVideoElement): { image: CanvasImageSource; close: () => void } {
  if (drawsSomething(video)) return { image: video, close: () => undefined };
  if (typeof VideoFrame === 'function') {
    const frame = videoFrameOf(video);
    if (frame && drawsSomething(frame)) return { image: frame, close: () => frame.close() };
    frame?.close();
  }
  throw new InvalidInputError(
    'This browser could not read the frames of this video. Try another browser.',
  );
}

/**
 * Takes one frame of a video as a full-size PNG. `at` is a time in seconds
 * (see `clampSeekTime`: a time at or past the end gives the final frame),
 * `'first'` or `'last'`. Rejects when the browser cannot read the frame (`currentFrame`).
 */
export async function captureFrame(
  blob: Blob,
  at: FramePosition,
  options: CaptureOptions = {},
): Promise<Blob> {
  const { element: video, dispose } = await openMedia(blob, 'video', options.signal);
  try {
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new InvalidInputError('This file has no video track.');
    }
    await seekTo(
      video,
      at === 'first' ? 0 : at === 'last' ? Infinity : at,
      options.fps,
      options.signal,
    );
    const frame = currentFrame(video);
    try {
      return await toBlob(frame.image, { type: 'image/png' });
    } finally {
      frame.close();
    }
  } finally {
    dispose();
  }
}

export interface ThumbnailOptions {
  /** The video's frame rate, if known (see `CaptureOptions.fps`). */
  fps?: number;
  /** Width of each thumbnail in pixels (never enlarged). Default 160. */
  maxWidth?: number;
  /** Default `image/jpeg`. */
  type?: string;
  /** Default 0.7. */
  quality?: number;
  signal?: AbortSignal;
  /** Called as each thumbnail is ready, so a timeline can fill in progressively. */
  onFrame?: (index: number, thumbnail: Blob) => void;
}

/**
 * Small frames at the given times (seconds, clamped like `clampSeekTime`), in the
 * order asked for, from one load of the file: for scrubbing strips and
 * timeline thumbnails.
 */
export async function frameAtTimes(
  blob: Blob,
  times: number[],
  options: ThumbnailOptions = {},
): Promise<Blob[]> {
  const { element: video, dispose } = await openMedia(blob, 'video', options.signal);
  try {
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      throw new InvalidInputError('This file has no video track.');
    }
    const width = Math.min(options.maxWidth ?? 160, video.videoWidth);
    const height = Math.max(1, Math.round((video.videoHeight * width) / video.videoWidth));
    const frames: Blob[] = [];
    for (const [index, time] of times.entries()) {
      await seekTo(video, time, options.fps, options.signal);
      const thumbnail = await toBlob(resizeCanvas(video, width, height), {
        type: options.type ?? 'image/jpeg',
        quality: options.quality ?? 0.7,
      });
      frames.push(thumbnail);
      options.onFrame?.(index, thumbnail);
    }
    return frames;
  } finally {
    dispose();
  }
}
