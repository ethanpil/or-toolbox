/**
 * `videoResultCard()`: one video result of a tool (a joined video, a trimmed clip) as a card with the player, a
 * Download button, Send to… and Remove. The video is registered with the leave guard through `ui.addResult`, so
 * it counts as not downloaded until the user saves it. The video counterpart of `audioResultCard()` and
 * `imageResultCard()`.
 *
 * The meta line starts with the length: `seconds` when the tool knows it (nothing is measured), else what the
 * card's own player reads once the browser has the video's header (no second element, no ffmpeg). The download is
 * the file as it is; `covers` names other results that downloading it counts as saved (the clips of a join).
 *
 * Remove (shared with the image and audio cards: `resultRemoval()`, result-removal.ts) asks `beforeRemove`, by
 * default a confirmation while the video is not downloaded, then drops the result
 * (`handle.remove()`), disposes the player, detaches the card, announces it and calls `onRemove`. Then, unless
 * `onRemove` moved focus itself, focus goes to the Remove button of the next video card on the page (else the
 * previous one), else to `focusFallback()`, asked only now so it can return what `onRemove` showed. `remove()`
 * drops the card from code, without asking, announcing or calling `onRemove`, and moves focus only when it was
 * inside the card.
 *
 * ```ts
 * const card = videoResultCard({
 *   ui: ctx.ui,
 *   blob,
 *   name: 'sunrise-joined-1.mp4',
 *   meta: [plural(clips.length, 'clip'), formatBytes(blob.size)],
 *   covers: () => clipResultIds,
 *   onRemove: () => showEmpty(),
 *   testId: 'video-export',
 * });
 * exports.prepend(card.element);
 * ```
 */
import { extensionForMime } from '../../core/files';
import { type Child, h } from '../dom';
import { formatDuration } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import type { ResultHandle, ToolUi } from '../tool/types';
import { exportMenu } from './export-menu';
import { resultRemoval } from './result-removal';
import { type VideoPlayer, videoPlayer } from './video-player';

export interface VideoResultCardOptions {
  /** `ctx.ui` (or just these two members): the video is registered with `addResult`; Send to… opens `sendTo`. */
  ui: Pick<ToolUi, 'addResult' | 'sendTo'>;
  blob: Blob;
  /** File name with its extension (`sunrise-joined-1.mp4`): the download name, the default heading, the labels. */
  name: string;
  /** Known length in seconds: shown at once and never measured. Without it the player's metadata gives it. */
  seconds?: number;
  /** The line beside the heading after the length, joined with " · "; empty entries are skipped (clips, size…). */
  meta: readonly (string | null | undefined | false)[];
  /** Other session results that downloading this video counts as saved (the clips a join was made from). */
  covers?: () => readonly string[];
  /** Called after the user removed the card with its Remove button (not after `remove()` from code). */
  onRemove: () => void;
  /**
   * Asked before Remove removes anything; false keeps the card. Default: while the video is not downloaded, a
   * confirmation naming it.
   */
  beforeRemove?: () => boolean | Promise<boolean>;
  /** Where focus goes after a removal when no other video card is left on the page. */
  focusFallback?: () => HTMLElement | null | undefined;
  /** Heading text; default `name`. */
  title?: string;
  /** Heading level; default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Content between the player and the buttons (a note, a prompt). */
  extra?: Child;
  /**
   * Test id prefix: `<p>-result`, `<p>-result-meta`, `<p>-player`, `<p>-download`, `<p>-send`, `<p>-remove`,
   * `<p>-remove-confirm`. Default `video`.
   */
  testId?: string;
}

export interface VideoResultCard {
  readonly element: HTMLElement;
  /** The leave-guard registration (`handle.result.downloaded` says whether it was saved). */
  readonly handle: ResultHandle;
  readonly player: VideoPlayer;
  /** Removes the card from code (result, player, element); `onRemove` is not called. Safe to call twice. */
  remove(): void;
}

/** Marks video cards on the page, so a card that goes can hand focus to a neighbour. */
const CARD_CLASS = 'or-video-result';

export function videoResultCard(options: VideoResultCardOptions): VideoResultCard {
  const { ui, blob, name } = options;
  const testId = options.testId ?? 'video';
  const title = options.title ?? name;
  const handle = ui.addResult({ kind: 'video', name, blob });
  const player = videoPlayer({ blob, label: name, testId: `${testId}-player` });

  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const own = extension ?? extensionForMime(blob.type) ?? 'bin';
  const stem = extension ? name.slice(0, -extension.length - 1) : name;

  const metaLine = h('span', {
    class: 'small text-body-secondary',
    'data-testid': `${testId}-result-meta`,
  });
  /** Writes the length (when known) and the tool's parts into the meta line and the player's label. */
  const showLength = (seconds: number | undefined): void => {
    const length = seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
    const text = [length ? formatDuration(seconds) : null, ...options.meta]
      .filter(Boolean)
      .join(' · ');
    metaLine.textContent = text;
    metaLine.hidden = text === '';
    if (length) player.video.setAttribute('aria-label', `${name}, ${formatDuration(seconds)}`);
  };
  showLength(options.seconds);
  if (options.seconds === undefined) {
    player.video.addEventListener('loadedmetadata', () => showLength(player.video.duration));
  }

  const removeKey = `video-remove:${handle.result.id}`;
  const headingId = uid('video-result');
  const element = h(
    'article',
    {
      class: ['card', CARD_CLASS],
      'aria-labelledby': headingId,
      'data-testid': `${testId}-result`,
    },
    h(
      'div',
      { class: 'card-body vstack gap-2' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-baseline gap-2' },
        h(
          `h${options.headingLevel ?? 3}`,
          { class: 'h6 mb-0 text-break me-auto', id: headingId },
          title,
        ),
        metaLine,
      ),
      player.element,
      options.extra,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        exportMenu({
          filename: stem,
          formats: [
            {
              label: own.toUpperCase(),
              extension: own,
              icon: 'file-earmark-play',
              build: () => blob,
            },
          ],
          resultIds: () => [handle.result.id, ...(options.covers?.() ?? [])],
          testId: `${testId}-download`,
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            'data-focus-key': `video-send:${handle.result.id}`,
            'data-testid': `${testId}-send`,
            onclick: () => ui.sendTo([{ kind: 'file', blob, name }]),
          },
          icon('send'),
          'Send to…',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
            'aria-label': `Remove ${title}`,
            'data-focus-key': removeKey,
            'data-testid': `${testId}-remove`,
            onclick: () => void removeByUser(),
          },
          icon('trash'),
          'Remove',
        ),
      ),
    ),
  );
  const removal = resultRemoval({
    element,
    cardClass: CARD_CLASS,
    removeKey,
    handle,
    title,
    noun: 'video',
    testId,
    beforeRemove: options.beforeRemove,
    onRemove: options.onRemove,
    focusFallback: options.focusFallback,
    dispose: () => player.dispose(),
  });
  const removeByUser = (): Promise<void> => removal.removeByUser();

  return { element, handle, player, remove: () => removal.remove() };
}
