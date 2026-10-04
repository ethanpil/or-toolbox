/**
 * The frame grabber: scrub one clip frame by frame (a slider over the clip's frames at its real frame rate, read
 * from the file, keyboard included; the last position is the true final frame) and save the frame on screen as a
 * full-size PNG. Saved frames are image results (download, Send to…, Remove) with Use as first frame, Use as last
 * frame and Use as reference. Closing returns focus to the control that opened it.
 */
import { clampSeekTime, lastFrameTime } from '../../core/media/video';
import { imageResultCard } from '../../ui/components/image-result-card';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { formatBytes } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolUi } from '../../ui/tool/types';
import type { TimelineClip } from './timeline';
import { DEFAULT_FPS } from './video-fps';

export interface FrameGrabberHost {
  ui: Pick<ToolUi, 'addResult' | 'sendTo'>;
  /** The clip's frame rate (frames per second). */
  frameRate(blob: Blob): Promise<number>;
  /** A full-size PNG of the frame at `time` seconds. */
  capture(blob: Blob, time: number, fps: number): Promise<Blob>;
  useAsFirst(blob: Blob, name: string): void;
  useAsLast(blob: Blob, name: string): void;
  useAsReference(blob: Blob, name: string): void;
}

export interface FrameGrabber {
  /** The scrubber (hidden until a clip is opened). */
  readonly element: HTMLElement;
  /** Saved frames. */
  readonly gallery: HTMLElement;
  /** Opens the scrubber on `clip`; `returnFocus` gives focus back to what opened it, on Close. */
  open(clip: TimelineClip, blob: Blob, returnFocus: () => void): Promise<void>;
  close(): void;
  /** Closes the scrubber when it shows this clip. */
  clipGone(clipId: string): void;
}

const seconds = (value: number): string => `${(Math.round(value * 100) / 100).toFixed(2)} s`;

/** Frame `index` (0-based) of a video at `fps`: the time to show it (the middle of its interval). */
export function frameTime(index: number, fps: number, duration: number): number {
  const middle = (index + 0.5) / fps;
  return Math.min(clampSeekTime(middle, duration, fps), lastFrameTime(duration, fps));
}

/** How many frames a video of `duration` seconds at `fps` has (at least one). */
export function frameCount(duration: number, fps: number): number {
  return Math.max(1, Math.round(duration * fps));
}

