/**
 * `imageResultCard()`: one image result of a tool (a generated image, an edited version, an isolated product
 * photo) as a card with the image viewer, a Download menu, Send to…, the tool's own actions and Remove. The
 * image is registered with the leave guard through `ui.addResult`, so it counts as not downloaded until the
 * user saves it in some format. The image counterpart of `audioResultCard()`.
 *
 * Downloads: the image itself is always offered as it is (its format is `name`'s extension, else its type);
 * every entry of `formats` that differs from it is converted through a canvas when chosen (JPEG is flattened
 * onto white, since it has no transparency). A PNG with `formats: ['png', 'jpg', 'webp']` offers PNG (as it
 * is), JPG and WEBP (converted). An SVG is offered as PNG and as a sanitized SVG (`sanitizeSvg`: no scripts,
 * no `foreignObject`, no external links), never as the model sent it. A conversion checks what the browser actually
 * wrote: one that cannot encode a format (Safari writes PNG when asked for WebP) saves nothing, says so, and
 * that format leaves the menu of every image card on the page (and of cards made later).
 *
 * Remove (`resultRemoval()`, shared with the audio and video cards) asks `beforeRemove`, by default a confirmation
 * while the image is not downloaded, then drops the result (`handle.remove()`), disposes the viewer,
 * detaches the card, announces it and calls `onRemove`. Then, unless `onRemove` moved focus itself, focus goes
 * to the Remove button of the next image card on the page (else the previous one), else to `focusFallback()`,
 * asked only now so it can return what `onRemove` showed (an empty state). `remove()` drops the card from code,
 * without asking, announcing or calling `onRemove`, and moves focus only when it was inside the card.
 *
 * ```ts
 * const card = imageResultCard({
 *   ui: ctx.ui,
 *   blob,
 *   name: 'lighthouse-1.png',
 *   meta: ['1024 × 1024', 'seed 42', formatBytes(blob.size)],
 *   formats: ['png', 'jpg', 'webp'],
 *   actions: [{ label: 'Variations', icon: 'shuffle', onClick: () => vary(image) }],
 *   onRemove: () => showEmpty(),
 *   testId: 'imagegen',
 * });
 * gallery.prepend(card.element);
 * ```
 *
 * `viewer: false` leaves the image out (for a page that already shows it large, such as an editor's canvas):
 * the card is then the image's heading, downloads, Send to…, actions and Remove.
 */
import { InvalidInputError } from '../../core/errors';
import { extensionForMime } from '../../core/files';
import { loadImage, toBlob } from '../../core/media/image';
import { type Child, h } from '../dom';
import { markPresented } from '../feedback/errors';
import { toast } from '../feedback/toast';
import { icon } from '../icon';
import { uid } from '../id';
import type { ResultHandle, ToolUi } from '../tool/types';
import { type ExportFormat, exportMenu } from './export-menu';
import { type ImageViewer, imageViewer } from './image-viewer';
import { resultRemoval } from './result-removal';
import { sanitizeSvg } from './sanitize-svg';

export type ImageFormat = 'png' | 'jpg' | 'webp';

const MIME: Record<ImageFormat, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};
/** JPEG and WebP quality for conversions. */
const QUALITY = 0.92;

export interface ImageResultAction {
  /** Button text, e.g. "Variations". */
  label: string;
  /** Bootstrap Icons name. */
  icon?: string;
  /** Accessible name when the text alone is ambiguous on a page of cards ("Make variations of image 2"). */
  ariaLabel?: string;
  onClick: () => void;
  testId?: string;
}

