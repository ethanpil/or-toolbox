/**
 * `referencePicker()`: reference images a tool sends to guide a model (`input_references`). A heading with a
 * count, small thumbnails with Remove buttons, a drop zone while there is room, and a note on the model's
 * limits. Files come from the drop zone itself and from the tool through `add()`: page-wide drop and paste
 * (`onFiles`), Send to… (`onReceive`), a result's "Use as reference".
 *
 * ```ts
 * const references = referencePicker({ ui: ctx.ui, max: 0, testId: 'imagegen' });
 * ui.input.append(references.element);
 * references.onChange(() => void ui.refreshEstimate());
 * // when the model's limits are known (and on every model change):
 * references.setLimits({ min: limits.min, max: limits.max, owner: controls.name });
 * // onFiles: (files) => references.add(files)
 * // onReceive: (items) => references.add(items.flatMap((item) => (item.kind === 'file' ? [item] : [])))
 * // in run(), before beginRun: if (references.problem()) { ui.status(references.problem()); references.focus(); }
 * const urls = await references.dataUrls({ maxSide: 2048, maxBytes: 4 * 1024 * 1024 });
 * ```
 *
 * - **Limits:** `add()` takes what fits under `max` and says what did not (`ui.status`); files `accepts` does
 *   not take are skipped and named. Lowering `max` (a model switch) keeps every reference and shows what to
 *   remove; `problem()` is that sentence (or "needs at least…") for the tool's Run check. With `max` 0 the
 *   picker is hidden while it holds nothing. A tool waits for its model's limits before it adds received files.
 * - **Thumbnails** are small copies (`imageThumbnail`, at most 144 px, drawn one at a time), never the original
 *   at full size; they are revoked with their reference. A picture that cannot be decoded is marked and kept,
 *   so the user decides; `dataUrls()` then names it.
 * - **Encoding:** `dataUrls()` encodes each reference once (`toDataUrl`: passed through when small enough,
 *   else scaled and re-encoded) and keeps that data URL until a call asks for another `maxSide`/`maxBytes`.
 *   References are encoded one at a time (a full-size decode each).
 * - **Focus:** adding through the drop zone keeps focus on its button (rebuilt with the same `data-focus-key`),
 *   or moves it to the newest Remove button when the zone goes (no room left); `add()` from the tool leaves
 *   focus where it is. Remove hands focus to the next reference's Remove button, else the previous one, else
 *   the drop zone's button, else `focusFallback()` (the picker hides when a model that takes none held some).
 *   `remove()`/`clear()` from code move focus only when it was on what they removed.
 *
 * Test ids (prefix `testId`, default `image`): `<p>-references` (the list), `<p>-reference` (an item),
 * `<p>-reference-remove`, `<p>-reference-count`, `<p>-reference-note`, `<p>-reference-drop` (the drop zone).
 */
import { InvalidInputError, userMessage } from '../../core/errors';
import { extensionForMime } from '../../core/files';
import { fitWithin, loadImage, resizeCanvas, toBlob, toDataUrl } from '../../core/media/image';
import { h, replace } from '../dom';
import { announce } from '../feedback/announce';
import { plural } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import type { ToolUi } from '../tool/types';
import { dropZone } from './drop-zone';
import { acceptsFile, describeAccept } from './file-types';

/** Thumbnails' longer side: 72 CSS px tiles, sharp on 2x screens. */
const THUMB_SIDE = 144;
const DEFAULT_ACCEPTS: readonly string[] = ['image/png', 'image/jpeg', 'image/webp'];
const DEFAULT_MAX_SIDE = 2048;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

export interface ReferenceImage {
  readonly id: string;
  readonly blob: Blob;
  /** File name; a Blob without one is `reference.<ext>`. */
  readonly name: string;
}

/** What `add()` takes: files, Blobs, or named Blobs (Send to… file items, a result's Blob). */
export type ReferenceInput = File | Blob | { readonly blob: Blob; readonly name: string };

export interface ReferenceLimits {
  /** Fewest references a run needs; default 0 (optional). */
  min?: number;
  /** Most references the model takes; 0 hides the picker while it holds none. */
  max: number;
  /** The model's name in notes ("FLUX.2 takes at most 4 reference images"); default "This model". */
  owner?: string;
}

export interface ReferenceEncoding {
  /** Longer side in pixels; larger references are scaled down. Default 2048. */
  maxSide?: number;
  /** Bytes per reference; larger ones are re-encoded smaller. Default 4 MiB. */
  maxBytes?: number;
}

