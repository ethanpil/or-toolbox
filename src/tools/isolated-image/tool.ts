/**
 * Isolated image: product photos onto a pure white square. Each photo goes to an image-edit model (`POST
 * /images`, the photo as a data-URL reference plus a fixed instruction), two at a time inside one run per
 * Isolate press; the answer is then post-processed in the image worker (`isolateImage`: product box, square
 * with margin, near-white flood-filled to #FFFFFF from the edges, light sharpening, QA). The review shows a
 * before/after wipe and a side-by-side view per photo, with its own margin and threshold: changing those, or the
 * output settings, only re-runs the post-processing (no request). Results are `imageResultCard`s (leave guard,
 * Send to…, Remove) and download one by one or as a ZIP. The tool is promptless: the instruction is fixed, and
 * Prompts saves settings presets.
 */
import { InvalidInputError, isAbortError, userMessage } from '../../core/errors';
import { zipFiles } from '../../core/export/zip';
import { downloadBlob } from '../../core/files';
import { type Box, fitWithin, readImageSize } from '../../core/media/image';
import { isolateImage } from '../../core/media/image-async';
import type { RunHandle } from '../../core/types';
import { abortError, debounce, utcDay } from '../../core/util';
import { compareSlider, type CompareSlider } from '../../ui/components/compare-slider';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { type ImageResultCard, imageResultCard } from '../../ui/components/image-result-card';
import { modelPicker } from '../../ui/components/model-picker';
import { progressBar } from '../../ui/components/progress-bar';
import { imageThumbnail } from '../../ui/components/reference-picker';
import { switchField } from '../../ui/components/switch-field';
import { focusedKey, focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, formatEstimate, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { batchSummary, batchTitle, runItems } from '../../ui/tool/batch';
import type { ResultHandle, ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import { pendingOnly } from '../../ui/tool/runner';
import {
  appliedMargin,
  CONCURRENCY,
  FALLBACK_SETTINGS,
  type IsolateSettings,
  MARGIN_RANGE,
  MIN_JPG_MARGIN_PX,
  OUTPUT_FORMATS,
  OUTPUT_SIZES,
  type OutputFormat,
  outputName,
  processingKey,
  QUALITY_RANGE,
  readSettings,
  SEND_SIZES,
  SHARPEN_RANGE,
  THRESHOLD_RANGE,
} from './options';
import { qaLine, qaReport, type QaReport } from './qa';
import {
  decodeRaster,
  encodedBorderFlaws,
  encodeRaster,
  referenceDataUrl,
  samplePhoto,
} from './raster-io';
import { buildInstruction, buildRequest, editSupport } from './request';

/** Where a photo is in a run: waiting, at the model, being post-processed, or settled. */
type Phase = 'idle' | 'queued' | 'editing' | 'processing' | 'done' | 'failed' | 'stopped';

interface Processed {
  /** The `processingKey` it was made with. */
  key: string;
  blob: Blob;
  /** Its result card (leave guard, downloads, Send to…, Remove); a new name needs a new card. */
  card: ImageResultCard;
  /** `card.handle`, and the full image's object URL (the review); the grid shows `thumbUrl`. */
  handle: ResultHandle;
  url: string;
  thumbUrl: string;
  /** The card's own part: thumbnail, badges, reasons, redrawn in place. */
  extra: HTMLElement;
  qa: QaReport;
  /** The threshold and margin used (the margin raised for JPG; see `appliedMargin`). */
  threshold: number;
  margin: number;
  box: Box;
  source: { width: number; height: number };
  /** What the Blob is: its file name follows these, not settings changed since. */
  format: OutputFormat;
  size: number;
}

interface Photo {
  readonly key: string;
  readonly file: File;
  readonly name: string;
  /** Object URL of the original (the review's "before" side). */
  readonly url: string;
  /** Object URL of a small copy for the photo list and the grid, once made. */
  thumbUrl: string | null;
  /** Pixel size from the file's header (no decoding), once read: the estimate's answer size. */
  dims: { width: number; height: number } | null;
  phase: Phase;
  error: string | null;
  /** The model's answer (paid for), kept so the post-processing can run again without a request. */
  edited: Blob | null;
  model: string | null;
  /** The run that made `edited`: a replayed Retry skips photos the failed run already made. */
  editRun: string | null;
  /** Review choices for this photo; null follows the settings (the threshold: automatic). */
  margin: number | null;
  threshold: number | null;
  result: Processed | null;
  /** Post-processing running outside a run (a review or settings change). */
  job: { key: string; controller: AbortController } | null;
  /** The key whose post-processing failed, so the same settings are not tried again and again. */
  failedKey: string | null;
}

interface RunArg {
  keys: string[];
  /** Retry with another model. */
  model?: string;
}

const MAX_PHOTOS = 100;
/** Post-processing jobs in flight at once (decode, worker, encode); the worker itself does one at a time. */
const PROCESS_SLOTS = 2;
const RECONCILE_DELAY_MS = 350;
/** Thumbnail sides: the photo list shows 48 px, a grid card about 250 px (so twice its 144 for sharpness). */
const LIST_THUMB = 144;
const GRID_THUMB = 288;

const PHASE_TEXT: Partial<Record<Phase, string>> = {
  queued: 'Waiting',
  editing: 'Editing…',
  processing: 'Finishing…',
  failed: 'Failed',
  stopped: 'Not isolated',
};

/** A small first-come queue: at most `limit` jobs run, the rest wait (and leave the queue when aborted). */
function limiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> => {
    if (signal.aborted) throw abortError();
    if (active < limit) active += 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const start = (): void => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          const at = waiting.indexOf(start);
          if (at >= 0) waiting.splice(at, 1);
          reject(abortError());
        };
        waiting.push(start);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      release();
    }
  };
}

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  let settings: IsolateSettings = readSettings(ctx.options.get(), FALLBACK_SETTINGS);
  let photos: Photo[] = [];
  /** True while a run's requests are out (the runner's own flag lags while `run` returns). */
  let running = false;
  const limited = limiter(PROCESS_SLOTS);

  const inRun = (photo: Photo): boolean =>
    photo.phase === 'queued' || photo.phase === 'editing' || photo.phase === 'processing';
  const pending = (): Photo[] => photos.filter((photo) => !photo.result && !inRun(photo));
  const withResults = (): Photo[] => photos.filter((photo) => photo.result);

  // --- settings drawer ------------------------------------------------------------------------------------
  const ids = {
    size: uid('iso-size'),
    margin: uid('iso-margin'),
    threshold: uid('iso-threshold'),
    thresholdHelp: uid('iso-threshold-help'),
    amount: uid('iso-amount'),
    format: uid('iso-format'),
    quality: uid('iso-quality'),
    pattern: uid('iso-pattern'),
    patternHelp: uid('iso-pattern-help'),
    sendSize: uid('iso-send-size'),
    concurrency: uid('iso-concurrency'),
  };

  /** Applies a change from a control: validated, saved as the tool's options, and acted on. */
  const change = (patch: Partial<IsolateSettings>): void => {
    const before = settings;
    settings = readSettings(patch, settings);
    const saved: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof IsolateSettings)[]) saved[key] = settings[key];
    ctx.options.set(saved);
    syncControls();
    settingsChanged(before);
  };

  const numberInput = (
    id: string,
    range: { min: number; max: number },
    step: string,
    testId: string,
    commit: (value: number) => void,
  ): HTMLInputElement => {
    const input: HTMLInputElement = h('input', {
      id,
      type: 'number',
      class: 'form-control',
      min: String(range.min),
      max: String(range.max),
      step,
      inputMode: 'decimal',
      'data-testid': testId,
      onchange: () => {
        const value = Number(input.value);
        if (input.value.trim() === '' || !Number.isFinite(value)) syncControls();
        else commit(Math.min(range.max, Math.max(range.min, value)));
      },
    });
    return input;
  };

  const sizeSelect = h(
    'select',
    {
      id: ids.size,
      class: 'form-select',
      'data-testid': 'iso-size',
      onchange: () => change({ size: Number(sizeSelect.value) }),
    },
    OUTPUT_SIZES.map((value) => h('option', { value: String(value) }, `${value} × ${value} px`)),
  );
  const marginInput = numberInput(
    ids.margin,
    { min: MARGIN_RANGE.min * 100, max: MARGIN_RANGE.max * 100 },
    '0.5',
    'iso-margin-setting',
    (percent) => change({ margin: Math.round(percent * 10) / 1000 }),
  );
  const thresholdInput = numberInput(
    ids.threshold,
    THRESHOLD_RANGE,
    '1',
    'iso-threshold-setting',
    (value) => change({ whiteThreshold: Math.round(value) }),
  );
  thresholdInput.setAttribute('aria-describedby', ids.thresholdHelp);
  const sharpen = switchField({
    label: 'Sharpen',
    help: 'A light unsharp mask after resizing.',
    checked: settings.sharpen,
    testId: 'iso-sharpen',
    onChange: (checked) => change({ sharpen: checked }),
  });
  const amountInput = numberInput(ids.amount, SHARPEN_RANGE, '0.1', 'iso-sharpen-amount', (value) =>
    change({ sharpenAmount: Math.round(value * 10) / 10 }),
  );
  const shadow = switchField({
    label: 'Keep a soft shadow',
    help: 'Asks the model for a soft, natural shadow under the product. Off: flat white, no shadow.',
    checked: settings.shadow,
    testId: 'iso-shadow',
    onChange: (checked) => change({ shadow: checked }),
  });
  const formatSelect = h(
    'select',
    {
      id: ids.format,
      class: 'form-select',
      'data-testid': 'iso-format',
      onchange: () => {
        const format = OUTPUT_FORMATS.find((value) => value === formatSelect.value);
        if (format) change({ format });
      },
    },
    h('option', { value: 'jpg' }, 'JPG'),
    h('option', { value: 'png' }, 'PNG'),
  );
  const qualityInput = numberInput(ids.quality, QUALITY_RANGE, '1', 'iso-quality', (value) =>
    change({ jpegQuality: Math.round(value) }),
  );
  const patternInput: HTMLInputElement = h('input', {
    id: ids.pattern,
    type: 'text',
    class: 'form-control font-monospace',
    autocomplete: 'off',
    spellcheck: false,
    'aria-describedby': ids.patternHelp,
    'data-testid': 'iso-pattern',
    onchange: () =>
      change({ filenamePattern: patternInput.value.trim() || FALLBACK_SETTINGS.filenamePattern }),
  });
  const patternExample = h('span', { 'data-testid': 'iso-pattern-example' });
  const sendSizeSelect = h(
    'select',
    {
      id: ids.sendSize,
      class: 'form-select',
      'data-testid': 'iso-send-size',
      onchange: () => change({ sendSize: Number(sendSizeSelect.value) }),
    },
    SEND_SIZES.map((value) => h('option', { value: String(value) }, `${value} px`)),
  );
  const concurrencySelect = h(
    'select',
    {
      id: ids.concurrency,
      class: 'form-select',
      'data-testid': 'iso-concurrency',
      onchange: () => change({ concurrency: Number(concurrencySelect.value) }),
    },
    CONCURRENCY.map((value) => h('option', { value: String(value) }, plural(value, 'photo'))),
  );

  const field = (id: string, label: string, control: HTMLElement, help?: HTMLElement | string) =>
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: id }, label),
      control,
      typeof help === 'string' ? h('div', { class: 'form-text' }, help) : help,
    );

  ui.drawer.append(
    field(ids.size, 'Output size', sizeSelect, 'The square every result is made at.'),
    field(
      ids.margin,
      'Margin (%)',
      marginInput,
      `Empty white border on each side, as a share of the side. A JPG keeps at least ${MIN_JPG_MARGIN_PX} px (1.2% at 2000 px), so compression cannot tint its border; PNG keeps any margin.`,
    ),
    field(
      ids.threshold,
      'White threshold',
      thresholdInput,
      h(
        'div',
        { id: ids.thresholdHelp, class: 'form-text' },
        'Background this light (every channel, 0-255) becomes pure white, from the edges in, so white parts inside the product stay as they are. Where a photo’s own background is darker or noisy, the fill starts below it instead; the review shows the level used.',
      ),
    ),
    h('div', { class: 'vstack gap-2' }, sharpen.element, field(ids.amount, 'Amount', amountInput)),
    shadow.element,
    field(ids.format, 'Format', formatSelect),
    field(ids.quality, 'JPG quality', qualityInput),
    field(
      ids.pattern,
      'File names',
      patternInput,
      h(
        'div',
        { id: ids.patternHelp, class: 'form-text' },
        '{name} the photo’s name, {n} its position ({n:3} pads to 001), {ext} jpg or png, {size} the side in pixels. Example: ',
        patternExample,
      ),
    ),
  );
  ui.advanced('Requests').append(
    field(
      ids.sendSize,
      'Photo size sent to the model (longest side)',
      sendSizeSelect,
      'Larger keeps more detail; per-megapixel models also answer larger and cost more.',
    ),
    field(ids.concurrency, 'Photos edited at the same time', concurrencySelect),
  );

  const syncControls = (): void => {
    sizeSelect.value = String(settings.size);
    marginInput.value = String(Math.round(settings.margin * 1000) / 10);
    thresholdInput.value = String(settings.whiteThreshold);
    sharpen.input.checked = settings.sharpen;
    amountInput.value = String(settings.sharpenAmount);
    amountInput.disabled = !settings.sharpen;
    shadow.input.checked = settings.shadow;
    formatSelect.value = settings.format;
    qualityInput.value = String(settings.jpegQuality);
    qualityInput.disabled = settings.format !== 'jpg';
    patternInput.value = settings.filenamePattern;
    patternExample.textContent = outputName(settings.filenamePattern, {
      fileName: photos[0]?.name ?? 'shoe.jpg',
      n: 1,
      format: settings.format,
      size: settings.size,
    });
    sendSizeSelect.value = String(settings.sendSize);
    concurrencySelect.value = String(settings.concurrency);
  };

  // --- input zone -----------------------------------------------------------------------------------------
  const countText = h('span', { class: 'me-auto small', 'data-testid': 'iso-count' });
  const removeAllButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-focus-key': 'remove-all',
      'data-testid': 'iso-remove-all',
      onclick: () => void removeAll(),
    },
    'Remove all',
  );
  const photoList = h('ul', {
    class: 'list-unstyled vstack gap-2 mb-0',
    'aria-label': 'Photos',
    'data-testid': 'iso-photos',
  });
  const drop = dropZone({
    accept: ctx.manifest.accepts,
    multiple: true,
    label: 'Drop product photos here',
    onFiles: (files) => addPhotos(files),
    testId: 'iso-drop-zone',
  });
  ui.input.append(
    drop,
    h(
      'div',
      { class: 'vstack gap-2' },
      h('div', { class: 'd-flex flex-wrap align-items-center gap-2' }, countText, removeAllButton),
      photoList,
    ),
    h(
      'p',
      { class: 'form-text mb-0' },
      'Each photo goes to the model with one fixed instruction: keep the product exactly as it is, remove everything else, pure white background. A soft shadow is in Settings.',
    ),
  );

  let lastEstimate: number | null | undefined;
  let estimateVersion = 0;
  const renderCount = (): void => {
    const total = photos.length;
    const todo = pending().length;
    const parts = [total === 0 ? 'No photos yet' : plural(total, 'photo')];
    if (total > 0 && todo !== total) parts.push(`${todo} to isolate`);
    if (todo > 0 && lastEstimate !== undefined) parts.push(formatEstimate(lastEstimate));
    countText.textContent = parts.join(' · ');
    removeAllButton.hidden = total === 0;
    removeAllButton.disabled = running;
  };

  const rows = new Map<string, HTMLElement>();
  const photoRow = (photo: Photo): HTMLElement =>
    h(
      'li',
      {
        class: 'd-flex align-items-center gap-2',
        'data-testid': 'iso-photo',
        dataset: { key: photo.key },
      },
      photo.thumbUrl
        ? h('img', { class: 'or-iso-photo-thumb', src: photo.thumbUrl, alt: '', decoding: 'async' })
        : h('span', { class: 'or-iso-photo-thumb', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'min-w-0 flex-grow-1' },
        h('div', { class: 'small fw-semibold text-truncate' }, photo.name),
        h(
          'div',
          { class: 'small text-body-secondary' },
          [formatBytes(photo.file.size), photo.result ? 'done' : (PHASE_TEXT[photo.phase] ?? '')]
            .filter(Boolean)
            .join(' · '),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'aria-label': `Remove ${photo.name}`,
          title: 'Remove',
          disabled: inRun(photo),
          'data-focus-key': `remove:${photo.key}`,
          'data-testid': 'iso-photo-remove',
          onclick: () => void removePhoto(photo),
        },
        icon('x-lg'),
      ),
    );

  const renderPhotos = (): void => {
    rows.clear();
    replace(
      photoList,
      photos.map((photo) => {
        const row = photoRow(photo);
        rows.set(photo.key, row);
        return row;
      }),
    );
    renderCount();
  };

  /** Redraws one photo's row (its status, thumbnail), keeping focus in it. */
  const updatePhotoRow = (photo: Photo): void => {
    const old = rows.get(photo.key);
    if (!old?.isConnected) return renderPhotos();
    const key = focusedKey(old);
    const fresh = photoRow(photo);
    rows.set(photo.key, fresh);
    old.replaceWith(fresh);
    if (key) focusKey(fresh, key);
    renderCount();
  };

  const addPhotos = (files: readonly File[]): void => {
    const room = MAX_PHOTOS - photos.length;
    const taken = files
      .filter((file) => file.type.startsWith('image/'))
      .slice(0, Math.max(0, room));
    if (taken.length < files.length) {
      ui.status(
        room <= 0
          ? `At most ${MAX_PHOTOS} photos at a time.`
          : `${plural(files.length - taken.length, 'file')} skipped (at most ${MAX_PHOTOS} photos).`,
      );
    }
    if (taken.length === 0) return;
    const added = taken.map((file): Photo => ({
      key: uid('photo'),
      file,
      name: file.name || 'photo',
      url: URL.createObjectURL(file),
      thumbUrl: null,
      dims: null,
      phase: 'idle',
      error: null,
      edited: null,
      model: null,
      editRun: null,
      margin: null,
      threshold: null,
      result: null,
      job: null,
      failedKey: null,
    }));
    photos = [...photos, ...added];
    syncControls();
    renderPhotos();
    void ui.refreshEstimate();
    for (const photo of added) {
      // Small copies for the list (a full-size <img> per photo decodes megapixels each).
      void imageThumbnail(photo.file, LIST_THUMB)
        .then((thumb) => {
          if (!photos.includes(photo)) return;
          photo.thumbUrl = URL.createObjectURL(thumb);
          updatePhotoRow(photo);
          if (!photo.result && cards.has(photo.key)) updateCard(photo);
        })
        .catch(() => undefined); // not an image the browser reads: the request will say so
      void readImageSize(photo.file)
        .then((dims) => {
          photo.dims = dims;
          void ui.refreshEstimate();
        })
        .catch(() => undefined);
    }
  };

  /** Lets go of a result: its card (and leave-guard entry) and its thumbnail. */
  const retire = (result: Processed): void => {
    result.card.remove();
    URL.revokeObjectURL(result.thumbUrl);
  };

  /** Drops a photo and everything made from it. */
  const discard = (photo: Photo): void => {
    photo.job?.controller.abort();
    photo.job = null;
    if (photo.result) retire(photo.result);
    photo.result = null;
    URL.revokeObjectURL(photo.url);
    if (photo.thumbUrl) URL.revokeObjectURL(photo.thumbUrl);
    photos = photos.filter((candidate) => candidate !== photo);
    if (detail?.key === photo.key) closeDetail(false);
  };

  const notDownloaded = (list: readonly Photo[]): Photo[] =>
    list.filter((photo) => photo.result && !photo.result.handle.result.downloaded);

  const removePhoto = async (photo: Photo): Promise<void> => {
    if (!(await confirmRemoval(photo))) return;
    discard(photo);
    afterRemoval();
    announce(`${photo.name} removed.`);
  };

  const removeAll = async (): Promise<void> => {
    if (running || photos.length === 0) return;
    const unsaved = notDownloaded(photos).length;
    if (unsaved > 0) {
      const ok = await confirmDialog({
        title: 'Remove all photos?',
        message: `${plural(unsaved, 'result')} ${unsaved === 1 ? 'has' : 'have'} not been downloaded.`,
        confirmLabel: 'Remove all',
        tone: 'danger',
        testId: 'iso-remove-dialog',
      });
      if (!ok) return;
    }
    for (const photo of [...photos]) if (!inRun(photo)) discard(photo);
    afterRemoval();
    // The button hides with the list: hand focus to the place where photos come in again.
    if (removeAllButton.hidden) drop.querySelector('button')?.focus();
    announce('All photos removed.');
  };

  const afterRemoval = (): void => {
    renderPhotos();
    renderGrid();
    renameAll();
    syncControls();
    void ui.refreshEstimate();
  };

  // --- output zone ----------------------------------------------------------------------------------------
  const summary = h('span', { class: 'me-auto small', 'data-testid': 'iso-summary' });
  const retryFailedButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
      hidden: true,
      'data-focus-key': 'retry-failed',
      'data-testid': 'iso-retry-failed',
      onclick: () =>
        retry(photos.filter((photo) => !photo.result && !inRun(photo) && photo.phase !== 'idle')),
    },
    icon('arrow-clockwise'),
    'Retry failed',
  );
  const zipButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-primary d-inline-flex align-items-center gap-1',
      disabled: true,
      'data-testid': 'iso-download-zip',
      onclick: () => void downloadZip(),
    },
    icon('file-earmark-zip'),
    'Download all (ZIP)',
  );
  const progress = progressBar({ label: 'Photos isolated', hidden: true, testId: 'iso-progress' });
  const grid = h('ul', {
    class: 'row row-cols-1 row-cols-sm-2 row-cols-xxl-3 g-3 list-unstyled mb-0 or-iso-grid',
    'aria-label': 'Results',
    'data-testid': 'iso-results',
  });
  const empty = emptyState({
    icon: 'bounding-box',
    title: 'No results yet',
    text: 'Add product photos and press Isolate. Each one comes back on a pure white square, checked.',
    testId: 'iso-empty',
  });
  const gridView = h('div', { class: 'vstack gap-3', 'data-testid': 'iso-grid-view' }, empty, grid);
  const detailView = h('section', { hidden: true, 'data-testid': 'iso-detail' });
  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        summary,
        retryFailedButton,
        zipButton,
      ),
      progress.element,
      gridView,
      detailView,
    ),
  );

  const qaBadge = (qa: QaReport): HTMLElement =>
    h(
      'span',
      {
        class: ['badge', qa.pass ? 'text-bg-success' : 'text-bg-warning'],
        'data-testid': 'iso-qa-badge',
      },
      icon(qa.pass ? 'check-circle' : 'exclamation-triangle', 'me-1'),
      qa.pass ? 'QA passed' : 'QA failed',
    );

  const busyText = (photo: Photo): string | null =>
    inRun(photo) ? (PHASE_TEXT[photo.phase] ?? null) : photo.job ? 'Updating…' : null;

  const retryButton = (photo: Photo): HTMLButtonElement =>
    gate.bind(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
          'aria-label': `Retry ${photo.name}`,
          'data-focus-key': `retry:${photo.key}`,
          'data-testid': 'iso-retry',
          onclick: () => retry([photo]),
        },
        icon('arrow-clockwise'),
        photo.result ? 'Edit again' : 'Retry',
      ),
    );

  const otherModelButton = (photo: Photo): HTMLButtonElement =>
    gate.bind(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
          'aria-label': `Retry ${photo.name} with another model`,
          'data-focus-key': `model:${photo.key}`,
          'data-testid': 'iso-retry-model',
          onclick: () => void retryWithModel(photo),
        },
        icon('cpu'),
        'Another model…',
      ),
    );

  /** The image in a card: a small copy (never the 2000 px result), with a spinner while work goes on. */
  const cardImage = (
    src: string | null,
    alt: string,
    busy: boolean,
    source: boolean,
  ): HTMLElement =>
    h(
      'div',
      { class: 'or-iso-result-frame' },
      src
        ? h('img', {
            class: ['or-iso-result-img', source && 'is-source'],
            src,
            alt,
            decoding: 'async',
            'data-testid': 'iso-card-image',
          })
        : null,
      busy
        ? h(
            'div',
            { class: 'or-iso-busy' },
            h('div', { class: 'spinner-border', 'aria-hidden': 'true' }),
          )
        : null,
    );

  const statusBadge = (photo: Photo, busy: string | null): HTMLElement | null =>
    busy || photo.phase === 'failed' || (photo.phase === 'stopped' && !photo.result)
      ? h(
          'span',
          {
            class: ['badge', photo.phase === 'failed' ? 'text-bg-danger' : 'text-bg-secondary'],
            'data-testid': 'iso-status',
          },
          busy ?? PHASE_TEXT[photo.phase] ?? '',
        )
      : null;

  const errorNote = (photo: Photo): HTMLElement | null =>
    photo.error
      ? h(
          'div',
          { class: 'small text-danger-emphasis', role: 'note', 'data-testid': 'iso-error' },
          photo.error,
        )
      : null;

  /** A result card's own part (thumbnail, badges, QA reasons), redrawn in place so focus stays put. */
  const paintExtra = (photo: Photo, result: Processed): void => {
    const busy = busyText(photo);
    replace(
      result.extra,
      cardImage(result.thumbUrl, `${photo.name} on white`, busy !== null, false),
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-1' },
        statusBadge(photo, busy),
        qaBadge(result.qa),
      ),
      errorNote(photo),
      result.qa.pass
        ? null
        : h(
            'div',
            { class: 'small text-warning-emphasis', 'data-testid': 'iso-qa-reasons' },
            result.qa.reasons.join(' '),
          ),
    );
  };

  /** A photo still without a result: its original, its status, Retry and Another model. */
  const pendingCard = (photo: Photo): HTMLElement => {
    const busy = busyText(photo);
    return h(
      'div',
      { class: 'card h-100' },
      h(
        'div',
        { class: 'card-body p-2 vstack gap-2' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-1' },
          h('h3', { class: 'h6 mb-0 text-truncate me-auto min-w-0' }, photo.name),
          statusBadge(photo, busy),
        ),
        cardImage(photo.thumbUrl, `${photo.name}, not isolated yet`, busy !== null, true),
        errorNote(photo),
        inRun(photo) || photo.phase === 'idle'
          ? null
          : h(
              'div',
              { class: 'd-flex flex-wrap gap-1 mt-auto' },
              retryButton(photo),
              otherModelButton(photo),
            ),
      ),
    );
  };

  const confirmRemoval = async (photo: Photo): Promise<boolean> => {
    if (inRun(photo)) {
      announce(`${photo.name} is being isolated: wait until it is done.`);
      return false;
    }
    if (notDownloaded([photo]).length === 0) return true;
    const ok = await confirmDialog({
      title: 'Remove this photo?',
      message: `The result for ${photo.name} has not been downloaded.`,
      confirmLabel: 'Remove',
      tone: 'danger',
      testId: 'iso-remove-dialog',
    });
    return ok && photos.includes(photo);
  };

  /**
   * A result's card: the framework's image result card (leave guard, the download as it is, Send to…, Remove with
   * focus handling) with this tool's actions and its thumbnail, badges and reasons (`extra`). Only the file as it
   * is is offered: its JPG border was checked after encoding, a conversion's would not be. Remove drops the photo.
   */
  const makeCard = (
    photo: Photo,
    blob: Blob,
    name: string,
    extra: HTMLElement,
    output: { size: number },
  ): ImageResultCard => {
    const made = imageResultCard({
      ui,
      blob,
      name,
      title: photo.name,
      meta: [`${output.size} × ${output.size}`, formatBytes(blob.size)],
      formats: [],
      viewer: false,
      extra,
      actions: [
        {
          label: 'Review',
          icon: 'layout-split',
          ariaLabel: `Review ${photo.name}`,
          onClick: () => openDetail(photo),
          testId: 'iso-review',
        },
        {
          label: 'Edit again',
          icon: 'arrow-clockwise',
          ariaLabel: `Edit ${photo.name} again`,
          onClick: () => retry([photo]),
          testId: 'iso-retry',
        },
        {
          label: 'Another model…',
          icon: 'cpu',
          ariaLabel: `Retry ${photo.name} with another model`,
          onClick: () => void retryWithModel(photo),
          testId: 'iso-retry-model',
        },
      ],
      beforeRemove: () => confirmRemoval(photo),
      onRemove: () => {
        discard(photo);
        afterRemoval();
      },
      focusFallback: () => (zipButton.disabled ? drop.querySelector('button') : zipButton),
      testId: 'iso',
    });
    // Edit again and Another model follow Run (busy or disabled), like every per-item Retry.
    for (const button of made.element.querySelectorAll<HTMLButtonElement>(
      '[data-focus-key^="image-action:"]',
    )) {
      if (!button.dataset['focusKey']?.endsWith(':Review')) gate.bind(button);
    }
    return made;
  };

  const cards = new Map<string, HTMLElement>();
  const shown = (): Photo[] => photos.filter((photo) => photo.phase !== 'idle' || photo.result);

  /** Fills a photo's grid cell: its result card (moved in once, then updated in place) or its status card. */
  const fillCard = (cell: HTMLElement, photo: Photo): void => {
    const result = photo.result;
    Object.assign(cell.dataset, {
      key: photo.key,
      phase: photo.phase,
      qa: result ? (result.qa.pass ? 'pass' : 'fail') : '',
      busy: busyText(photo) ? 'true' : 'false',
    });
    if (!result) {
      replace(cell, pendingCard(photo));
      return;
    }
    paintExtra(photo, result);
    if (cell.childElementCount !== 1 || cell.firstElementChild !== result.card.element) {
      cell.replaceChildren(result.card.element);
    }
  };

  const card = (photo: Photo): HTMLElement => {
    const cell = h('li', { class: 'col', 'data-testid': 'iso-card' });
    fillCard(cell, photo);
    return cell;
  };

  const renderGrid = (): void => {
    cards.clear();
    const list = shown();
    replace(
      grid,
      list.map((photo) => {
        const element = card(photo);
        cards.set(photo.key, element);
        return element;
      }),
    );
    empty.hidden = list.length > 0;
    grid.hidden = list.length === 0;
    renderSummary();
  };

  /** Redraws one card (focus stays where it was), or the grid when the card is not there yet. */
  const updateCard = (photo: Photo): void => {
    const cell = cards.get(photo.key);
    if (!cell?.isConnected) {
      renderGrid();
      return;
    }
    const key = focusedKey(cell);
    fillCard(cell, photo);
    if (key && !cell.contains(document.activeElement)) focusKey(cell, key);
    renderSummary();
  };

  const renderSummary = (): void => {
    const done = withResults();
    const passed = done.filter((photo) => photo.result?.qa.pass).length;
    const notIsolated = photos.filter(
      (photo) => !photo.result && !inRun(photo) && photo.phase !== 'idle',
    ).length;
    const parts: string[] = [];
    if (done.length > 0) parts.push(`${passed} of ${plural(done.length, 'result')} passed QA`);
    if (notIsolated > 0) parts.push(`${notIsolated} not isolated`);
    summary.textContent = parts.join(' · ');
    const hideRetry = notIsolated === 0 || running;
    // A focused "Retry failed" that hides (its run started) hands focus to Stop, or Run when idle.
    if (hideRetry && !retryFailedButton.hidden && document.activeElement === retryFailedButton) {
      (runner.stopButton.hidden ? runner.button : runner.stopButton).focus();
    }
    retryFailedButton.hidden = hideRetry;
    zipButton.disabled = done.length === 0;
    updateNavigation();
  };

  // --- review (one photo) ---------------------------------------------------------------------------------
  interface Detail {
    key: string;
    heading: HTMLElement;
    qaBox: HTMLElement;
    slider: CompareSlider;
    sideBefore: HTMLImageElement;
    sideAfter: HTMLImageElement;
    compareView: HTMLElement;
    sideView: HTMLElement;
    compareButton: HTMLButtonElement;
    sideButton: HTMLButtonElement;
    marginRange: HTMLInputElement;
    marginValue: HTMLElement;
    marginReset: HTMLButtonElement;
    thresholdRange: HTMLInputElement;
    thresholdValue: HTMLElement;
    thresholdReset: HTMLButtonElement;
    updating: HTMLElement;
    downloadSlot: HTMLElement;
    previousButton: HTMLButtonElement;
    nextButton: HTMLButtonElement;
    shownHandle: ResultHandle | null;
    shownUrl: string | null;
  }
  let detail: Detail | null = null;
  let compareMode: 'compare' | 'side' = 'compare';

  const photoOf = (key: string): Photo | undefined => photos.find((photo) => photo.key === key);

  /** The photo with a result before or after `key`'s, as the list is now. */
  const neighbourOf = (key: string, step: 1 | -1): Photo | undefined => {
    const list = withResults();
    const at = list.findIndex((candidate) => candidate.key === key);
    return at < 0 ? undefined : list[at + step];
  };

  /** Previous/Next follow the photos as they are added, removed or finished. */
  const updateNavigation = (): void => {
    if (!detail) return;
    const buttons = [
      [detail.previousButton, -1, 'Previous'],
      [detail.nextButton, 1, 'Next'],
    ] as const;
    for (const [button, step, label] of buttons) {
      const target = neighbourOf(detail.key, step);
      if (!target && document.activeElement === button) detail.heading.focus();
      button.disabled = !target;
      button.setAttribute('aria-label', target ? `${label}: ${target.name}` : label);
    }
  };

  const percent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;

  const openDetail = (photo: Photo): void => {
    if (!photo.result) return;
    const marginId = uid('iso-photo-margin');
    const thresholdId = uid('iso-photo-threshold');
    const headingId = uid('iso-detail-title');
    const result = photo.result;
    const slider = compareSlider({
      before: { src: photo.url, alt: `Original photo: ${photo.name}`, label: 'Original' },
      after: { src: result.url, alt: `Result: ${photo.name} on white`, label: 'Result' },
      label: 'Compare the original and the result',
      testId: 'iso-compare',
    });
    const sideBefore = h('img', { src: photo.url, alt: `Original photo: ${photo.name}` });
    const sideAfter = h('img', {
      src: result.url,
      alt: `Result: ${photo.name} on white`,
      'data-testid': 'iso-side-after',
    });
    const compareView = h('div', null, slider.element);
    const sideView = h(
      'div',
      { class: 'row g-2', hidden: true, 'data-testid': 'iso-side' },
      h(
        'figure',
        { class: 'col-6 or-iso-side' },
        sideBefore,
        h('figcaption', { class: 'small text-body-secondary mt-1' }, 'Original'),
      ),
      h(
        'figure',
        { class: 'col-6 or-iso-side' },
        sideAfter,
        h('figcaption', { class: 'small text-body-secondary mt-1' }, 'Result'),
      ),
    );
    const viewButton = (label: string, mode: 'compare' | 'side', testId: string) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'aria-pressed': String(compareMode === mode),
          'data-testid': testId,
          onclick: () => {
            compareMode = mode;
            updateDetail();
          },
        },
        label,
      );
    const marginRange: HTMLInputElement = h('input', {
      id: marginId,
      type: 'range',
      class: 'form-range',
      min: String(MARGIN_RANGE.min * 100),
      max: String(MARGIN_RANGE.max * 100),
      step: '0.5',
      value: String(Math.round((photo.margin ?? settings.margin) * 1000) / 10),
      'data-testid': 'iso-margin',
      oninput: () => {
        const current = photoOf(photo.key);
        if (!current) return;
        current.margin = Math.round(Number(marginRange.value) * 10) / 1000;
        current.failedKey = null;
        paintControls(current);
        scheduleReconcile();
      },
    });
    const thresholdRange: HTMLInputElement = h('input', {
      id: thresholdId,
      type: 'range',
      class: 'form-range',
      min: String(THRESHOLD_RANGE.min),
      max: String(THRESHOLD_RANGE.max),
      step: '1',
      value: String(photo.threshold ?? result.threshold),
      'data-testid': 'iso-threshold',
      oninput: () => {
        const current = photoOf(photo.key);
        if (!current) return;
        current.threshold = Number(thresholdRange.value);
        current.failedKey = null;
        paintControls(current);
        scheduleReconcile();
      },
    });
    const resetButton = (label: string, testId: string, onclick: () => void) =>
      h(
        'button',
        { type: 'button', class: 'btn btn-sm btn-link', 'data-testid': testId, onclick },
        label,
      );
    const marginReset = resetButton('Use the setting', 'iso-margin-reset', () => {
      const current = photoOf(photo.key);
      if (!current) return;
      current.margin = null;
      paintControls(current);
      scheduleReconcile();
      marginRange.focus();
    });
    const thresholdReset = resetButton('Automatic', 'iso-threshold-reset', () => {
      const current = photoOf(photo.key);
      if (!current) return;
      current.threshold = null;
      paintControls(current);
      scheduleReconcile();
      thresholdRange.focus();
    });
    const heading = h(
      'h3',
      { id: headingId, class: 'h5 mb-0 text-truncate me-auto min-w-0', tabIndex: -1 },
      photo.name,
    );
    const navButton = (step: 1 | -1, glyph: string, testId: string): HTMLButtonElement =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary',
          'data-testid': testId,
          onclick: () => {
            const target = neighbourOf(photo.key, step);
            if (target) openDetail(target);
          },
        },
        icon(glyph),
      );

    detail = {
      key: photo.key,
      heading,
      qaBox: h('div', { 'data-testid': 'iso-qa' }),
      slider,
      sideBefore,
      sideAfter,
      compareView,
      sideView,
      compareButton: viewButton('Before / after', 'compare', 'iso-view-compare'),
      sideButton: viewButton('Side by side', 'side', 'iso-view-side'),
      marginRange,
      marginValue: h('span', { class: 'small', 'data-testid': 'iso-margin-value' }),
      marginReset,
      thresholdRange,
      thresholdValue: h('span', { class: 'small', 'data-testid': 'iso-threshold-value' }),
      thresholdReset,
      updating: h(
        'span',
        { class: 'small text-body-secondary', hidden: true, 'data-testid': 'iso-updating' },
        h('span', { class: 'spinner-border spinner-border-sm me-1', 'aria-hidden': 'true' }),
        'Updating…',
      ),
      downloadSlot: h('span'),
      previousButton: navButton(-1, 'chevron-left', 'iso-previous'),
      nextButton: navButton(1, 'chevron-right', 'iso-next'),
      shownHandle: null,
      shownUrl: null,
    };
    const d = detail;

    replace(
      detailView,
      h(
        'div',
        { class: 'vstack gap-3', 'aria-labelledby': headingId, role: 'group' },
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
              'data-testid': 'iso-back',
              onclick: () => closeDetail(true),
            },
            icon('grid-3x3-gap'),
            'All results',
          ),
          heading,
          d.previousButton,
          d.nextButton,
        ),
        d.qaBox,
        h(
          'div',
          { class: 'd-flex flex-wrap align-items-center gap-2' },
          h(
            'div',
            { class: 'btn-group', role: 'group', 'aria-label': 'Comparison view' },
            d.compareButton,
            d.sideButton,
          ),
          d.updating,
        ),
        compareView,
        sideView,
        h(
          'div',
          { class: 'row g-3' },
          h(
            'div',
            { class: 'col-sm-6' },
            h(
              'div',
              { class: 'd-flex align-items-baseline gap-2' },
              h('label', { class: 'form-label mb-0', htmlFor: marginId }, 'Margin'),
              d.marginValue,
              h('span', { class: 'ms-auto' }, marginReset),
            ),
            marginRange,
          ),
          h(
            'div',
            { class: 'col-sm-6' },
            h(
              'div',
              { class: 'd-flex align-items-baseline gap-2' },
              h('label', { class: 'form-label mb-0', htmlFor: thresholdId }, 'White threshold'),
              d.thresholdValue,
              h('span', { class: 'ms-auto' }, thresholdReset),
            ),
            thresholdRange,
          ),
        ),
        h(
          'p',
          { class: 'small text-body-secondary mb-0' },
          'Margin and threshold apply to this photo only and change the result here, without a new request.',
        ),
        h(
          'div',
          { class: 'd-flex flex-wrap gap-2' },
          d.downloadSlot,
          retryButton(photo),
          otherModelButton(photo),
        ),
      ),
    );
    gridView.hidden = true;
    detailView.hidden = false;
    updateDetail();
    heading.focus();
  };

  const closeDetail = (restoreFocus: boolean): void => {
    const key = detail?.key;
    detail = null;
    detailView.replaceChildren();
    detailView.hidden = true;
    gridView.hidden = false;
    renderGrid();
    if (!restoreFocus || !key) return;
    // Back on the Review button of the photo that was open (an action of its result card).
    const review = (
      key ? photoOf(key) : undefined
    )?.result?.card.element.querySelector<HTMLElement>('[data-focus-key$=":Review"]');
    (review ?? zipButton).focus();
  };

  /** The review's labels follow the photo's choices at once; the images follow when the result is made. */
  const paintControls = (photo: Photo): void => {
    if (!detail || detail.key !== photo.key) return;
    const asked = photo.margin ?? settings.margin;
    const applied = appliedMargin(asked, settings);
    // Following the setting, the range shows it (and moves when the setting does).
    if (photo.margin === null) detail.marginRange.value = String(Math.round(asked * 1000) / 10);
    const margin =
      applied > asked ? `${percent(asked)} (JPG uses ${percent(applied)})` : percent(asked);
    detail.marginValue.textContent = margin;
    detail.marginRange.setAttribute('aria-valuetext', margin);
    detail.marginReset.hidden = photo.margin === null;
    const threshold = photo.threshold ?? photo.result?.threshold ?? settings.whiteThreshold;
    if (photo.threshold === null) detail.thresholdRange.value = String(threshold);
    const thresholdText = photo.threshold === null ? `${threshold} (automatic)` : String(threshold);
    detail.thresholdValue.textContent = thresholdText;
    detail.thresholdRange.setAttribute('aria-valuetext', thresholdText);
    detail.thresholdReset.hidden = photo.threshold === null;
  };

  const updateDetail = (): void => {
    if (!detail) return;
    const photo = photoOf(detail.key);
    if (!photo?.result) {
      closeDetail(false);
      return;
    }
    const result = photo.result;
    const d = detail;
    if (d.shownUrl !== result.url) {
      d.shownUrl = result.url;
      d.slider.setImages({ after: { src: result.url, alt: `Result: ${photo.name} on white` } });
      d.sideAfter.src = result.url;
    }
    if (d.shownHandle !== result.handle) {
      d.shownHandle = result.handle;
      d.downloadSlot.replaceChildren(result.handle.button());
    }
    d.compareView.hidden = compareMode !== 'compare';
    d.sideView.hidden = compareMode !== 'side';
    d.compareButton.setAttribute('aria-pressed', String(compareMode === 'compare'));
    d.sideButton.setAttribute('aria-pressed', String(compareMode === 'side'));
    d.updating.hidden = !photo.job && !inRun(photo);
    detailView.dataset['margin'] = String(result.margin);
    detailView.dataset['threshold'] = String(result.threshold);
    const qa = result.qa;
    replace(
      d.qaBox,
      h(
        'div',
        {
          class: ['alert mb-0 py-2', qa.pass ? 'alert-success' : 'alert-warning'],
          'data-qa': qa.pass ? 'pass' : 'fail',
        },
        h('div', { class: 'd-flex align-items-center gap-2' }, qaBadge(qa)),
        qa.pass
          ? h(
              'div',
              { class: 'small mt-1' },
              'Every border pixel is pure white and the product is clear of the edges.',
            )
          : h(
              'ul',
              { class: 'small mb-0 mt-1 ps-3' },
              qa.reasons.map((reason) => h('li', null, reason)),
            ),
        qa.note ? h('div', { class: 'small mt-1 text-body-secondary' }, qa.note) : null,
        photo.error
          ? h('div', { class: 'small mt-1 text-danger-emphasis', role: 'note' }, photo.error)
          : null,
      ),
    );
    paintControls(photo);
    updateNavigation();
  };

  // --- post-processing ------------------------------------------------------------------------------------
  /** Decode the model's answer, run the pipeline in the worker, encode, and keep it as the photo's result. */
  const process = async (photo: Photo, signal: AbortSignal): Promise<void> => {
    const edited = photo.edited;
    if (!edited) return;
    const s = settings;
    const key = processingKey(s, photo);
    const margin = appliedMargin(photo.margin ?? s.margin, s);
    const wanted = photo.threshold ?? s.whiteThreshold;
    const adapt = photo.threshold === null;
    const made = await limited(signal, async () => {
      const raster = await decodeRaster(edited);
      signal.throwIfAborted();
      const source = { width: raster.width, height: raster.height };
      const result = await isolateImage(
        raster,
        {
          size: s.size,
          margin,
          whiteThreshold: wanted,
          adaptThreshold: adapt,
          despeckle: true,
          sharpen: s.sharpen ? { amount: s.sharpenAmount, radius: 1 } : false,
        },
        { signal, transfer: true },
      );
      const blob = await encodeRaster(result.image, s.format, s.jpegQuality / 100);
      // The QA holds for what is saved: a JPG is decoded again and its border checked.
      const flaws = s.format === 'jpg' ? await encodedBorderFlaws(blob) : 0;
      return {
        blob,
        thumb: await imageThumbnail(blob, GRID_THUMB),
        source,
        box: result.box,
        check: result.check,
        threshold: result.threshold,
        backgroundUnclear: result.backgroundUnclear,
        encodedBorderFlaws: flaws,
      };
    });
    signal.throwIfAborted();
    // Removed, or edited again, while this was made: it is not this photo's result any more.
    if (!photos.includes(photo) || photo.edited !== edited) throw abortError();
    const output = { format: s.format, size: s.size };
    const previous = photo.result;
    const qa = qaReport(made, made.source, wanted);
    const extra = h('div', { class: 'vstack gap-2' });
    // Named under the pattern as it is now, which may have changed while this was being made.
    const resultCard = makeCard(photo, made.blob, resultName(photo, output), extra, output);
    photo.result = {
      key,
      blob: made.blob,
      card: resultCard,
      handle: resultCard.handle,
      url: ctx.results.objectUrl(resultCard.handle.result.id),
      thumbUrl: URL.createObjectURL(made.thumb),
      extra,
      qa,
      threshold: made.threshold,
      margin,
      box: made.box,
      source: made.source,
      ...output,
    };
    photo.failedKey = null;
    if (!inRun(photo)) {
      photo.phase = 'done';
      photo.error = null;
      // A result made again (review or settings) whose verdict turned is said out loud.
      if (previous && previous.qa.pass !== qa.pass) {
        announce(
          qa.pass
            ? `${photo.name}: QA passed.`
            : `${photo.name}: QA failed. ${qa.reasons.join(' ')}`,
        );
      }
    }
    if (previous) swapCard(photo, previous);
  };

  /**
   * Puts a photo's new result card where its old one was and lets the old one go; a control focused in the old
   * card hands focus to the one with the same label in the new card.
   */
  const swapCard = (photo: Photo, previous: Processed): void => {
    const focused = document.activeElement;
    const label =
      focused instanceof HTMLElement && previous.card.element.contains(focused)
        ? focused.textContent
        : null;
    if (cards.has(photo.key)) updateCard(photo);
    retire(previous);
    if (label === null || !photo.result) return;
    const match = [...photo.result.card.element.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    );
    match?.focus();
  };

  /** A result's file name under the current pattern, for the format and size it was made in. */
  const resultName = (photo: Photo, output: { format: OutputFormat; size: number }): string =>
    outputName(settings.filenamePattern, {
      fileName: photo.name,
      n: photos.indexOf(photo) + 1,
      ...output,
    });

  /** Brings every photo's result in line with the current settings and review choices (no requests). */
  const reconcile = (): void => {
    const started: Photo[] = [];
    for (const photo of photos) {
      if (!photo.edited || inRun(photo)) continue;
      const key = processingKey(settings, photo);
      if (photo.job?.key === key) continue;
      if (!photo.job && (photo.result?.key === key || photo.failedKey === key)) continue;
      photo.job?.controller.abort();
      const job = { key, controller: new AbortController() };
      photo.job = job;
      started.push(photo);
      const refresh = (): void => {
        if (!photos.includes(photo)) return;
        updateCard(photo);
        if (detail?.key === photo.key) updateDetail();
        updatePhotoRow(photo);
      };
      refresh();
      void process(photo, job.controller.signal).then(
        () => {
          if (photo.job !== job) return;
          photo.job = null;
          refresh();
        },
        (error: unknown) => {
          if (photo.job !== job) return; // replaced by a newer job
          photo.job = null;
          if (!isAbortError(error)) {
            photo.failedKey = key;
            photo.error = `Could not finish the result: ${userMessage(error)}`;
          }
          refresh();
        },
      );
    }
    // "Updating…" is said once: for the photo, or for how many.
    if (started.length === 1) announce(`Updating ${started[0]!.name}…`);
    else if (started.length > 1) announce(`Updating ${plural(started.length, 'result')}…`);
  };
  const scheduleReconcile = debounce(reconcile, RECONCILE_DELAY_MS);

  /** Gives every result its name under the current pattern (positions change when photos are removed). */
  const renameAll = (): void => {
    for (const photo of photos) {
      const result = photo.result;
      if (!result) continue;
      const name = resultName(photo, result);
      if (name === result.handle.result.name) continue;
      // A card's name is fixed: a renamed result gets a new card (same Blob, same thumbnail and extra part).
      const renamed = makeCard(photo, result.blob, name, result.extra, result);
      if (result.handle.result.downloaded) ctx.results.markDownloaded(renamed.handle.result.id);
      const old = result.card;
      result.card = renamed;
      result.handle = renamed.handle;
      result.url = ctx.results.objectUrl(renamed.handle.result.id);
      old.remove();
    }
    renderGrid();
    updateDetail();
  };
  const scheduleRename = debounce(renameAll, RECONCILE_DELAY_MS);

  const processingFields: (keyof IsolateSettings)[] = [
    'size',
    'margin',
    'whiteThreshold',
    'sharpen',
    'sharpenAmount',
    'format',
    'jpegQuality',
  ];
  const settingsChanged = (before: IsolateSettings): void => {
    if (processingFields.some((key) => before[key] !== settings[key])) {
      for (const photo of photos) photo.failedKey = null;
      scheduleReconcile();
    }
    if (before.filenamePattern !== settings.filenamePattern) scheduleRename();
    if (before.sendSize !== settings.sendSize) void ui.refreshEstimate();
    // The review shows the setting a photo follows (its margin range included).
    updateDetail();
  };

  // --- running --------------------------------------------------------------------------------------------
  /**
   * One edit per photo, each uploading its photo once. The answer is assumed as large as the largest photo
   * sent (sizes read from the files' headers, at most the send size; the send size itself before they are read).
   */
  const estimateFor = (model: string, list: readonly Photo[]): Promise<number | null> => {
    if (list.length === 0) return Promise.resolve(null);
    let width = 0;
    let height = 0;
    for (const photo of list) {
      const sent = photo.dims
        ? fitWithin(photo.dims.width, photo.dims.height, settings.sendSize)
        : { width: settings.sendSize, height: settings.sendSize };
      if (sent.width * sent.height > width * height) ({ width, height } = sent);
    }
    return ctx.models.estimate({
      kind: 'image',
      model,
      images: list.length,
      references: 1,
      requests: list.length,
      width,
      height,
    });
  };

  /** One photo: the edit request, then its post-processing. */
  const isolate = async (
    run: RunHandle,
    photo: Photo,
    request: { instruction: string; params: Parameters<typeof buildRequest>[3]; sendSize: number },
    signal: AbortSignal,
  ): Promise<void> => {
    const dataUrl = await referenceDataUrl(photo.file, request.sendSize);
    signal.throwIfAborted();
    const answer = await ctx.api.images(
      buildRequest(run.model, request.instruction, dataUrl, request.params),
      { run, signal },
    );
    const image = answer.images[0];
    if (!image) throw new InvalidInputError('The model returned no image.');
    photo.edited = image.blob;
    photo.model = run.model;
    photo.editRun = run.id;
    photo.margin = null;
    photo.threshold = null;
    photo.failedKey = null;
    photo.phase = 'processing';
    updateCard(photo);
    await process(photo, signal);
  };

  const historyText = (): string =>
    photos
      .filter((photo) => photo.result || photo.phase !== 'idle')
      .map((photo) => qaLine(photo.name, photo.result?.qa ?? null, photo.error))
      .join('\n');

  /** The latest run, so a replayed Retry can tell which photos that run already made. */
  let lastRun: string | null = null;

  /** One line naming what went wrong in a run: a request's error, else the first QA reason (two at most). */
  const problemsOf = (list: readonly Photo[]): string[] => {
    const problems = list.flatMap((photo) =>
      photo.error
        ? [`${photo.name}: ${photo.error}`]
        : photo.result && !photo.result.qa.pass
          ? [`${photo.name}: ${photo.result.qa.reasons[0] ?? 'QA failed'}`]
          : [],
    );
    return problems.length > 2
      ? [...problems.slice(0, 2), `${problems.length - 2} more`]
      : problems;
  };

  const run = async (signal: AbortSignal, arg?: RunArg): Promise<void> => {
    let targets = arg
      ? photos.filter((photo) => arg.keys.includes(photo.key) && !inRun(photo))
      : pending();
    if (targets.length === 0) {
      if (!arg) {
        ui.status(
          photos.length === 0
            ? 'Add product photos first.'
            : 'Every photo has a result. Use Edit again on one to send it again.',
        );
      }
      return;
    }
    const model = arg?.model ?? ctx.model().model;
    if (!model) return;
    const support = editSupport(model, await ctx.models.imageControls(model));
    if (!support.ok) throw new InvalidInputError(support.reason);
    const request = {
      instruction: buildInstruction({ shadow: settings.shadow }),
      params: support.params,
      sendSize: settings.sendSize,
    };
    // Refused before anything is sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      {
        title: batchTitle(
          targets.map((photo) => photo.name),
          { retry: arg !== undefined, noun: 'photo' },
        ),
        // A retry books only its photos (and its own model); a plain run uses the header's estimate.
        ...(arg ? { model, estimateUsd: await estimateFor(model, targets) } : {}),
      },
      signal,
    );
    lastRun = handle.id;

    // Photos removed while the run was being approved are not sent.
    targets = targets.filter((photo) => photos.includes(photo));
    for (const photo of targets) {
      photo.job?.controller.abort();
      photo.job = null;
      photo.phase = 'queued';
      photo.error = null;
    }
    running = true;
    let finished = 0;
    const updateProgress = (): void => {
      const text = `${finished} of ${plural(targets.length, 'photo')}`;
      progress.element.hidden = false;
      progress.update(finished, targets.length, text);
      ui.progress(text);
    };
    renderPhotos();
    renderGrid();
    updateDetail();
    ui.status(`Isolating ${plural(targets.length, 'photo')}…`);
    updateProgress();
    try {
      const outcome = await runItems({
        items: targets,
        concurrency: settings.concurrency,
        signal: handle.signal,
        work: (photo, itemSignal) => isolate(handle, photo, request, itemSignal),
        onItem: ({ item: photo, status, error }) => {
          if (status === 'running') photo.phase = 'editing';
          else if (status === 'done') photo.phase = 'done';
          else if (status === 'failed') {
            photo.phase = 'failed';
            photo.error = userMessage(error);
          } else photo.phase = status;
          if (status !== 'running' && status !== 'queued') finished += 1;
          updateCard(photo);
          updatePhotoRow(photo);
          if (detail?.key === photo.key) updateDetail();
          updateProgress();
        },
      });
      const passed = targets.filter((photo) => photo.result?.qa.pass).length;
      const results = targets.filter((photo) => photo.result).length;
      await handle.finish({
        output: historyText(),
        meta: { photos: targets.length, passedQa: passed, failedQa: results - passed },
      });
      const counts = `${batchSummary(outcome, 'photo')} · ${passed} passed QA${results > passed ? `, ${results - passed} failed QA` : ''}`;
      ui.status([counts, ...problemsOf(targets)].join(' · '));
    } catch (error) {
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      running = false;
      renderPhotos();
      renderGrid();
      updateDetail();
      void ui.refreshEstimate();
      // Settings changed during the run, or a Stop came between a paid answer and its result.
      reconcile();
    }
  };

  /**
   * A photo the failed run already made: the error toast's Retry (a 402 part-way) must not pay for it again. A
   * photo that had a result from an earlier run and failed now ("Edit again") is still to do; a removed one is not.
   */
  const madeByLastRun = (key: string): boolean => {
    const photo = photoOf(key);
    return !photo || (photo.result !== null && photo.editRun === lastRun);
  };
  const remaining = pendingOnly(madeByLastRun);

  const runner = ui.runner<RunArg>({
    label: 'Isolate',
    icon: 'bounding-box',
    run,
    replayArg: (arg) => {
      if (!arg) return undefined;
      const keys = remaining(arg.keys);
      return keys ? { ...arg, keys } : null;
    },
  });
  const gate = retryGate(runner);
  gate.bind(retryFailedButton);

  const retry = (list: readonly Photo[], model?: string): void => {
    if (list.length === 0) return;
    const keys = list.map((photo) => photo.key);
    gate.retry(model ? { keys, model } : { keys }, 'Isolating cannot start now.');
  };

  const retryWithModel = async (photo: Photo): Promise<void> => {
    const blocked = gate.blocked();
    if (blocked) {
      announce(blocked);
      return;
    }
    try {
      const chosen = await modelPicker(ctx, {
        capability: 'image',
        selected: photo.model ?? ctx.model().model,
        title: `Retry ${photo.name} with another model`,
      });
      if (chosen && photos.includes(photo)) retry([photo], chosen);
    } catch (error) {
      void presentError(error);
    }
  };

  // --- export ---------------------------------------------------------------------------------------------
  const downloadZip = async (): Promise<void> => {
    const done = photos.flatMap((photo) => (photo.result ? [photo.result] : []));
    if (done.length === 0) return;
    zipButton.disabled = true;
    try {
      const zip = await zipFiles(
        done.map((result) => ({ name: result.handle.result.name, data: result.blob })),
      );
      downloadBlob(zip, `isolated-images-${utcDay()}.zip`);
      for (const result of done) ctx.results.markDownloaded(result.handle.result.id);
      ui.status(`Downloaded ${plural(done.length, 'image')} as a ZIP.`);
    } catch (error) {
      void presentError(error, { retry: () => void downloadZip() });
    } finally {
      zipButton.disabled = withResults().length === 0;
    }
  };

  // --- instance -------------------------------------------------------------------------------------------
  syncControls();
  renderPhotos();
  renderGrid();

  return {
    // Promptless: the instruction is fixed (no notes that could weaken "keep the product unchanged"), so the
    // form is its settings, and Prompts saves them as presets.
    promptless: true,
    getState: (): ToolSnapshot => ({ prompt: '', settings: { ...settings } }),
    applyState: ({ settings: saved }) => {
      const before = settings;
      settings = readSettings(saved, settings);
      syncControls();
      settingsChanged(before);
      void ui.refreshEstimate();
    },
    estimate: async (model) => {
      const version = ++estimateVersion;
      const usd = await estimateFor(model, pending());
      if (version === estimateVersion) {
        lastEstimate = usd;
        renderCount();
      }
      return usd;
    },
    onFiles: (files) => addPhotos(files),
    onReceive: (items) =>
      addPhotos(
        items.flatMap((item) =>
          item.kind === 'file' ? [new File([item.blob], item.name, { type: item.blob.type })] : [],
        ),
      ),
    sample: async () => {
      addPhotos([await samplePhoto()]);
    },
  };
}