export interface ImageResultCardOptions {
  /** `ctx.ui` (or just these two members): the image is registered with `addResult`; Send to… opens `sendTo`. */
  ui: Pick<ToolUi, 'addResult' | 'sendTo'>;
  blob: Blob;
  /** File name with its extension (`lighthouse-1.png`): the download name, the default heading and alt text. */
  name: string;
  /** The line beside the heading, joined with " · "; empty entries are skipped (size, seed, model…). */
  meta: readonly (string | null | undefined | false)[];
  /** Conversions offered besides the image itself; one equal to the image's own format is the file as it is. */
  formats: readonly ImageFormat[];
  /** Called after the user removed the card with its Remove button (not after `remove()` from code). */
  onRemove: () => void;
  /** The tool's own buttons, after Send to… (Variations, Use as reference, Edit…). */
  actions?: readonly ImageResultAction[];
  /**
   * Asked before Remove removes anything; false keeps the card. Default: while the image is not downloaded, a
   * confirmation naming it (`confirmUndownloaded`); `() => true` removes without asking.
   */
  beforeRemove?: () => boolean | Promise<boolean>;
  /** Where focus goes after a removal when no other image card is left on the page. */
  focusFallback?: () => HTMLElement | null | undefined;
  /** Heading text; default `name`. */
  title?: string;
  /** Heading level; default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** The image's alt text; default the title. */
  alt?: string;
  /** Show the image viewer (default true). */
  viewer?: boolean;
  /** Content between the image and the buttons (a note, a prompt). */
  extra?: Child;
  /**
   * Test id prefix: `<p>-result`, `<p>-result-meta`, `<p>-viewer`, `<p>-download`, `<p>-send`, `<p>-remove`.
   * Default `image`.
   */
  testId?: string;
}

export interface ImageResultCard {
  readonly element: HTMLElement;
  /** The leave-guard registration (`handle.result.downloaded` says whether it was saved). */
  readonly handle: ResultHandle;
  /** The viewer, or null with `viewer: false`. */
  readonly viewer: ImageViewer | null;
  /** Removes the card from code (result, viewer, element); `onRemove` is not called. Safe to call twice. */
  remove(): void;
}

/** Marks image cards on the page, so a card that goes can hand focus to a neighbour. */
const CARD_CLASS = 'or-image-result';
/** Each live card: how it redraws its Download menu. */
const liveCards = new WeakMap<Element, { refreshFormats: () => void }>();
/** Formats this browser turned out not to encode (Safari writes PNG for WebP); no card offers them again. */
const unencodable = new Set<ImageFormat>();

/** Focus fell to the page (its element was removed, or nothing has it). */
function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

const cannotEncode = (format: ImageFormat): InvalidInputError =>
  new InvalidInputError(
    `This browser cannot save ${format.toUpperCase()} images. Choose another format.`,
  );

/** The format an image Blob is in, by name first, then by type. */
function ownFormat(name: string, type: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (extension) return extension === 'jpeg' ? 'jpg' : extension;
  const fromType = extensionForMime(type);
  return fromType === 'jpeg' ? 'jpg' : (fromType ?? 'png');
}

/**
 * Re-encodes an image in another format through a canvas. Throws an `InvalidInputError` when the browser writes
 * another format than asked (Safari's canvas writes PNG for WebP), and from then on for that format at once.
 */
export async function convertImage(blob: Blob, format: ImageFormat): Promise<Blob> {
  if (unencodable.has(format)) throw cannotEncode(format);
  const source = await loadImage(blob);
  let encoded: Blob;
  try {
    encoded = await toBlob(source, {
      type: MIME[format],
      ...(format === 'png' ? {} : { quality: QUALITY }),
    });
  } finally {
    if ('close' in source) source.close();
  }
  if (encoded.type !== MIME[format]) {
    unencodable.add(format);
    throw cannotEncode(format);
  }
  return encoded;
}

