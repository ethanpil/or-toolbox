/**
 * `audioResultCard()`: one audio result of a tool (a recording, a joined speech file, a song) as a card with
 * the player, a Download menu, Send to… and Remove. The file is registered with the leave guard through
 * `ui.addResult`, so it counts as not downloaded until the user saves it in some format.
 *
 * Downloads: the file itself is always offered as it is (its format is `name`'s extension); every entry of
 * `formats` that differs from it is converted with `transcode()` when chosen (ffmpeg loads only then). An MP3
 * with `formats: ['mp3', 'wav']` offers MP3 (as it is) and WAV (converted); a WebM recording with `['wav']`
 * offers WEBM and WAV.
 *
 * Remove asks `beforeRemove` (if given), then drops the result (`handle.remove()`), disposes the player,
 * detaches the card, announces it and calls `onRemove`. Focus goes to the Remove button of the next audio card
 * on the page (else the previous one), else to `focusFallback()`. `remove()` does the same from code, without
 * asking, announcing or calling `onRemove`, and moves focus only when it was inside the card.
 *
 * ```ts
 * const card = audioResultCard({
 *   ui: ctx.ui,
 *   blob,
 *   name: 'speech.mp3',
 *   seconds,
 *   metaParts: [formatDuration(seconds), voice, formatBytes(blob.size)],
 *   formats: ['mp3', 'wav'],
 *   onRemove: () => showEmpty(),
 *   testId: 'tts',
 * });
 * list.prepend(card.element);
 * ```
 */
import { extensionForMime } from '../../core/files';
import { transcode, type TranscodeFormat } from '../../core/media/transcode';
import { disposeBootstrap } from '../bootstrap';
import { type Child, focusKey, h } from '../dom';
import { announce } from '../feedback/announce';
import { formatDuration } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import type { ResultHandle, ToolUi } from '../tool/types';
import { type AudioPlayer, audioPlayer } from './audio-player';
import { type ExportFormat, exportMenu } from './export-menu';

export interface AudioResultCardOptions {
  /** `ctx.ui` (or just these two members): the file is registered with `addResult`; Send to… opens `sendTo`. */
  ui: Pick<ToolUi, 'addResult' | 'sendTo'>;
  blob: Blob;
  /** File name with its extension (`speech.mp3`): the download name, the default heading, and used in labels. */
  name: string;
  /** Known length in seconds: the player does not measure it, and its label says it. */
  seconds?: number;
  /** Waveform peaks the tool already has (then nothing is decoded for the waveform). */
  peaks?: Float32Array;
  /** The line beside the heading, joined with " · "; empty entries are skipped (duration, voice, size…). */
  metaParts: readonly (string | null | undefined | false)[];
  /** Conversions offered besides the file itself; one equal to the file's own format is the file as it is. */
  formats: readonly TranscodeFormat[];
  /** Called after the user removed the card with its Remove button (not after `remove()` from code). */
  onRemove: () => void;
  /** Asked before Remove removes anything; false keeps the card (e.g. a "not downloaded yet" confirmation). */
  beforeRemove?: () => boolean | Promise<boolean>;
  /** Where focus goes after a removal when no other audio card is left on the page. */
  focusFallback?: () => HTMLElement | null | undefined;
  /** Heading text; default `name`. */
  title?: string;
  /** Heading level; default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Content between the player and the buttons (lyrics, a note). */
  extra?: Child;
  /** Test id prefix: `<p>-result`, `<p>-result-meta`, `<p>-player`, `<p>-download`, `<p>-send`, `<p>-remove`. Default `audio`. */
  testId?: string;
}

export interface AudioResultCard {
  readonly element: HTMLElement;
  /** The leave-guard registration (`handle.result.downloaded` says whether it was saved). */
  readonly handle: ResultHandle;
  readonly player: AudioPlayer;
  /** Removes the card from code (result, player, element); `onRemove` is not called. Safe to call twice. */
  remove(): void;
}

/** Marks audio cards on the page, so a card that goes can hand focus to a neighbour. */
const CARD_CLASS = 'or-audio-result';
/** Each live card's Remove button key. */
const removeKeys = new WeakMap<Element, string>();

/** The other audio cards on the page: the following ones nearest first, then the preceding ones nearest first. */
function neighbours(card: Element): Element[] {
  const cards = [...document.querySelectorAll(`.${CARD_CLASS}`)];
  const at = cards.indexOf(card);
  return at < 0 ? [] : [...cards.slice(at + 1), ...cards.slice(0, at).reverse()];
}

export function audioResultCard(options: AudioResultCardOptions): AudioResultCard {
  const { ui, blob, name, seconds } = options;
  const testId = options.testId ?? 'audio';
  const handle = ui.addResult({ kind: 'audio', name, blob });
  const player = audioPlayer({
    blob,
    label: seconds ? `${name}, ${formatDuration(seconds)}` : name,
    seconds,
    peaks: options.peaks,
    testId: `${testId}-player`,
  });

  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  const own = extension ?? extensionForMime(blob.type) ?? 'bin';
  const stem = extension ? name.slice(0, -extension.length - 1) : name;
  /** `to: null` is the file as it is. */
  const choices: { extension: string; to: TranscodeFormat | null }[] = options.formats.map(
    (to) => ({ extension: to, to: to === own ? null : to }),
  );
  if (!choices.some((choice) => choice.to === null)) choices.unshift({ extension: own, to: null });
  const formats: ExportFormat[] = choices.map(({ extension: ext, to }) => ({
    label: ext.toUpperCase(),
    extension: ext,
    icon: 'file-earmark-music',
    build: () => (to ? transcode(blob, to) : blob),
  }));

  const removeKey = `audio-remove:${handle.result.id}`;
  const headingId = uid('audio-result');
  const meta = options.metaParts.filter(Boolean).join(' · ');
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
          options.title ?? name,
        ),
        meta
          ? h(
              'span',
              { class: 'small text-body-secondary', 'data-testid': `${testId}-result-meta` },
              meta,
            )
          : null,
      ),
      player.element,
      options.extra,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        exportMenu({
          filename: stem,
          formats,
          resultIds: () => [handle.result.id],
          testId: `${testId}-download`,
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            'data-focus-key': `audio-send:${handle.result.id}`,
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
            'aria-label': `Remove ${name}`,
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
  removeKeys.set(element, removeKey);

  let removed = false;
  /** Drops the card; `moveFocus` false leaves focus alone unless it was inside the card. */
  const drop = (moveFocus: boolean): void => {
    if (removed) return;
    removed = true;
    const hadFocus = element.contains(document.activeElement);
    const next = neighbours(element);
    handle.remove();
    player.dispose();
    disposeBootstrap(element);
    removeKeys.delete(element);
    element.remove();
    if (!moveFocus && !hadFocus) return;
    for (const card of next) {
      const key = removeKeys.get(card);
      if (key !== undefined && focusKey(card, key)) return;
    }
    options.focusFallback?.()?.focus();
  };

  let asking = false;
  const removeByUser = async (): Promise<void> => {
    if (asking || removed) return;
    asking = true;
    try {
      if (options.beforeRemove && !(await options.beforeRemove())) return;
    } finally {
      asking = false;
    }
    if (removed) return;
    drop(true);
    announce(`Removed ${name}.`);
    options.onRemove();
  };

  return { element, handle, player, remove: () => drop(false) };
}