export interface ReferencePickerOptions extends ReferenceLimits {
  /** `ctx.ui` (or just `status`): says what did not fit or was skipped. */
  ui: Pick<ToolUi, 'status'>;
  /** MIME types taken; default PNG, JPEG and WebP. */
  accepts?: readonly string[];
  /** Heading; default "Reference images". */
  label?: string;
  /** Heading level; default 3. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** The drop zone's second line; default derived from `accepts`. */
  hint?: string;
  /** Where focus goes when the last reference goes and the picker hides (a model that takes none). */
  focusFallback?: () => HTMLElement | null | undefined;
  testId?: string;
}

export interface ReferencePicker {
  readonly element: HTMLElement;
  /** Adds what fits under `max` (in order) and returns the references made; says what did not fit. */
  add(items: readonly ReferenceInput[]): ReferenceImage[];
  remove(id: string): void;
  clear(): void;
  /** The references, in order. */
  references(): ReferenceImage[];
  /** Each reference as a `data:` URL for upload, in order; cached per reference and encoding. */
  dataUrls(encoding?: ReferenceEncoding): Promise<string[]>;
  /** The model's limits (on every model change); omitted `min`/`owner` are back to their defaults. */
  setLimits(limits: ReferenceLimits): void;
  /** Why a run cannot send the references now ("needs at least 1…", "remove 2"), or null. */
  problem(): string | null;
  /** Focuses where `problem()` is fixed: the first Remove button when there are too many, else the drop zone. */
  focus(): boolean;
  /** Called after every add, remove and clear; returns the unsubscribe. */
  onChange(listener: (references: readonly ReferenceImage[]) => void): () => void;
}

/** Why `count` references do not suit these limits, or null. */
export function referenceProblem(count: number, limits: ReferenceLimits): string | null {
  const owner = limits.owner ?? 'This model';
  const min = limits.min ?? 0;
  if (limits.max === 0) {
    return count > 0
      ? `${owner} does not take reference images; remove them or choose another model.`
      : null;
  }
  if (count < min) return `${owner} needs at least ${plural(min, 'reference image')}.`;
  if (count > limits.max) {
    return `${owner} takes at most ${plural(limits.max, 'reference image')}; remove ${count - limits.max}.`;
  }
  return null;
}

/** The limits note under the picker: the problem, else what the model takes. */
function limitsNote(count: number, limits: Required<ReferenceLimits>): string {
  const { min, max, owner } = limits;
  const problem = referenceProblem(count, limits);
  if (problem || max === 0) return problem ?? '';
  if (count >= max) return `That is as many as ${owner} takes.`;
  if (min > 0) {
    return min === max
      ? `${owner} needs ${plural(min, 'reference image')}.`
      : `${owner} needs ${min} to ${max} reference images.`;
  }
  return `Optional. ${owner} takes ${max === 1 ? 'one reference image' : `up to ${max} reference images`}.`;
}

/**
 * A small copy of an image for a thumbnail: at most `maxSide` pixels on its longer side (WebP, PNG where the
 * browser cannot write WebP). An image already that small is returned as it is.
 */
export async function imageThumbnail(blob: Blob, maxSide = THUMB_SIDE): Promise<Blob> {
  const source = await loadImage(blob);
  try {
    const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
    const height = 'naturalWidth' in source ? source.naturalHeight : source.height;
    if (width <= maxSide && height <= maxSide) return blob;
    const size = fitWithin(width, height, maxSide);
    return await toBlob(resizeCanvas(source, size.width, size.height), {
      type: 'image/webp',
      quality: 0.8,
    });
  } finally {
    if ('close' in source) source.close();
  }
}

interface Entry {
  readonly reference: ReferenceImage;
  readonly item: HTMLLIElement;
  readonly tile: HTMLElement;
  readonly image: HTMLImageElement;
  readonly removeButton: HTMLButtonElement;
  thumbUrl: string | null;
  unreadable: boolean;
  /** The data URL for one encoding (`maxSide:maxBytes`). */
  encoded: { key: string; url: Promise<string> } | null;
}