export function imageResultCard(options: ImageResultCardOptions): ImageResultCard {
  const { ui, blob, name } = options;
  const testId = options.testId ?? 'image';
  const handle = ui.addResult({ kind: 'image', name, blob });
  const title = options.title ?? name;
  const viewer =
    options.viewer === false
      ? null
      : imageViewer({ blob, alt: options.alt ?? title, testId: `${testId}-viewer` });

  const own = ownFormat(name, blob.type);
  // An SVG opened from disk runs its scripts and loads its links: it is offered as a PNG first, and as an SVG
  // only once sanitized. The registered result becomes the clean file as soon as it is ready, so the leave
  // guard's "Download all" saves that one too.
  const svg = own === 'svg' || blob.type === 'image/svg+xml';
  const clean: Promise<Blob> | null = svg
    ? sanitizeSvg(blob).then((safe) => {
        handle.result.blob = safe;
        return safe;
      })
    : null;
  clean?.catch(() => undefined); // a failure is reported when the user downloads
  const stem = /\.[a-z0-9]+$/i.test(name) ? name.replace(/\.[a-z0-9]+$/i, '') : name;

  /** A conversion; one the browser cannot encode says so once and leaves every card's menu. */
  const convert = async (to: ImageFormat): Promise<Blob> => {
    try {
      return await convertImage(clean ? await clean : blob, to);
    } catch (error) {
      if (!unencodable.has(to)) throw error;
      toast({ variant: 'warning', message: cannotEncode(to).message });
      for (const card of document.querySelectorAll(`.${CARD_CLASS}`)) {
        if (card !== element) liveCards.get(card)?.refreshFormats();
      }
      refreshFormats(true);
      markPresented(error); // the toast above said it; the menu's error handler stays quiet
      throw error;
    }
  };
  const downloads = (): ExportFormat[] => {
    /** `to: null` is the file as it is (an SVG: sanitized). */
    const choices: { extension: string; to: ImageFormat | null }[] = svg
      ? [
          ...(unencodable.has('png') ? [] : [{ extension: 'png', to: 'png' as const }]),
          { extension: 'svg', to: null },
        ]
      : options.formats
          .filter((to) => to === own || !unencodable.has(to))
          .map((to) => ({ extension: to, to: to === own ? null : to }));
    if (!choices.some((choice) => choice.to === null))
      choices.unshift({ extension: own, to: null });
    return choices.map(({ extension, to }) => ({
      label: extension.toUpperCase(),
      extension,
      icon: 'file-earmark-image',
      build: () => (to ? convert(to) : (clean ?? blob)),
    }));
  };
  const menu = exportMenu({
    filename: stem,
    formats: downloads(),
    resultIds: () => [handle.result.id],
    testId: `${testId}-download`,
  });
  /** Redraws the menu without the formats found unencodable; `keepFocus` puts lost focus back on its button. */
  const refreshFormats = (keepFocus = false): void => {
    const hadFocus = keepFocus && (focusLost() || menu.contains(document.activeElement));
    menu.update(downloads());
    if (hadFocus && !menu.contains(document.activeElement)) {
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  };

  const removeKey = `image-remove:${handle.result.id}`;
  const headingId = uid('image-result');
  const meta = options.meta.filter(Boolean).join(' · ');
  const actionButton = (action: ImageResultAction): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'aria-label': action.ariaLabel,
        'data-focus-key': `image-action:${handle.result.id}:${action.label}`,
        'data-testid': action.testId,
        onclick: action.onClick,
      },
      action.icon ? icon(action.icon) : null,
      action.label,
    );

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
        meta
          ? h(
              'span',
              { class: 'small text-body-secondary', 'data-testid': `${testId}-result-meta` },
              meta,
            )
          : null,
      ),
      viewer?.element,
      options.extra,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        menu,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            'data-focus-key': `image-send:${handle.result.id}`,
            'data-testid': `${testId}-send`,
            onclick: () => ui.sendTo([{ kind: 'file', blob, name }]),
          },
          icon('send'),
          'Send to…',
        ),
        (options.actions ?? []).map(actionButton),
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
  liveCards.set(element, { refreshFormats: () => refreshFormats() });

  const removal = resultRemoval({
    element,
    cardClass: CARD_CLASS,
    removeKey,
    handle,
    title,
    noun: 'image',
    testId,
    beforeRemove: options.beforeRemove,
    onRemove: options.onRemove,
    focusFallback: options.focusFallback,
    dispose: () => {
      viewer?.dispose();
      liveCards.delete(element);
    },
  });
  const removeByUser = (): Promise<void> => removal.removeByUser();

  return { element, handle, viewer, remove: () => removal.remove() };
}
