/**
 * `videoPlayer()`: the browser's native video controls in a rounded, letterboxed frame. Pass a Blob (an object
 * URL is made and revoked on `dispose()`) or an existing object URL.
 */
import { h } from '../dom';

export interface VideoPlayerOptions {
  src?: string;
  blob?: Blob;
  /** Accessible name, e.g. the clip's file name. */
  label: string;
  /** Same-origin or object URL of a still frame. */
  poster?: string;
  testId?: string;
}

export interface VideoPlayer {
  readonly element: HTMLElement;
  readonly video: HTMLVideoElement;
  dispose(): void;
}

export function videoPlayer(options: VideoPlayerOptions): VideoPlayer {
  const ownUrl = options.blob ? URL.createObjectURL(options.blob) : null;
  const video = h('video', {
    controls: true,
    playsInline: true,
    preload: 'metadata',
    src: ownUrl ?? options.src ?? '',
    poster: options.poster,
    class: 'or-video or-fade-in',
    'aria-label': options.label,
  });
  return {
    element: h(
      'div',
      { class: 'or-video-frame', 'data-testid': options.testId ?? 'video-player' },
      video,
    ),
    video,
    dispose() {
      video.pause();
      if (ownUrl) URL.revokeObjectURL(ownUrl);
    },
  };
}
