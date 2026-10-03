/**
 * `documentInput()`: the input half of the document tools (OCR, Data extractor, Table extractor). Takes images and
 * PDFs (its drop zone, plus whatever the tool passes to `add()` from the page-wide drop/paste and Send to…), lists
 * them with thumbnails, lets the user choose pages per file (all, a range such as `1-3, 7`, or by toggling page
 * tiles), and turns the selection into per-page inputs for a run.
 *
 * ```ts
 * const docs = documentInput({ onChange: () => void ctx.ui.refreshEstimate() });
 * ctx.ui.input.append(docs.element);
 * // onFiles: (files) => void docs.add(files)
 * for (const ref of docs.selection()) {
 *   const page = await docs.loadPage(ref); // { fileName, pageNumber, imageDataUrl, text? }
 * }
 * ```
 *
 * Memory: nothing is rendered up front. `loadPage` renders one page when asked (tools call it inside their
 * concurrency pool); thumbnails are small JPEGs rendered two at a time, only for tiles that scroll into view, and
 * their object URLs are revoked when a file is removed. PDFs are opened through `src/core/media/pdf.ts` (dynamic
 * import) and at most two stay open; the others are closed and reopened on demand.
 */
import { InvalidInputError, userMessage } from '../../core/errors';
import { runPool } from '../../core/pool';
import { readAsDataUrl, formatBytes } from '../../core/files';
import type * as ImageModuleTypes from '../../core/media/image';
import type * as PdfModuleTypes from '../../core/media/pdf';
import type { PdfDocument } from '../../core/media/pdf';
import { focusKey, focusedKey, h, replace } from '../dom';
import { announce } from '../feedback/announce';
import { setFieldError } from '../feedback/field-error';
import { toast } from '../feedback/toast';
import { plural } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { dropZone } from './drop-zone';
import { fileMime } from './file-types';
import {
  allPages,
  describeSelection,
  formatPageRange,
  normalizePages,
  parsePageRange,
  togglePage,
} from './page-selection';

/** One page of one file, before anything is rendered. */
export interface PageRef {
  /** Stable id of the file inside this input. */
  fileId: string;
  fileName: string;
  /** 1-based. */
  pageNumber: number;
  /** Pages in the file (1 for an image). */
  pageCount: number;
  kind: 'image' | 'pdf';
}

/** What a run sends for one page. */
export interface PageInput extends PageRef {
  /** `data:` URL sized for upload (longest side at most `maxSide`). */
  imageDataUrl: string;
  /** The PDF's own text layer for this page, when it has one (empty for scans; absent for images). */
  text?: string;
}

export interface DocumentFile {
  id: string;
  file: File;
  name: string;
  kind: 'image' | 'pdf';
  pageCount: number;
  /** Selected pages, sorted. */
  selected: number[];
}

export interface DocumentInputOptions {
  /** MIME types the drop zone takes. Default PNG, JPEG, WebP and PDF. */
  accept?: readonly string[];
  /** Longest side, in pixels, of the images `loadPage` makes; a function is read on every call. Default 1600. */
  maxSide?: number | (() => number);
  /** Read the PDF text layer into `PageInput.text`. Default true. */
  withText?: boolean;
  /** Files or the page selection changed. */
  onChange?: () => void;
  /** Drop zone heading. */
  label?: string;
}

export interface DocumentInput {
  readonly element: HTMLElement;
  /** Adds files (images and PDFs; others are skipped with a toast). Resolves once every PDF has been read. */
  add(files: readonly File[]): Promise<void>;
  remove(fileId: string): void;
  clear(): void;
  files(): DocumentFile[];
  /** Selected pages in list order. */
  selection(): PageRef[];
  /** Pages in all listed files, selected or not. */
  totalPages(): number;
  /** The image (and text) of one page, sized for upload. */
  loadPage(ref: PageRef): Promise<PageInput>;
  /** A page as an image Blob for showing to the user (longest side `maxSide`, default 1400). */
  pageImage(ref: PageRef, maxSide?: number): Promise<Blob>;
  /** The original file behind a page (for whole-PDF requests). */
  file(fileId: string): File | undefined;
  /** Scrolls a page's tile (or its file) into view and focuses it. */
  reveal(ref: PageRef): void;
  /** Frees thumbnails and open PDFs. */
  dispose(): void;
}