export function frameGrabber(host: FrameGrabberHost): FrameGrabber {
  const headingId = uid('frames-heading');
  const sliderId = uid('frames-position');
  let current: {
    clip: TimelineClip;
    blob: Blob;
    url: string;
    fps: number;
    frames: number;
    returnFocus: () => void;
  } | null = null;
  let saving = false;

  const heading = h('h3', { id: headingId, class: 'h6 mb-0 me-auto text-break' }, 'Frame grabber');
  const video = h('video', {
    muted: true,
    playsInline: true,
    preload: 'auto',
    class: 'or-video',
    'aria-label': 'Frame preview',
    'data-testid': 'video-frames-preview',
  });
  const slider = h('input', {
    id: sliderId,
    type: 'range',
    class: 'form-range',
    min: '0',
    max: '0',
    step: '1',
    value: '0',
    'data-testid': 'video-frames-slider',
  });
  const position = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'video-frames-time',
  });
  const index = (): number => Math.round(Number(slider.value) || 0);
  const duration = (): number =>
    Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : (current?.clip.duration ?? 0);
  const timeOf = (frame: number): number =>
    current ? frameTime(frame, current.fps, duration()) : 0;
  const show = (): void => {
    if (!current) return;
    const frame = index();
    const at = timeOf(frame);
    const label = `Frame ${frame + 1} of ${current.frames} · ${seconds(at)}`;
    position.textContent = label;
    slider.setAttribute('aria-valuetext', label);
    video.currentTime = at;
  };
  slider.addEventListener('input', show);
  const step = (delta: number): void => {
    const max = Number(slider.max) || 0;
    slider.value = String(Math.min(max, Math.max(0, index() + delta)));
    show();
  };
  video.addEventListener('loadedmetadata', () => {
    if (!current) return;
    current.frames = frameCount(duration(), current.fps);
    slider.max = String(current.frames - 1);
    show();
  });

  const button = (
    label: string,
    glyph: string,
    testId: string,
    onclick: () => void,
    primary = false,
  ) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn btn-sm ${primary ? 'btn-primary' : 'btn-outline-secondary'} d-inline-flex align-items-center gap-1`,
        'data-testid': testId,
        onclick,
      },
      icon(glyph),
      label,
    );
  const gallery = h('div', {
    class: 'row row-cols-1 row-cols-md-2 g-3',
    'data-testid': 'video-frames',
  });

  const save = async (): Promise<void> => {
    if (!current || saving) return;
    saving = true;
    const { clip, blob, fps } = current;
    const frame = index();
    const at = timeOf(frame);
    try {
      const png = await host.capture(blob, at, fps);
      const stem = clip.name.replace(/\.[a-z0-9]+$/i, '');
      const name = `${stem}-frame-${frame + 1}.png`;
      const column = h('div', { class: 'col', 'data-testid': 'video-frame' });
      const card = imageResultCard({
        ui: host.ui,
        blob: png,
        name,
        title: `Frame ${frame + 1} (${seconds(at)}) of ${clip.name}`,
        headingLevel: 4,
        meta: [formatBytes(png.size)],
        formats: ['png', 'jpg', 'webp'],
        actions: [
          {
            label: 'Use as first frame',
            icon: 'skip-start',
            testId: 'video-frame-first',
            onClick: () => host.useAsFirst(png, name),
          },
          {
            label: 'Use as last frame',
            icon: 'skip-end',
            testId: 'video-frame-last',
            onClick: () => host.useAsLast(png, name),
          },
          {
            label: 'Use as reference',
            icon: 'images',
            testId: 'video-frame-reference',
            onClick: () => host.useAsReference(png, name),
          },
        ],
        onRemove: () => column.remove(),
        focusFallback: () => (element.hidden ? null : saveButton),
        testId: 'video-frame',
      });
      column.append(card.element);
      gallery.prepend(column);
      announce(`Saved frame ${frame + 1}.`);
    } catch (error) {
      void presentError(error);
    } finally {
      saving = false;
    }
  };

  const saveButton = button(
    'Save frame as PNG',
    'camera',
    'video-frames-save',
    () => void save(),
    true,
  );
  const release = (): void => {
    if (current) URL.revokeObjectURL(current.url);
    current = null;
    video.removeAttribute('src');
    video.load();
    element.hidden = true;
  };
  const close = (): void => {
    const returnFocus = current?.returnFocus;
    const hadFocus = element.contains(document.activeElement);
    release();
    if (hadFocus || document.activeElement === document.body) returnFocus?.();
  };
  const element = h(
    'section',
    {
      class: 'card',
      hidden: true,
      'aria-labelledby': headingId,
      'data-testid': 'video-frame-grabber',
      onkeydown: (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
      },
    },
    h(
      'div',
      { class: 'card-body d-flex flex-column gap-2' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        heading,
        h('button', {
          type: 'button',
          class: 'btn-close',
          'aria-label': 'Close the frame grabber',
          'data-testid': 'video-frames-close',
          onclick: close,
        }),
      ),
      h('div', { class: 'or-video-frame' }, video),
      h('label', { class: 'form-label small mb-0', htmlFor: sliderId }, 'Frame'),
      slider,
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        button('Previous frame', 'chevron-left', 'video-frames-prev', () => step(-1)),
        button('Next frame', 'chevron-right', 'video-frames-next', () => step(1)),
        position,
        h('span', { class: 'ms-auto' }, saveButton),
      ),
    ),
  );

  return {
    element,
    gallery,
    async open(clip, blob, returnFocus) {
      if (current) URL.revokeObjectURL(current.url);
      const fps = await host.frameRate(blob).catch(() => DEFAULT_FPS);
      const url = URL.createObjectURL(blob);
      const frames = frameCount(clip.duration ?? 0, fps);
      current = { clip, blob, url, fps, frames, returnFocus };
      heading.textContent = `Frame grabber: ${clip.name}`;
      slider.value = '0';
      slider.max = String(frames - 1);
      video.src = url;
      element.hidden = false;
      show();
      slider.focus();
      element.scrollIntoView({ block: 'nearest' });
    },
    close,
    clipGone(clipId) {
      if (current?.clip.id === clipId) release();
    },
  };
}
