/**
 * The frame grabber: scrub one clip (a range slider moving frame by frame, keyboard included) and save the frame
 * on screen as a full-size PNG. Saved frames are image results (download, Send to…, Remove) with Use as first
 * frame, Use as last frame and Use as reference.
 */
import { clampSeekTime } from '../../core/media/video';
import { imageResultCard } from '../../ui/components/image-result-card';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { presentError } from '../../ui/feedback/errors';
import { formatBytes } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolUi } from '../../ui/tool/types';
import type { TimelineClip } from './timeline';

/** Step of the slider: one frame at the generators' 24 fps. */
const FRAME = 1 / 24;

export interface FrameGrabberHost {
  ui: Pick<ToolUi, 'addResult' | 'sendTo'>;
  /** A full-size PNG of the frame at `time` seconds. */
  capture(blob: Blob, time: number): Promise<Blob>;
  useAsFirst(blob: Blob, name: string): void;
  useAsLast(blob: Blob, name: string): void;
  useAsReference(blob: Blob, name: string): void;
}

export interface FrameGrabber {
  /** The scrubber (hidden until a clip is opened). */
  readonly element: HTMLElement;
  /** Saved frames. */
  readonly gallery: HTMLElement;
  open(clip: TimelineClip, blob: Blob): void;
  close(): void;
  /** Closes the scrubber when it shows this clip. */
  clipGone(clipId: string): void;
}

const fmt = (seconds: number): string => `${(Math.round(seconds * 100) / 100).toFixed(2)} s`;

export function frameGrabber(host: FrameGrabberHost): FrameGrabber {
  const headingId = uid('frames-heading');
  const sliderId = uid('frames-position');
  let current: { clip: TimelineClip; blob: Blob; url: string } | null = null;
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
    step: String(FRAME),
    value: '0',
    'data-testid': 'video-frames-slider',
  });
  const time = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'video-frames-time',
  });
  const position = (): number => Number(slider.value) || 0;
  const show = (): void => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const at = position();
    time.textContent = `${fmt(at)} of ${fmt(duration)}`;
    slider.setAttribute('aria-valuetext', fmt(at));
    video.currentTime = clampSeekTime(at, duration, 24);
  };
  slider.addEventListener('input', show);
  const step = (delta: number): void => {
    const max = Number(slider.max) || 0;
    slider.value = String(Math.min(max, Math.max(0, position() + delta)));
    show();
  };
  video.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    slider.max = String(duration);
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
    const { clip, blob } = current;
    const at = position();
    try {
      const png = await host.capture(blob, at);
      const stem = clip.name.replace(/\.[a-z0-9]+$/i, '');
      const name = `${stem}-frame-${at.toFixed(2).replace('.', '_')}s.png`;
      const column = h('div', { class: 'col', 'data-testid': 'video-frame' });
      const card = imageResultCard({
        ui: host.ui,
        blob: png,
        name,
        title: `Frame at ${fmt(at)} of ${clip.name}`,
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
      announce(`Saved the frame at ${fmt(at)}.`);
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
  const close = (): void => {
    if (current) URL.revokeObjectURL(current.url);
    current = null;
    video.removeAttribute('src');
    video.load();
    element.hidden = true;
  };
  const element = h(
    'section',
    {
      class: 'card',
      hidden: true,
      'aria-labelledby': headingId,
      'data-testid': 'video-frame-grabber',
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
      h('label', { class: 'form-label small mb-0', htmlFor: sliderId }, 'Position'),
      slider,
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        button('Previous frame', 'chevron-left', 'video-frames-prev', () => step(-FRAME)),
        button('Next frame', 'chevron-right', 'video-frames-next', () => step(FRAME)),
        time,
        h('span', { class: 'ms-auto' }, saveButton),
      ),
    ),
  );

  return {
    element,
    gallery,
    open(clip, blob) {
      if (current) URL.revokeObjectURL(current.url);
      const url = URL.createObjectURL(blob);
      current = { clip, blob, url };
      heading.textContent = `Frame grabber: ${clip.name}`;
      slider.value = '0';
      slider.max = String(clip.duration ?? 0);
      video.src = url;
      element.hidden = false;
      slider.focus();
      element.scrollIntoView({ block: 'nearest' });
    },
    close,
    clipGone(clipId) {
      if (current?.clip.id === clipId) close();
    },
  };
}