const DEFAULT_ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const THUMB_WIDTH = 160;
const MAX_OPEN_PDFS = 2;
const THUMB_CONCURRENCY = 2;
/** Without IntersectionObserver (old browsers, jsdom) only this many tiles get a picture. */
const EAGER_TILES = 12;

type PdfModule = typeof PdfModuleTypes;
type ImageModule = typeof ImageModuleTypes;
let pdfModule: Promise<PdfModule> | undefined;
let imageModule: Promise<ImageModule> | undefined;
/** One import per module and page, retried after a failure (a flaky network must not stick). */
function loadPdfModule(): Promise<PdfModule> {
  pdfModule ??= import('../../core/media/pdf');
  pdfModule.catch(() => {
    pdfModule = undefined;
  });
  return pdfModule;
}
function loadImageModule(): Promise<ImageModule> {
  imageModule ??= import('../../core/media/image');
  imageModule.catch(() => {
    imageModule = undefined;
  });
  return imageModule;
}

/** Keeps a few PDFs open, closing the least recently used idle one beyond `max`. */
class PdfPool {
  private readonly entries = new Map<
    string,
    { doc: Promise<PdfDocument>; users: number; used: number; dropped: boolean }
  >();
  private clock = 0;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  async use<T>(id: string, file: Blob, work: (doc: PdfDocument) => Promise<T>): Promise<T> {
    let entry = this.entries.get(id);
    if (!entry) {
      const doc = loadPdfModule().then(({ openPdf }) => openPdf(file));
      entry = { doc, users: 0, used: 0, dropped: false };
      const created = entry;
      this.entries.set(id, created);
      doc.catch(() => {
        if (this.entries.get(id) === created) this.entries.delete(id);
      });
    }
    entry.users++;
    entry.used = ++this.clock;
    try {
      return await work(await entry.doc);
    } finally {
      entry.users--;
      if (entry.dropped && entry.users === 0)
        void entry.doc.then((doc) => doc.close()).catch(() => undefined);
      this.evict();
    }
  }

  drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.dropped = true;
    if (entry.users === 0) void entry.doc.then((doc) => doc.close()).catch(() => undefined);
  }

  dropAll(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  private evict(): void {
    while (this.entries.size > this.max) {
      let oldest: [string, number] | null = null;
      for (const [id, entry] of this.entries) {
        if (entry.users === 0 && (oldest === null || entry.used < oldest[1]))
          oldest = [id, entry.used];
      }
      if (!oldest) return;
      this.drop(oldest[0]);
    }
  }
}

/** A tiny FIFO of async tasks with a concurrency cap (thumbnails). */
function taskQueue(limit: number): {
  push: (task: () => Promise<void>) => void;
  clear: () => void;
} {
  const waiting: (() => Promise<void>)[] = [];
  let running = 0;
  const pump = (): void => {
    while (running < limit && waiting.length > 0) {
      const task = waiting.shift()!;
      running++;
      void task()
        .catch(() => undefined)
        .finally(() => {
          running--;
          pump();
        });
    }
  };
  return {
    push(task) {
      waiting.push(task);
      pump();
    },
    clear() {
      waiting.length = 0;
    },
  };
}

interface Entry extends DocumentFile {
  /** Object URLs of thumbnails by page. */
  thumbs: Map<number, string>;
  /** Thumbnails being rendered, so a re-render never starts a second one. */
  thumbJobs: Map<number, Promise<string>>;
  /** Tile grid open. */
  open: boolean;
  /** Last range text the user typed that did not parse (kept in the field). */
  draft: string | null;
  error: string | null;
  /** The drawn card's controls, so a selection change updates them in place (no rebuild, no scroll jump). */
  view?: { range: HTMLInputElement; tiles: Map<number, HTMLElement> };
}