export function referencePicker(options: ReferencePickerOptions): ReferencePicker {
  const accepts = options.accepts ?? DEFAULT_ACCEPTS;
  const testId = options.testId ?? 'image';
  let limits: Required<ReferenceLimits> = {
    min: options.min ?? 0,
    max: options.max,
    owner: options.owner ?? 'This model',
  };
  const entries: Entry[] = [];
  const listeners = new Set<(references: readonly ReferenceImage[]) => void>();

  const headingId = uid('references');
  const count = h('span', {
    class: 'small text-body-secondary',
    'data-testid': `${testId}-reference-count`,
  });
  const list = h('ul', {
    class: 'list-unstyled d-flex flex-wrap gap-3 mb-0 empty-hidden',
    'aria-labelledby': headingId,
    'data-testid': `${testId}-references`,
  });
  const zoneSlot = h('div');
  const note = h('div', { class: 'form-text mt-0', 'data-testid': `${testId}-reference-note` });
  const element = h(
    'section',
    { class: 'd-flex flex-column gap-2', 'aria-labelledby': headingId },
    h(
      'div',
      { class: 'd-flex align-items-baseline gap-2' },
      h(
        `h${options.headingLevel ?? 3}`,
        { id: headingId, class: 'form-label fw-semibold fs-6 mb-0 me-auto' },
        options.label ?? 'Reference images',
      ),
      count,
    ),
    list,
    zoneSlot,
    note,
  );

  const references = (): ReferenceImage[] => entries.map((entry) => entry.reference);
  const emit = (): void => {
    const now = references();
    for (const listener of listeners) listener(now);
  };
  const zoneButton = (): HTMLButtonElement | null => zoneSlot.querySelector('button');

  // --- drawing -----------------------------------------------------------------------------------------------
  /** The drop zone's look; it is rebuilt only when this changes (`replace` keeps focus on its button). */
  let zoneShape: string | null = null;
  const drawZone = (): void => {
    const room = limits.max - entries.length;
    const optional = limits.min === 0 ? ' (optional)' : '';
    const label =
      room > 1 ? `Drop reference images${optional}` : `Drop a reference image${optional}`;
    const shape = room > 0 ? label : null;
    if (shape === zoneShape) return;
    zoneShape = shape;
    replace(
      zoneSlot,
      room > 0
        ? dropZone({
            accept: accepts,
            multiple: room > 1,
            compact: true,
            label,
            hint: options.hint,
            focusKey: 'reference-drop',
            testId: `${testId}-reference-drop`,
            onFiles: (files) => void add(files),
          })
        : null,
    );
  };

  /** Everything that depends on the count and the limits; the items themselves are added and removed in place. */
  const sync = (): void => {
    entries.forEach((entry, index) => {
      const { name } = entry.reference;
      entry.tile.setAttribute(
        'aria-label',
        `Reference ${index + 1}: ${name}${entry.unreadable ? ' (cannot be read)' : ''}`,
      );
      entry.removeButton.setAttribute('aria-label', `Remove reference ${index + 1}, ${name}`);
    });
    count.textContent = limits.max > 0 ? `${entries.length} of ${limits.max}` : '';
    note.textContent = limitsNote(entries.length, limits);
    element.hidden = limits.max === 0 && entries.length === 0;
    drawZone();
  };

  /** Thumbnails are drawn one at a time: each needs a full-size decode. */
  let thumbnails: Promise<void> = Promise.resolve();
  const drawThumbnail = (entry: Entry): void => {
    thumbnails = thumbnails.then(async () => {
      if (!entries.includes(entry)) return;
      try {
        const small = await imageThumbnail(entry.reference.blob);
        if (!entries.includes(entry)) return;
        entry.thumbUrl = URL.createObjectURL(small);
        entry.image.src = entry.thumbUrl;
        entry.image.hidden = false;
      } catch {
        if (!entries.includes(entry)) return;
        entry.unreadable = true;
        entry.tile.append(icon('exclamation-triangle', 'text-warning-emphasis'));
        sync();
      }
    });
  };

  const forget = (entry: Entry): void => {
    if (entry.thumbUrl) URL.revokeObjectURL(entry.thumbUrl);
    entry.thumbUrl = null;
    entry.encoded = null;
    entry.item.remove();
  };

  /** After a removal at `index`: the next Remove button, the previous one, the drop zone, the fallback. */
  const focusAfterRemoval = (index: number): void => {
    const target = (entries[index] ?? entries[index - 1])?.removeButton ?? zoneButton();
    if (target && !element.hidden) target.focus();
    else options.focusFallback?.()?.focus();
  };

  // --- changes -----------------------------------------------------------------------------------------------
  const toReference = (input: ReferenceInput): ReferenceImage => {
    const id = uid('reference');
    if (!(input instanceof Blob)) return { id, blob: input.blob, name: input.name };
    const name =
      input instanceof File ? input.name : `reference.${extensionForMime(input.type) ?? 'png'}`;
    return { id, blob: input, name };
  };

  const add = (items: readonly ReferenceInput[]): ReferenceImage[] => {
    const incoming = items.map(toReference);
    const usable = incoming.filter((reference) =>
      acceptsFile({ type: reference.blob.type, name: reference.name }, accepts),
    );
    const room = Math.max(0, limits.max - entries.length);
    const taken = usable.slice(0, room);
    const hadFocus = element.contains(document.activeElement);
    for (const reference of taken) {
      const image = h('img', { alt: '', hidden: true, decoding: 'async' });
      const tile = h('div', { class: 'or-ref-thumb', role: 'img' }, image);
      const entry: Entry = {
        reference,
        tile,
        image,
        removeButton: h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-light border or-ref-remove',
            'data-focus-key': `reference-remove:${reference.id}`,
            'data-testid': `${testId}-reference-remove`,
            onclick: () => removeEntry(entry, true),
          },
          icon('x-lg'),
        ),
        item: h('li', { class: 'or-ref-item', 'data-testid': `${testId}-reference` }),
        thumbUrl: null,
        unreadable: false,
        encoded: null,
      };
      entry.item.append(tile, entry.removeButton);
      entries.push(entry);
      list.append(entry.item);
      drawThumbnail(entry);
    }
    sync();
    // The drop zone went (no room left) while it had focus: the newest reference takes it.
    if (hadFocus && !element.contains(document.activeElement)) entries.at(-1)?.removeButton.focus();

    const messages: string[] = [];
    const first = taken[0];
    if (taken.length < usable.length) {
      messages.push(
        taken.length > 0
          ? `Added ${plural(taken.length, 'reference image')}; ${usable.length - taken.length} did not fit.`
          : limits.max === 0
            ? `${limits.owner} does not take reference images.`
            : `${limits.owner} takes at most ${plural(limits.max, 'reference image')}.`,
      );
    } else if (first) {
      messages.push(
        taken.length === 1
          ? `Added ${first.name} as a reference image.`
          : `Added ${plural(taken.length, 'reference image')}.`,
      );
    }
    const skipped = incoming.length - usable.length;
    if (skipped > 0) {
      messages.push(
        `Skipped ${plural(skipped, 'file')}: reference images can be ${describeAccept(accepts)}.`,
      );
    }
    if (skipped > 0 || taken.length < usable.length) options.ui.status(messages.join(' '));
    else if (messages[0]) announce(messages[0]);
    if (taken.length > 0) emit();
    return taken;
  };

  /** `byUser`: its Remove button (announced, focus always handed on); else focus moves only if it was on it. */
  const removeEntry = (entry: Entry, byUser: boolean): void => {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    const hadFocus = entry.item.contains(document.activeElement);
    entries.splice(index, 1);
    forget(entry);
    sync();
    if (byUser) announce(`Removed reference ${index + 1}.`);
    if (byUser || hadFocus) focusAfterRemoval(index);
    emit();
  };

  const clear = (): void => {
    if (entries.length === 0) return;
    const hadFocus = list.contains(document.activeElement);
    for (const entry of entries.splice(0)) forget(entry);
    sync();
    if (hadFocus) focusAfterRemoval(0);
    emit();
  };

  const encode = (
    entry: Entry,
    index: number,
    maxSide: number,
    maxBytes: number,
  ): Promise<string> => {
    const key = `${maxSide}:${maxBytes}`;
    if (entry.encoded?.key !== key) {
      const encoded = {
        key,
        url: toDataUrl(entry.reference.blob, { maxDimension: maxSide, maxBytes }),
      };
      entry.encoded = encoded;
      // A failure is not kept: the next call tries again.
      encoded.url.catch(() => {
        if (entry.encoded === encoded) entry.encoded = null;
      });
    }
    return entry.encoded.url.catch((error: unknown) => {
      const reason = userMessage(error).replace(/\.$/, '');
      throw new InvalidInputError(
        `Reference ${index + 1} (${entry.reference.name}) could not be read (${reason}). Remove it or choose another.`,
        { cause: error },
      );
    });
  };

  sync();
  return {
    element,
    add,
    remove: (id) => {
      const entry = entries.find((candidate) => candidate.reference.id === id);
      if (entry) removeEntry(entry, false);
    },
    clear,
    references,
    dataUrls: async (encoding = {}) => {
      const maxSide = encoding.maxSide ?? DEFAULT_MAX_SIDE;
      const maxBytes = encoding.maxBytes ?? DEFAULT_MAX_BYTES;
      const urls: string[] = [];
      for (const [index, entry] of [...entries].entries()) {
        urls.push(await encode(entry, index, maxSide, maxBytes));
      }
      return urls;
    },
    setLimits: (next) => {
      const hadFocus = element.contains(document.activeElement);
      limits = { min: next.min ?? 0, max: next.max, owner: next.owner ?? 'This model' };
      sync();
      if (hadFocus && !element.contains(document.activeElement)) {
        const last = entries.at(-1)?.removeButton;
        if (last && !element.hidden) last.focus();
        else options.focusFallback?.()?.focus();
      }
    },
    problem: () => referenceProblem(entries.length, limits),
    focus: () => {
      const target =
        entries.length > limits.max
          ? entries[0]?.removeButton
          : (zoneButton() ?? entries[0]?.removeButton);
      if (!target || element.hidden) return false;
      target.focus();
      return document.activeElement === target;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