function kindOf(file: File): 'image' | 'pdf' | null {
  const mime = fileMime(file);
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

export function documentInput(options: DocumentInputOptions = {}): DocumentInput {
  const accept = options.accept ?? DEFAULT_ACCEPT;
  const entries: Entry[] = [];
  const pdfs = new PdfPool(MAX_OPEN_PDFS);
  const thumbQueue = taskQueue(THUMB_CONCURRENCY);
  let pending = 0;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (items) => {
            for (const item of items) {
              if (!item.isIntersecting) continue;
              observer?.unobserve(item.target);
              const target = item.target as HTMLElement;
              const entry = entries.find((candidate) => candidate.id === target.dataset['fileId']);
              const page = Number(target.dataset['page']);
              if (entry && page) requestThumb(entry, page, target.querySelector('img'));
            }
          },
          { rootMargin: '200px' },
        )
      : null;

  const maxSide = (): number => {
    const value = typeof options.maxSide === 'function' ? options.maxSide() : options.maxSide;
    return value && value > 0 ? value : 1600;
  };

  // --- DOM -----------------------------------------------------------------------------------------------
  const count = h('span', { class: 'small text-body-secondary', 'data-testid': 'doc-count' });
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 ms-auto',
      'data-testid': 'doc-clear',
      onclick: () => {
        clear();
        announce('All files removed.');
      },
    },
    icon('x-lg'),
    'Remove all',
  );
  const toolbar = h(
    'div',
    { class: 'd-flex flex-wrap align-items-center gap-2' },
    count,
    clearButton,
  );
  const list = h('ul', {
    class: 'list-unstyled vstack gap-2 mb-0',
    'aria-label': 'Files',
    'data-testid': 'doc-files',
  });
  const zone = dropZone({
    accept,
    multiple: true,
    label: options.label ?? 'Drop images or PDFs here',
    onFiles: (files) => void add(files),
    testId: 'doc-drop-zone',
  });
  const element = h(
    'div',
    { class: 'vstack gap-3 or-doc-input', 'data-testid': 'document-input' },
    zone,
    toolbar,
    list,
  );

  // --- state changes -------------------------------------------------------------------------------------
  const changed = (announceIt = true): void => {
    renderCount();
    options.onChange?.();
    if (!announceIt) return;
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      announceTimer = null;
      announce(count.textContent ?? '');
    }, 400);
  };

  const renderCount = (): void => {
    count.textContent =
      pending > 0
        ? `Reading ${plural(pending, 'file')}…`
        : describeSelection(
            entries.map((entry) => ({ pageCount: entry.pageCount, selected: entry.selected })),
          );
    toolbar.hidden = entries.length === 0 && pending === 0;
    clearButton.hidden = entries.length === 0;
    zone.classList.toggle('or-drop-zone-compact', entries.length > 0);
  };

  const revoke = (entry: Entry): void => {
    for (const url of entry.thumbs.values()) URL.revokeObjectURL(url);
    entry.thumbs.clear();
  };

  // --- thumbnails ----------------------------------------------------------------------------------------
  const thumbUrl = (entry: Entry, page: number): Promise<string> => {
    const known = entry.thumbs.get(page);
    if (known) return Promise.resolve(known);
    if (typeof URL.createObjectURL !== 'function') {
      return Promise.reject(new InvalidInputError('This browser cannot show thumbnails.'));
    }
    if (entry.kind === 'image') {
      const url = URL.createObjectURL(entry.file);
      entry.thumbs.set(page, url);
      return Promise.resolve(url);
    }
    let job = entry.thumbJobs.get(page);
    if (!job) {
      job = new Promise<string>((resolve, reject) => {
        thumbQueue.push(async () => {
          try {
            if (!entries.includes(entry)) throw new InvalidInputError('Removed.');
            const blob = await pdfs.use(entry.id, entry.file, (doc) =>
              doc.renderPage(page, { maxWidth: THUMB_WIDTH, type: 'image/jpeg', quality: 0.7 }),
            );
            if (!entries.includes(entry)) throw new InvalidInputError('Removed.');
            const url = URL.createObjectURL(blob);
            entry.thumbs.set(page, url);
            resolve(url);
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new InvalidInputError('The thumbnail could not be drawn.', { cause: error }),
            );
          } finally {
            entry.thumbJobs.delete(page);
          }
        });
      });
      entry.thumbJobs.set(page, job);
    }
    return job;
  };

  const requestThumb = (entry: Entry, page: number, img: HTMLImageElement | null): void => {
    if (!img) return;
    thumbUrl(entry, page)
      .then((url) => {
        img.src = url;
      })
      .catch(() => undefined); // a missing thumbnail is not worth an error; the page itself still works
  };

  /** The card of a file, if it is drawn. */
  const cardOf = (fileId: string): HTMLElement | undefined =>
    [...list.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset['fileId'] === fileId,
    );

  // --- rendering -----------------------------------------------------------------------------------------
  const tile = (entry: Entry, page: number): HTMLElement => {
    const selected = entry.selected.includes(page);
    const img = h('img', { class: 'or-doc-page-img', alt: '', decoding: 'async' });
    const button = h(
      'button',
      {
        type: 'button',
        class: 'or-doc-page',
        'aria-pressed': String(selected),
        'aria-label': `Page ${page}`,
        'data-focus-key': `page:${entry.id}:${page}`,
        'data-testid': 'doc-page',
        dataset: { fileId: entry.id, page: String(page) },
        onclick: () => {
          entry.selected = togglePage(entry.selected, page);
          entry.draft = null;
          entry.error = null;
          markTile(button, entry.selected.includes(page));
          syncRange(entry);
          changed();
        },
      },
      img,
      h(
        'span',
        { class: 'or-doc-page-label' },
        icon(selected ? 'check-circle-fill' : 'circle', 'or-doc-page-check'),
        String(page),
      ),
    );
    const cached = entry.thumbs.get(page);
    if (cached) img.src = cached;
    else if (observer) observer.observe(button);
    else if (page <= EAGER_TILES) requestThumb(entry, page, img);
    return button;
  };

  /** Shows a tile as selected or not, in place. */
  const markTile = (tile: HTMLElement, selected: boolean): void => {
    if (tile.getAttribute('aria-pressed') === String(selected)) return;
    tile.setAttribute('aria-pressed', String(selected));
    tile
      .querySelector('.or-doc-page-check')
      ?.replaceWith(icon(selected ? 'check-circle-fill' : 'circle', 'or-doc-page-check'));
  };

  /** The range field follows the selection (unless the user is mid-way through a bad range). */
  const syncRange = (entry: Entry): void => {
    if (!entry.view || entry.draft !== null) return;
    entry.view.range.value = formatPageRange(entry.selected);
  };

  /** A selection change drawn in place: every tile's state and the range field; the card is not rebuilt. */
  const syncSelection = (entry: Entry): void => {
    if (!entry.view) return;
    for (const [page, tile] of entry.view.tiles) markTile(tile, entry.selected.includes(page));
    syncRange(entry);
  };

  const card = (entry: Entry): HTMLElement => {
    const thumb = h('img', { class: 'or-doc-thumb', alt: '', decoding: 'async' });
    requestThumb(entry, 1, thumb);
    const rangeId = uid('doc-range');
    const gridId = uid('doc-pages');
    const nameId = uid('doc-name');
    const feedback = h('div', { class: 'invalid-feedback' });
    const isPdf = entry.kind === 'pdf';
    const tiles = new Map<number, HTMLElement>();

    const range = h('input', {
      id: rangeId,
      type: 'text',
      class: 'form-control form-control-sm or-doc-range',
      inputMode: 'numeric',
      autocomplete: 'off',
      spellcheck: false,
      value: entry.draft ?? formatPageRange(entry.selected),
      'aria-describedby': nameId,
      'data-focus-key': `range:${entry.id}`,
      'data-testid': 'doc-pages-input',
      onchange: () => applyRange(entry, range, feedback),
      onkeydown: (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          applyRange(entry, range, feedback);
        }
      },
    });
    if (entry.error) setFieldError(range, feedback, entry.error);

    const quick = (label: string, testId: string, pages: () => number[]): HTMLElement =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'aria-describedby': nameId,
          'data-focus-key': `${testId}:${entry.id}`,
          'data-testid': testId,
          onclick: () => {
            entry.selected = pages();
            entry.draft = null;
            entry.error = null;
            setFieldError(range, feedback, null);
            syncSelection(entry);
            changed();
          },
        },
        label,
      );

    const grid =
      isPdf && entry.open
        ? h(
            'div',
            {
              id: gridId,
              class: 'or-doc-pages',
              role: 'group',
              'aria-label': `Pages of ${entry.name}`,
            },
            allPages(entry.pageCount).map((page) => {
              const button = tile(entry, page);
              tiles.set(page, button);
              return button;
            }),
          )
        : null;
    entry.view = { range, tiles };

    return h(
      'li',
      { class: 'card or-doc-file', 'data-testid': 'doc-file', dataset: { fileId: entry.id } },
      h(
        'div',
        { class: 'card-body d-flex gap-3 p-2' },
        thumb,
        h(
          'div',
          { class: 'min-w-0 flex-grow-1 vstack gap-1' },
          h(
            'div',
            { class: 'd-flex align-items-start gap-2' },
            h(
              'div',
              { class: 'min-w-0 flex-grow-1' },
              h(
                'div',
                {
                  id: nameId,
                  class: 'fw-semibold text-truncate',
                  title: entry.name,
                  'data-testid': 'doc-name',
                },
                entry.name,
              ),
              h(
                'div',
                { class: 'small text-body-secondary' },
                `${isPdf ? 'PDF' : 'Image'} · ${plural(entry.pageCount, 'page')} · ${formatBytes(entry.file.size)}`,
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-outline-secondary',
                'aria-label': `Remove ${entry.name}`,
                title: 'Remove',
                'data-focus-key': `remove:${entry.id}`,
                'data-testid': 'doc-remove',
                onclick: () => {
                  remove(entry.id);
                  announce(`${entry.name} removed.`);
                },
              },
              icon('trash'),
            ),
          ),
          isPdf
            ? h(
                'div',
                { class: 'd-flex flex-wrap align-items-center gap-2' },
                h('label', { class: 'small text-body-secondary', htmlFor: rangeId }, 'Pages'),
                h('div', { class: 'or-doc-range-field' }, range, feedback),
                quick('All', 'doc-pages-all', () => allPages(entry.pageCount)),
                quick('None', 'doc-pages-none', () => []),
                h(
                  'button',
                  {
                    type: 'button',
                    class:
                      'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
                    'aria-expanded': String(entry.open),
                    'aria-controls': gridId,
                    'aria-describedby': nameId,
                    'data-focus-key': `grid:${entry.id}`,
                    'data-testid': 'doc-pages-toggle',
                    onclick: () => {
                      entry.open = !entry.open;
                      update(entry);
                    },
                  },
                  icon(entry.open ? 'chevron-up' : 'grid-3x3-gap'),
                  entry.open ? 'Hide pages' : 'Choose pages',
                ),
              )
            : null,
        ),
      ),
      grid,
    );
  };

  /** Redraws one file's card in place; the focused control gets focus back through its data-focus-key. */
  const update = (entry: Entry): void => {
    const old = cardOf(entry.id);
    if (!old) return;
    const fresh = card(entry);
    const key = focusedKey(old);
    unobserve(old);
    old.replaceWith(fresh);
    if (key) focusKey(fresh, key);
  };

  /** Stops watching the tiles of a card that is about to go. */
  const unobserve = (root: Element): void => {
    if (!observer) return;
    for (const button of root.querySelectorAll('.or-doc-page')) observer.unobserve(button);
  };

  const render = (): void => {
    unobserve(list);
    replace(
      list,
      entries.map((entry) => card(entry)),
    );
    renderCount();
  };

  const applyRange = (entry: Entry, input: HTMLInputElement, feedback: HTMLElement): void => {
    const result = parsePageRange(input.value, entry.pageCount);
    if (result.error !== undefined) {
      entry.draft = input.value;
      entry.error = result.error;
      setFieldError(input, feedback, result.error);
      return;
    }
    entry.draft = null;
    entry.error = null;
    setFieldError(input, feedback, null);
    if (result.pages.join() === entry.selected.join()) {
      input.value = formatPageRange(entry.selected);
      return;
    }
    entry.selected = result.pages;
    syncSelection(entry);
    changed();
  };

  // --- public API ----------------------------------------------------------------------------------------
  async function add(files: readonly File[]): Promise<void> {
    const usable = files.filter((file) => kindOf(file) !== null);
    const skipped = files.length - usable.length;
    if (skipped > 0) {
      toast({
        variant: 'warning',
        message: `Skipped ${plural(skipped, 'file')}: only images and PDFs are read.`,
      });
    }
    if (usable.length === 0) return;
    pending += usable.filter((file) => kindOf(file) === 'pdf').length;
    renderCount();
    const failures: string[] = [];
    // Two PDFs at a time (at most two stay open anyway), each opened once: its page count and the card's
    // thumbnail (page 1) are read together.
    await runPool(usable, 2, async (file) => {
      const kind = kindOf(file)!;
      const entry: Entry = {
        id: uid('doc'),
        file,
        name: file.name || (kind === 'pdf' ? 'document.pdf' : 'image'),
        kind,
        pageCount: 1,
        selected: [1],
        thumbs: new Map(),
        thumbJobs: new Map(),
        open: false,
        draft: null,
        error: null,
      };
      if (kind === 'pdf') {
        try {
          const first = await pdfs.use(entry.id, file, async (doc) => ({
            pages: doc.numPages,
            thumb: await doc
              .renderPage(1, { maxWidth: THUMB_WIDTH, type: 'image/jpeg', quality: 0.7 })
              .catch(() => null), // no thumbnail is fine; the page count is what matters
          }));
          entry.pageCount = first.pages;
          entry.selected = allPages(entry.pageCount);
          if (first.thumb && typeof URL.createObjectURL === 'function') {
            entry.thumbs.set(1, URL.createObjectURL(first.thumb));
          }
        } catch (error) {
          pdfs.drop(entry.id);
          failures.push(`${entry.name}: ${userMessage(error)}`);
          return;
        } finally {
          pending--;
        }
      }
      entries.push(entry);
    });
    // Keep the order the files were given in, after the ones already listed.
    const order = new Map(usable.map((file, index) => [file, index]));
    const before = entries.filter((entry) => !order.has(entry.file));
    const added = entries
      .filter((entry) => order.has(entry.file))
      .sort((a, b) => order.get(a.file)! - order.get(b.file)!);
    entries.splice(0, entries.length, ...before, ...added);
    render();
    if (failures.length > 0) {
      toast({
        variant: 'danger',
        title: 'Some files could not be read',
        message: failures.join(' '),
      });
    }
    if (added.length > 0) changed();
  }

  function remove(fileId: string): void {
    const index = entries.findIndex((entry) => entry.id === fileId);
    if (index < 0) return;
    const [entry] = entries.splice(index, 1);
    if (!entry) return;
    revoke(entry);
    pdfs.drop(entry.id);
    const focusNext = list.contains(document.activeElement);
    render();
    if (focusNext) {
      const next = entries[Math.min(index, entries.length - 1)];
      if (!next || !focusKey(list, `remove:${next.id}`))
        zone.querySelector<HTMLElement>('button')?.focus();
    }
    changed(false);
  }

  function clear(): void {
    for (const entry of entries) {
      revoke(entry);
      pdfs.drop(entry.id);
    }
    entries.length = 0;
    thumbQueue.clear();
    render();
    changed(false);
  }

  const find = (fileId: string): Entry => {
    const entry = entries.find((candidate) => candidate.id === fileId);
    if (!entry) throw new InvalidInputError('That file was removed from the list.');
    return entry;
  };

  const refOf = (entry: Entry, pageNumber: number): PageRef => ({
    fileId: entry.id,
    fileName: entry.name,
    pageNumber,
    pageCount: entry.pageCount,
    kind: entry.kind,
  });

  renderCount();

  return {
    element,
    add,
    remove,
    clear,
    files: () =>
      entries.map((entry) => ({
        id: entry.id,
        file: entry.file,
        name: entry.name,
        kind: entry.kind,
        pageCount: entry.pageCount,
        selected: [...entry.selected],
      })),
    selection: () =>
      entries.flatMap((entry) =>
        normalizePages(entry.selected, entry.pageCount).map((page) => refOf(entry, page)),
      ),
    totalPages: () => entries.reduce((sum, entry) => sum + entry.pageCount, 0),
    async loadPage(ref) {
      const entry = find(ref.fileId);
      if (entry.kind === 'image') {
        const { toDataUrl } = await loadImageModule();
        return {
          ...refOf(entry, 1),
          imageDataUrl: await toDataUrl(entry.file, { maxDimension: maxSide() }),
        };
      }
      const side = maxSide();
      const withText = options.withText ?? true;
      return pdfs.use(entry.id, entry.file, async (doc) => {
        const blob = await doc.renderPage(ref.pageNumber, {
          maxWidth: side,
          maxHeight: side,
          type: 'image/jpeg',
          quality: 0.85,
        });
        const text = withText ? await doc.pageText(ref.pageNumber) : undefined;
        return {
          ...refOf(entry, ref.pageNumber),
          imageDataUrl: await readAsDataUrl(blob),
          ...(text === undefined ? {} : { text }),
        };
      });
    },
    async pageImage(ref, side = 1400) {
      const entry = find(ref.fileId);
      if (entry.kind === 'image') return entry.file;
      return pdfs.use(entry.id, entry.file, (doc) =>
        doc.renderPage(ref.pageNumber, {
          maxWidth: side,
          maxHeight: side,
          type: 'image/jpeg',
          quality: 0.85,
        }),
      );
    },
    file: (fileId) => entries.find((entry) => entry.id === fileId)?.file,
    reveal(ref) {
      const entry = entries.find((candidate) => candidate.id === ref.fileId);
      if (!entry) {
        toast({ variant: 'warning', message: 'That file is no longer in the list.' });
        return;
      }
      if (entry.kind === 'pdf' && !entry.open) {
        entry.open = true;
        update(entry);
      }
      const fileCard = cardOf(entry.id);
      const target =
        (entry.kind === 'pdf'
          ? fileCard?.querySelector<HTMLElement>(`.or-doc-page[data-page="${ref.pageNumber}"]`)
          : fileCard?.querySelector<HTMLElement>(`[data-focus-key="remove:${entry.id}"]`)) ??
        fileCard;
      if (!target) return;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.focus({ preventScroll: true });
      const highlighted = entry.kind === 'pdf' ? target : fileCard;
      highlighted?.classList.add('is-revealed');
      setTimeout(() => highlighted?.classList.remove('is-revealed'), 2000);
    },
    dispose() {
      clear();
      observer?.disconnect();
      if (announceTimer) clearTimeout(announceTimer);
    },
  };
}

/**
 * A PNG page with a title and some lines of text, for the document tools' samples (`?sample=1`). `mono` lines
 * are drawn in a monospaced font, so columns padded with spaces line up as a table. Null where the browser
 * cannot draw (jsdom).
 */
export async function textImage(
  name: string,
  title: string,
  lines: readonly string[],
  options: { mono?: boolean } = {},
): Promise<File | null> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1000;
    canvas.height = 150 + lines.length * 44;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#111111';
    context.font = 'bold 36px sans-serif';
    context.fillText(title, 48, 72);
    context.font = options.mono ? '26px monospace' : '26px sans-serif';
    lines.forEach((line, index) => context.fillText(line, 48, 135 + index * 44));
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new File([blob], name, { type: 'image/png' }) : null;
  } catch {
    return null;
  }
}
