/**
 * Image generation on `POST /images` (docs/openrouter-api.md §3; the chat route needs $1 of balance, §0): a
 * prompt with style notes and things to avoid folded in, the controls the chosen model offers (its
 * `supported_parameters` from `GET /images/models`), reference images, and a session gallery.
 *
 * One Generate press is one run. Several images go out as one request with `n` when the model takes it, else
 * as several requests (`runItems`, three at a time), each with its own seed so a locked seed does not repeat
 * one picture. Streaming models (OpenAI) send partial images, shown in the waiting card. A failed request
 * keeps its card with Retry (a run of one, same seed). Each image is an `imageResultCard` with Variations (a
 * run of one with a new seed), Use as reference and Edit (Send to Image editor). History keeps the prompt and
 * settings, never the images.
 */
import type { GeneratedImage, ImageRequest, RawImageModel } from '../../core/api/types';
import { InvalidInputError, userMessage } from '../../core/errors';
import { imageSize, loadImage, toDataUrl } from '../../core/media/image';
import type { RunHandle } from '../../core/types';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { imageResultCard } from '../../ui/components/image-result-card';
import { progressBar } from '../../ui/components/progress-bar';
import { switchField } from '../../ui/components/switch-field';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented, presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatBytes, formatDateTime, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { type ItemStatus, runItems } from '../../ui/tool/batch';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import { sendItems } from '../../ui/tool/send-to';
import {
  approxDimensions,
  bareControls,
  buildRequests,
  DEFAULT_FORM,
  effective,
  formSettings,
  type GenerationForm,
  MAX_IMAGES,
  MAX_SEED,
  type ModelControls,
  modelControls,
  parseForm,
  parseSize,
  planRequests,
  ratioOf,
  referenceProblem,
  type RequestPlan,
} from './params';

/** References are scaled to this before upload: plenty to guide a model, and well under body limits. */
const REFERENCE_MAX_SIDE = 2048;
const REFERENCE_MAX_BYTES = 4 * 1024 * 1024;
/** Requests in flight at once. */
const CONCURRENCY = 3;
const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

interface Reference {
  id: string;
  file: File;
  url: string;
}

/** One Generate press (or a variation): its heading, grid and requests. */
interface Group {
  model: string;
  form: GenerationForm;
  /** The references as sent (data URLs), so a variation or retry sends the same ones. */
  references: string[];
  stem: string;
  section: HTMLElement;
  grid: HTMLElement;
  bar: ReturnType<typeof progressBar>;
  items: Item[];
}

/** One request: a waiting card until it settles, then its images' cards (or a failed card). */
interface Item {
  group: Group;
  plan: RequestPlan;
  /** Number of the first image in the group (1-based), for titles and file names. */
  first: number;
  status: ItemStatus;
  error: string | null;
  slot: HTMLElement;
  partialUrl: string | null;
}

/** A finished image: what a variation repeats. */
interface Generation {
  group: Group;
  body: ImageRequest;
  blob: Blob;
  name: string;
}

type RunArg = { retry: Item } | { variation: Generation };

const randomSeed = (): number => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) % MAX_SEED;

/** A short file stem from the prompt: `lighthouse-on-a-rocky-coast`. */
export function stemFrom(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5);
  return words.join('-').slice(0, 48) || 'image';
}

async function dimensionsOf(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const image = await loadImage(blob);
    try {
      return imageSize(image);
    } finally {
      if ('close' in image) image.close();
    }
  } catch {
    return null;
  }
}

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const isFinal = (status: ItemStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'stopped';

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  let form: GenerationForm = { ...DEFAULT_FORM };
  const ids = {
    prompt: uid('imagegen-prompt'),
    style: uid('imagegen-style'),
    negative: uid('imagegen-negative'),
    count: uid('imagegen-count'),
    countHelp: uid('imagegen-count-help'),
    resolution: uid('imagegen-resolution'),
    size: uid('imagegen-size'),
    sizeHelp: uid('imagegen-size-help'),
    quality: uid('imagegen-quality'),
    format: uid('imagegen-format'),
    seed: uid('imagegen-seed'),
    seedHelp: uid('imagegen-seed-help'),
  };

  // --- the image models (supported_parameters) --------------------------------------------------------------
  let imageModels: RawImageModel[] | null = null;
  let imageModelsFailed = false;
  let loading: Promise<void> | null = null;
  /** Reads the list (the cache when it has one); 
eread after a refresh elsewhere, never forcing the network. */
  const loadImageModels = (reread = false): Promise<void> => {
    if (loading && !reread) return loading;
    loading = ctx.models
      .imageModels()
      .then((list) => {
        imageModels = list;
        imageModelsFailed = false;
      })
      .catch(() => {
        imageModelsFailed = imageModels === null;
      });
    return loading;
  };
  /** The model's controls; null when the image endpoint does not serve it. Loads the list on first use. */
  const controlsFor = async (model: string): Promise<ModelControls | null> => {
    await loadImageModels();
    if (imageModelsFailed) return bareControls(model);
    const raw = imageModels?.find((entry) => entry.id === model);
    return raw ? modelControls(raw) : null;
  };

  let current: { model: string | null; controls: ModelControls | null; missing: boolean } = {
    model: null,
    controls: null,
    missing: false,
  };

  // --- prompt ----------------------------------------------------------------------------------------------
  const prompt = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 4,
    placeholder: 'For example: a lighthouse on a rocky coast at dusk, warm light in the windows',
    'data-testid': 'tool-prompt',
  });
  const textInput = (id: string, placeholder: string, testId: string): HTMLInputElement =>
    h('input', {
      id,
      type: 'text',
      class: 'form-control',
      placeholder,
      autocomplete: 'off',
      'data-testid': testId,
    });
  const style = textInput(ids.style, 'Watercolour, soft light', 'imagegen-style');
  const negative = textInput(ids.negative, 'Text, watermarks', 'imagegen-negative');
  prompt.addEventListener('input', () => {
    form.prompt = prompt.value;
    formChanged();
  });
  style.addEventListener('input', () => {
    form.style = style.value;
    formChanged();
  });
  negative.addEventListener('input', () => {
    form.negative = negative.value;
    formChanged();
  });

  // --- aspect ratio chips ----------------------------------------------------------------------------------
  const aspectName = uid('imagegen-aspect');
  const aspectChips = h('div', {
    class: 'd-flex flex-wrap gap-2',
    'data-testid': 'imagegen-aspect',
  });
  const aspectNote = h('div', { class: 'form-text', 'data-testid': 'imagegen-aspect-note' });
  const aspectFieldset = h(
    'fieldset',
    null,
    h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Aspect ratio'),
    aspectChips,
    aspectNote,
  );
  const chip = (value: string): HTMLElement => {
    const id = uid('imagegen-aspect-option');
    const ratio = ratioOf(value);
    const box = h('span', {
      class: ['or-aspect-box', ratio === null && 'is-auto'],
      'aria-hidden': 'true',
      style:
        ratio === null
          ? {}
          : {
              '--or-aspect-w': `${ratio >= 1 ? 1 : ratio}`,
              '--or-aspect-h': `${ratio >= 1 ? 1 / ratio : 1}`,
            },
    });
    const input = h('input', {
      id,
      type: 'radio',
      class: 'btn-check',
      name: aspectName,
      value,
      autocomplete: 'off',
      'data-focus-key': `aspect:${value}`,
      'data-testid': `imagegen-aspect-${value.replace(/[^a-z0-9]+/gi, '-')}`,
      checked: form.aspectRatio === value,
      onchange: () => {
        if (!input.checked) return;
        form.aspectRatio = value;
        aspectNote.textContent = '';
        formChanged();
      },
    });
    return h(
      'span',
      null,
      input,
      h(
        'label',
        {
          class:
            'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2 or-aspect-chip',
          htmlFor: id,
        },
        box,
        value === 'auto' ? 'Auto' : value,
      ),
    );
  };
  const renderAspect = (): void => {
    const values = current.controls?.aspectRatios ?? null;
    aspectFieldset.hidden = values === null;
    if (!values) return;
    replace(aspectChips, values.map(chip));
    aspectNote.textContent =
      form.aspectRatio && !values.includes(form.aspectRatio)
        ? `${form.aspectRatio} is not offered by this model: it uses its default shape.`
        : '';
  };

  // --- number of images ------------------------------------------------------------------------------------
  const count = h(
    'select',
    {
      id: ids.count,
      class: 'form-select',
      'aria-describedby': ids.countHelp,
      'data-testid': 'imagegen-count',
      onchange: () => {
        form.count = Number(count.value) || 1;
        formChanged();
      },
    },
    Array.from({ length: MAX_IMAGES }, (_, i) =>
      h('option', { value: String(i + 1) }, plural(i + 1, 'image')),
    ),
  );
  const countHelp = h('div', { id: ids.countHelp, class: 'form-text' });
  const renderCountHelp = (): void => {
    const controls = current.controls;
    if (!controls) {
      countHelp.textContent = '';
      return;
    }
    const requests = planRequests(form.count, controls).length;
    countHelp.textContent =
      form.count === 1
        ? 'One request.'
        : requests === 1
          ? `One request for ${form.count} images.`
          : `${requests} requests: this model makes ${controls.n && controls.n.max > 1 ? `up to ${controls.n.max}` : 'one image'} at a time.`;
  };

  // --- reference images ------------------------------------------------------------------------------------
  const references: Reference[] = [];
  const referenceList = h('ul', {
    class: 'list-unstyled d-flex flex-wrap gap-3 mb-0 empty-hidden',
    'aria-label': 'Reference images',
    'data-testid': 'imagegen-references',
  });
  const referenceCount = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'imagegen-reference-count',
  });
  const referenceDrop = h('div');
  const referenceNote = h('div', { class: 'form-text', 'data-testid': 'imagegen-reference-note' });
  const referenceHeading = uid('imagegen-references-heading');
  const referenceSection = h(
    'section',
    { class: 'd-flex flex-column gap-2', 'aria-labelledby': referenceHeading },
    h(
      'div',
      { class: 'd-flex align-items-baseline gap-2' },
      h(
        'h3',
        { id: referenceHeading, class: 'form-label fw-semibold fs-6 mb-0 me-auto' },
        'Reference images',
      ),
      referenceCount,
    ),
    referenceList,
    referenceDrop,
    referenceNote,
  );
  const referenceMax = (): number => current.controls?.references?.max ?? 0;
  const modelName = (): string => current.controls?.name ?? 'This model';

  const renderReferences = (): void => {
    const max = referenceMax();
    replace(
      referenceList,
      references.map((reference, index) =>
        h(
          'li',
          { class: 'or-reference', 'data-testid': 'imagegen-reference' },
          h('img', {
            src: reference.url,
            alt: `Reference ${index + 1}: ${reference.file.name}`,
            class: 'rounded border object-fit-cover',
            width: 72,
            height: 72,
          }),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-light border or-reference-remove',
              'aria-label': `Remove reference ${index + 1}, ${reference.file.name}`,
              'data-focus-key': `reference-remove:${reference.id}`,
              'data-testid': 'imagegen-reference-remove',
              onclick: () => removeReference(reference),
            },
            icon('x-lg'),
          ),
        ),
      ),
    );
    referenceCount.textContent = max > 0 ? `${references.length} of ${max}` : '';
    const room = max - references.length;
    replace(
      referenceDrop,
      room > 0
        ? dropZone({
            accept: ctx.manifest.accepts,
            multiple: room > 1,
            compact: true,
            label: room > 1 ? 'Drop reference images (optional)' : 'Drop a reference image',
            hint: 'PNG, JPEG or WebP: the model follows their content or style',
            testId: 'imagegen-reference-drop',
            onFiles: (files) => addReferences(files),
          })
        : null,
    );
    const limits = current.controls?.references;
    referenceNote.textContent = !current.controls
      ? ''
      : (referenceProblem(references.length, current.controls) ??
        (limits && limits.max > 0 && room === 0 ? `That is as many as ${modelName()} takes.` : ''));
    referenceSection.hidden = (!limits || limits.max === 0) && references.length === 0;
  };

  const addReferences = (files: readonly File[]): void => {
    const room = Math.max(0, referenceMax() - references.length);
    const taken = files.slice(0, room);
    for (const file of taken) {
      references.push({ id: uid('ref'), file, url: URL.createObjectURL(file) });
    }
    if (taken.length < files.length) {
      ui.status(
        room === 0
          ? `${modelName()} takes no more reference images.`
          : `Added ${plural(taken.length, 'reference image')}; ${files.length - taken.length} did not fit.`,
      );
    } else if (taken.length > 0) {
      announce(`Added ${plural(taken.length, 'reference image')}.`);
    }
    renderReferences();
    formChanged();
  };
  const removeReference = (reference: Reference): void => {
    const at = references.indexOf(reference);
    if (at < 0) return;
    references.splice(at, 1);
    URL.revokeObjectURL(reference.url);
    renderReferences();
    formChanged();
    announce(`Removed reference ${at + 1}.`);
  };

  // --- model notes -----------------------------------------------------------------------------------------
  const notes = h('div', {
    class: 'd-flex flex-column gap-2 empty-hidden',
    'data-testid': 'imagegen-notes',
  });
  const renderNotes = (): void => {
    const list: HTMLElement[] = [];
    if (current.missing && current.model) {
      list.push(
        h(
          'div',
          {
            class: 'alert alert-warning mb-0 small',
            role: 'note',
            'data-testid': 'imagegen-missing',
          },
          `${current.model} is not served by the image endpoint. Choose another model with the model button above.`,
        ),
      );
    } else if (imageModelsFailed && current.model) {
      list.push(
        h(
          'div',
          { class: 'alert alert-info mb-0 small', role: 'note' },
          'The model options could not be loaded, so only the prompt is sent.',
        ),
      );
    }
    if (current.controls) {
      for (const note of effective(form, current.controls).notes) {
        list.push(h('div', { class: 'small text-warning-emphasis', role: 'note' }, note));
      }
    }
    replace(notes, list);
  };

  ui.input.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.prompt }, 'Describe the image'),
      prompt,
    ),
    h(
      'div',
      { class: 'row g-3' },
      h(
        'div',
        { class: 'col-sm-6' },
        h('label', { class: 'form-label', htmlFor: ids.style }, 'Style (optional)'),
        style,
      ),
      h(
        'div',
        { class: 'col-sm-6' },
        h('label', { class: 'form-label', htmlFor: ids.negative }, 'Avoid (optional)'),
        negative,
      ),
    ),
    aspectFieldset,
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.count }, 'Number of images'),
      count,
      countHelp,
    ),
    referenceSection,
    notes,
  );

  // --- drawer: model options -------------------------------------------------------------------------------
  /** A select whose options follow the model; "Model default" sends nothing. */
  const modelSelect = (
    id: string,
    label: string,
    testId: string,
    field: 'resolution' | 'quality' | 'outputFormat',
    describe: (value: string) => string = (value) => value,
  ): { element: HTMLElement; render: (values: string[] | null) => void } => {
    const select = h('select', {
      id,
      class: 'form-select',
      'data-testid': testId,
      onchange: () => {
        form[field] = select.value;
        note.textContent = '';
        formChanged();
      },
    });
    const note = h('div', { class: 'form-text' });
    return {
      element: h(
        'div',
        null,
        h('label', { class: 'form-label', htmlFor: id }, label),
        select,
        note,
      ),
      render: (values) => {
        select.disabled = values === null;
        replace(
          select,
          values === null
            ? h('option', { value: '' }, 'Not offered by this model')
            : [
                h('option', { value: '' }, 'Model default'),
                values.map((value) => h('option', { value }, describe(value))),
              ],
        );
        select.value = values?.includes(form[field]) ? form[field] : '';
        note.textContent =
          values && form[field] && !values.includes(form[field])
            ? `${describe(form[field])} is not offered by this model.`
            : '';
      },
    };
  };
  const resolution = modelSelect(ids.resolution, 'Resolution', 'imagegen-resolution', 'resolution');
  const quality = modelSelect(
    ids.quality,
    'Quality',
    'imagegen-quality',
    'quality',
    (value) => value.charAt(0).toUpperCase() + value.slice(1),
  );
  const outputFormat = modelSelect(
    ids.format,
    'File format',
    'imagegen-format',
    'outputFormat',
    (value) => value.toUpperCase(),
  );

  const size = h('input', {
    id: ids.size,
    type: 'text',
    class: 'form-control',
    placeholder: '1024x1024',
    autocomplete: 'off',
    'aria-describedby': ids.sizeHelp,
    'data-testid': 'imagegen-size',
  });
  size.addEventListener('input', () => {
    form.size = size.value;
    formChanged();
  });
  const sizeHelp = h('div', { id: ids.sizeHelp, class: 'form-text' });
  const sizeField = h(
    'div',
    null,
    h('label', { class: 'form-label', htmlFor: ids.size }, 'Exact size (optional)'),
    size,
    sizeHelp,
  );
  const renderSizeHelp = (): void => {
    const sizes = current.controls?.sizes ?? null;
    sizeField.hidden = sizes === null;
    sizeHelp.textContent =
      form.size.trim() && !parseSize(form.size)
        ? 'Write it as width x height, for example 1024x1024.'
        : sizes && sizes !== true
          ? `Width x height in pixels: ${sizes.join(', ')}. Replaces the aspect ratio and resolution.`
          : 'Width x height in pixels. Replaces the aspect ratio and resolution.';
  };

  const transparent = switchField({
    label: 'Transparent background',
    help: 'Needs PNG or WebP; the file format follows.',
    checked: false,
    testId: 'imagegen-transparent',
    onChange: (checked) => {
      form.transparent = checked;
      formChanged();
    },
  });

  const seed = h('input', {
    id: ids.seed,
    type: 'number',
    class: 'form-control',
    min: '0',
    max: String(MAX_SEED),
    step: '1',
    inputMode: 'numeric',
    placeholder: 'New each run',
    'aria-describedby': ids.seedHelp,
    'data-testid': 'imagegen-seed',
  });
  seed.addEventListener('input', () => {
    const value = Number(seed.value);
    form.seed =
      seed.value.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= MAX_SEED
        ? value
        : null;
    formChanged();
  });
  const seedLock = h('button', {
    type: 'button',
    class: 'btn btn-outline-secondary',
    'aria-pressed': 'false',
    'aria-label': 'Lock the seed',
    title: 'Lock the seed',
    'data-testid': 'imagegen-seed-lock',
    onclick: () => {
      form.seedLocked = !form.seedLocked;
      if (form.seedLocked && form.seed === null) form.seed = randomSeed();
      renderSeed();
      formChanged();
      announce(form.seedLocked ? `Seed locked at ${form.seed}.` : 'Seed unlocked.');
    },
  });
  const seedRandom = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary',
      'aria-label': 'New random seed',
      title: 'New random seed',
      'data-testid': 'imagegen-seed-random',
      onclick: () => {
        form.seed = randomSeed();
        renderSeed();
        formChanged();
        announce(`Seed ${form.seed}.`);
      },
    },
    icon('shuffle'),
  );
  const seedHelp = h('div', { id: ids.seedHelp, class: 'form-text' });
  const renderSeed = (): void => {
    const supported = current.controls?.seed ?? false;
    seed.value = form.seed === null ? '' : String(form.seed);
    seed.disabled = !supported;
    seedLock.disabled = !supported;
    seedRandom.disabled = !supported;
    seedLock.setAttribute('aria-pressed', String(form.seedLocked));
    seedLock.replaceChildren(icon(form.seedLocked ? 'lock-fill' : 'unlock'));
    seedHelp.textContent = !supported
      ? 'This model does not take a seed: every run differs.'
      : form.seedLocked
        ? 'Locked: every run uses this seed, so the same settings give the same picture.'
        : 'Unlocked: each run picks a new seed and shows it here.';
  };

  ui.drawer.append(
    resolution.element,
    sizeField,
    quality.element,
    outputFormat.element,
    transparent.element,
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.seed }, 'Seed'),
      h('div', { class: 'input-group' }, seed, seedLock, seedRandom),
      seedHelp,
    ),
  );

  // --- syncing the form with the model ---------------------------------------------------------------------
  /** Redraws everything that depends on the model (on a model change and when a stored form is applied). */
  const renderModel = (): void => {
    const controls = current.controls;
    renderAspect();
    resolution.render(controls?.resolutions ?? null);
    quality.render(controls?.qualities ?? null);
    outputFormat.render(controls?.outputFormats ?? null);
    transparent.input.checked = form.transparent;
    transparent.input.disabled = !(controls?.backgrounds?.includes('transparent') ?? false);
    count.value = String(form.count);
    renderSeed();
    renderReferences();
    formChanged();
  };

  /** What follows any input: the notes, the help lines and the estimate. */
  function formChanged(): void {
    renderCountHelp();
    renderSizeHelp();
    renderNotes();
    void ui.refreshEstimate();
  }

  let syncGeneration = 0;
  /** Picks up a model change (header chip, settings, free-only, a catalog refresh). */
  const syncModel = async (): Promise<void> => {
    const mine = ++syncGeneration;
    const model = ctx.model().model;
    const controls = model ? await controlsFor(model) : null;
    if (mine !== syncGeneration) return;
    current = { model, controls, missing: model !== null && controls === null };
    runner.setDisabled(current.missing ? `${model} is not available for image generation.` : null);
    renderModel();
  };

  // --- output: the gallery ---------------------------------------------------------------------------------
  const empty = emptyState({
    icon: 'image',
    title: 'No images yet',
    text: 'Describe an image and press Generate. Results stay here for this visit; download the ones you keep.',
    testId: 'imagegen-empty',
  });
  empty.tabIndex = -1;
  const gallery = h('div', { class: 'vstack gap-4', 'data-testid': 'imagegen-gallery' });
  ui.output.append(empty, gallery);
  const groups: Group[] = [];
  const showEmpty = (): void => {
    empty.hidden = groups.length > 0;
  };

  const dropGroupIfEmpty = (group: Group): void => {
    if (group.grid.childElementCount > 0) return;
    group.section.remove();
    const at = groups.indexOf(group);
    if (at >= 0) groups.splice(at, 1);
    showEmpty();
  };

  /** Where focus goes when a card goes and no other image card took it. */
  const focusAfterRemoval = (): HTMLElement | null =>
    gallery.querySelector<HTMLElement>('.btn-outline-danger') ?? (empty.hidden ? null : empty);

  const titleOf = (item: Item, offset = 0): string =>
    item.group.form.count > 1 ? `Image ${item.first + offset}` : 'Result';

  const drawWaiting = (item: Item): void => {
    const many = item.plan.images > 1;
    const label =
      item.status === 'queued'
        ? `Waiting to start${many ? `: ${item.plan.images} images` : ''}…`
        : `Generating${many ? ` ${item.plan.images} images` : ''}…`;
    replace(
      item.slot,
      h(
        'div',
        { class: 'card h-100', 'data-testid': 'imagegen-waiting' },
        h(
          'div',
          { class: 'card-body vstack gap-2' },
          h('h4', { class: 'h6 mb-0' }, titleOf(item)),
          item.partialUrl
            ? h(
                'figure',
                { class: 'mb-0' },
                h('img', {
                  src: item.partialUrl,
                  alt: `Partial preview of ${titleOf(item).toLowerCase()}`,
                  class: 'img-fluid rounded border or-checkerboard',
                  'data-testid': 'imagegen-partial',
                }),
                h(
                  'figcaption',
                  { class: 'small text-body-secondary mt-1' },
                  'Preview: still drawing…',
                ),
              )
            : h(
                'div',
                { class: 'or-image-placeholder rounded border', 'aria-hidden': 'true' },
                h('div', { class: 'spinner-border text-secondary' }),
              ),
          h('div', { class: 'small text-body-secondary' }, label),
        ),
      ),
    );
  };

  const drawFailed = (item: Item): void => {
    const title = titleOf(item);
    replace(
      item.slot,
      h(
        'div',
        { class: 'card h-100', 'data-testid': 'imagegen-failed' },
        h(
          'div',
          { class: 'card-body vstack gap-2' },
          h('h4', { class: 'h6 mb-0' }, title),
          h(
            'div',
            { class: 'small text-danger-emphasis', role: 'note', 'data-testid': 'imagegen-error' },
            item.status === 'stopped'
              ? 'Stopped before it was ready.'
              : (item.error ?? 'It failed.'),
          ),
          h(
            'div',
            { class: 'd-flex flex-wrap gap-2 mt-auto' },
            gate.bind(
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
                  'aria-label': `Retry ${title.toLowerCase()}`,
                  'data-testid': 'imagegen-retry',
                  onclick: () => gate.retry({ retry: item }, 'Generate cannot start now.'),
                },
                icon('arrow-clockwise'),
                'Retry',
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class:
                  'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 ms-auto',
                'aria-label': `Remove ${title.toLowerCase()}`,
                'data-testid': 'imagegen-failed-remove',
                onclick: () => {
                  item.slot.remove();
                  dropGroupIfEmpty(item.group);
                  focusAfterRemoval()?.focus();
                  announce(`Removed ${title.toLowerCase()}.`);
                },
              },
              icon('trash'),
              'Remove',
            ),
          ),
        ),
      ),
    );
  };

  const useAsReference = (generation: Generation): void => {
    const max = referenceMax();
    if (references.length >= max) {
      ui.status(
        max === 0
          ? `${modelName()} does not take reference images.`
          : `${modelName()} takes at most ${plural(max, 'reference image')}.`,
      );
      return;
    }
    addReferences([new File([generation.blob], generation.name, { type: generation.blob.type })]);
    ui.status(`${generation.name} is now a reference image.`);
  };

  const sendToEditor = (generation: Generation): void => {
    sendItems('image-editor', [{ kind: 'file', blob: generation.blob, name: generation.name }])
      .then(() =>
        toast({ message: `Sent ${generation.name} to Image editor.`, variant: 'success' }),
      )
      .catch((error: unknown) => void presentError(error));
  };

  /** The cards of a finished request, in place of its waiting card. */
  const showImages = async (item: Item, images: GeneratedImage[]): Promise<void> => {
    const group = item.group;
    const body = item.plan.body;
    const columns = await Promise.all(
      images.map(async (image, offset) => {
        const name = `${group.stem}-${item.first + offset}.${EXTENSION[image.mediaType] ?? 'png'}`;
        const size = await dimensionsOf(image.blob);
        const title = titleOf(item, offset);
        const column = h('div', { class: 'col', 'data-testid': 'imagegen-image' });
        const generation: Generation = { group, body, blob: image.blob, name };
        const card = imageResultCard({
          ui,
          blob: image.blob,
          name,
          title,
          headingLevel: 4,
          alt: `Generated from: ${shorten(group.form.prompt.trim(), 160)}`,
          meta: [
            size ? `${size.width} × ${size.height}` : null,
            body.seed !== undefined ? `seed ${body.seed}` : null,
            formatBytes(image.blob.size),
          ],
          formats: ['png', 'jpg', 'webp'],
          actions: [
            {
              label: 'Variations',
              icon: 'shuffle',
              ariaLabel: `Make a variation of ${title.toLowerCase()}`,
              testId: 'imagegen-vary',
              onClick: () =>
                void gate.retry({ variation: generation }, 'Generate cannot start now.'),
            },
            {
              label: 'Use as reference',
              icon: 'images',
              ariaLabel: `Use ${title.toLowerCase()} as a reference image`,
              testId: 'imagegen-use-reference',
              onClick: () => useAsReference(generation),
            },
            {
              label: 'Edit',
              icon: 'brush',
              ariaLabel: `Edit ${title.toLowerCase()} in Image editor`,
              testId: 'imagegen-edit',
              onClick: () => sendToEditor(generation),
            },
          ],
          onRemove: () => {
            column.remove();
            dropGroupIfEmpty(group);
          },
          focusFallback: focusAfterRemoval,
          testId: 'imagegen',
        });
        column.append(card.element);
        return column;
      }),
    );
    if (item.partialUrl) URL.revokeObjectURL(item.partialUrl);
    item.partialUrl = null;
    item.slot.replaceWith(...columns);
  };

  const settle = (item: Item, status: ItemStatus, error?: unknown): void => {
    item.status = status;
    if (status === 'done') return; // its images replaced the card already
    if (status === 'failed') item.error = userMessage(error);
    if (status === 'queued' || status === 'running') {
      drawWaiting(item);
      return;
    }
    if (item.partialUrl) URL.revokeObjectURL(item.partialUrl);
    item.partialUrl = null;
    drawFailed(item);
  };

  /** "1 of 3 requests done", or '' for a single request. */
  const requestProgress = (items: readonly Item[]): string => {
    if (items.length < 2) return '';
    const done = items.filter((item) => isFinal(item.status)).length;
    return `${done} of ${plural(items.length, 'request')} done`;
  };
  const updateBar = (group: Group, items: readonly Item[]): void => {
    const done = items.filter((item) => isFinal(item.status)).length;
    group.bar.element.hidden = items.length < 2 || done === items.length;
    group.bar.update(done, items.length, requestProgress(items));
  };

  /** One request: streamed partials go to the waiting card; the images replace it. */
  const generate = async (run: RunHandle, item: Item, signal: AbortSignal): Promise<number> => {
    const result = await ctx.api.images(item.plan.body, {
      run,
      signal,
      onPartial: (partial) => {
        if (item.status !== 'running') return;
        if (item.partialUrl) URL.revokeObjectURL(item.partialUrl);
        item.partialUrl = URL.createObjectURL(partial.blob);
        drawWaiting(item);
      },
    });
    await showImages(item, result.images);
    if (result.error) {
      announce(`Some images arrived before an error: ${userMessage(result.error)}`);
    }
    return result.images.length;
  };

  /** A new group at the top of the gallery, its requests waiting. */
  const startGroup = (
    model: string,
    groupForm: GenerationForm,
    sent: string[],
    plans: RequestPlan[],
    heading: string,
  ): Group => {
    const grid = h('div', {
      class: ['row row-cols-1 g-3', groupForm.count > 1 && 'row-cols-md-2'],
    });
    const bar = progressBar({
      label: 'Requests done',
      hidden: true,
      testId: 'imagegen-progress',
    });
    const group: Group = {
      model,
      form: groupForm,
      references: sent,
      stem: stemFrom(groupForm.prompt),
      section: h('section', { class: 'vstack gap-2', 'data-testid': 'imagegen-group' }),
      grid,
      bar,
      items: [],
    };
    let first = 1;
    group.items = plans.map((plan) => {
      const item: Item = {
        group,
        plan,
        first,
        status: 'queued',
        error: null,
        slot: h('div', { class: 'col' }),
        partialUrl: null,
      };
      first += plan.images;
      return item;
    });
    replace(
      group.section,
      h(
        'h3',
        { class: 'h6 mb-0 text-body-secondary' },
        `${formatDateTime(Date.now())} · ${heading}`,
      ),
      h('p', { class: 'small mb-0 text-break' }, shorten(groupForm.prompt.trim(), 240)),
      bar.element,
      grid,
    );
    grid.append(...group.items.map((item) => item.slot));
    groups.unshift(group);
    gallery.prepend(group.section);
    showEmpty();
    for (const item of group.items) drawWaiting(item);
    return group;
  };

  let ticker: ReturnType<typeof setInterval> | null = null;
  const stopTicker = (): void => {
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  /** Runs `items` of `group` inside `handle`'s run, and ends the run. */
  const runGroup = async (handle: RunHandle, group: Group, items: Item[]): Promise<void> => {
    const started = Date.now();
    ui.status('Generating…');
    stopTicker();
    ticker = setInterval(() => {
      const counter = requestProgress(items);
      ui.progress(
        `Generating… ${Math.round((Date.now() - started) / 1000)} s${counter ? ` · ${counter}` : ''}`,
      );
    }, 1000);
    updateBar(group, items);
    try {
      const outcome = await runItems({
        items,
        concurrency: Math.min(items.length, CONCURRENCY),
        signal: handle.signal,
        work: (item, signal) => generate(handle, item, signal),
        onItem: (entry) => {
          settle(entry.item, entry.status, entry.error);
          updateBar(group, items);
        },
      });
      const made = outcome.outcomes.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
      const summary =
        outcome.failed > 0
          ? `${plural(made, 'image')} ready; ${plural(outcome.failed, 'request')} failed`
          : `${plural(made, 'image')} ready`;
      // The ticker stops first, or a tick during the History write would overwrite the summary.
      stopTicker();
      ui.status(summary);
      const seeds = items
        .map((item) => item.plan.body.seed)
        .filter((value): value is number => value !== undefined);
      await handle.finish({
        output: `${summary}.\nPrompt sent: ${items[0]?.plan.body.prompt ?? ''}`,
        meta: { images: made, failed: outcome.failed, ...(seeds.length ? { seeds } : {}) },
      });
    } catch (error) {
      stopTicker();
      for (const item of items) {
        if (item.status === 'queued' || item.status === 'running') settle(item, 'stopped');
      }
      updateBar(group, items);
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      stopTicker();
    }
  };

  /** The estimate for requests on `model` with a given form (a retry or variation, not the header's form). */
  const estimateFor = async (
    model: string,
    estimateForm: GenerationForm,
    images: number,
    referenceCount: number,
  ): Promise<number | null> => {
    const controls = await controlsFor(model);
    if (!controls) return null;
    const { width, height } = approxDimensions(effective(estimateForm, controls));
    return ctx.models.estimate({
      kind: 'image',
      model,
      images,
      width,
      height,
      references: Math.min(referenceCount, controls.references?.max ?? 0),
    });
  };

  /** A failed request again: a run of one, same body (same seed). */
  const retryItem = async (signal: AbortSignal, item: Item): Promise<void> => {
    const group = item.group;
    if (!item.slot.isConnected || item.status === 'done') return;
    const estimateUsd = await estimateFor(
      group.model,
      group.form,
      item.plan.images,
      group.references.length,
    );
    const handle = await ctx.beginRun(
      {
        model: group.model,
        title: `Retry: ${shorten(group.form.prompt.trim(), 60)}`,
        prompt: '',
        settings: formSettings(group.form),
        estimateUsd,
      },
      signal,
    );
    item.error = null;
    try {
      await runGroup(handle, group, [item]);
    } catch (error) {
      // The card shows what happened, with Retry; no second message for it.
      if (!isStop(error)) markPresented(error);
      throw error;
    }
  };

  /** A variation: the same request and references with a new seed, one image. */
  const vary = async (signal: AbortSignal, generation: Generation): Promise<void> => {
    const source = generation.group;
    const body: ImageRequest = { ...generation.body };
    delete body.n;
    if (body.seed !== undefined) body.seed = randomSeed();
    const variationForm: GenerationForm = {
      ...source.form,
      count: 1,
      seedLocked: false,
      seed: body.seed ?? null,
    };
    const estimateUsd = await estimateFor(source.model, variationForm, 1, source.references.length);
    const handle = await ctx.beginRun(
      {
        model: source.model,
        title: `Variation: ${shorten(source.form.prompt.trim(), 60)}`,
        prompt: source.form.prompt,
        settings: formSettings(variationForm),
        estimateUsd,
      },
      signal,
    );
    const group = startGroup(
      source.model,
      variationForm,
      source.references,
      [{ body, images: 1 }],
      [`Variation of ${generation.name}`, body.seed !== undefined ? `seed ${body.seed}` : null]
        .filter(Boolean)
        .join(' · '),
    );
    await runGroup(handle, group, group.items);
  };

  const run = async (signal: AbortSignal, arg?: RunArg): Promise<void> => {
    if (arg && 'retry' in arg) return retryItem(signal, arg.retry);
    if (arg && 'variation' in arg) return vary(signal, arg.variation);
    const model = ctx.model().model;
    if (!model) return;
    const asked: GenerationForm = { ...form };
    if (!asked.prompt.trim()) {
      ui.status('Describe the image first.');
      prompt.focus();
      return;
    }
    const controls = await controlsFor(model);
    if (!controls) {
      ui.status(`${model} is not available for image generation. Choose another model.`);
      return;
    }
    const problem = referenceProblem(references.length, controls);
    if (problem) {
      ui.status(problem);
      (referenceSection.querySelector<HTMLElement>('button') ?? prompt).focus();
      return;
    }
    // The run's seed: the locked one, else a new one (shown in the field once the run is on).
    const runSeed = controls.seed
      ? asked.seedLocked && asked.seed !== null
        ? asked.seed
        : randomSeed()
      : null;
    const sentForm: GenerationForm = { ...asked, seed: runSeed ?? asked.seed };

    // References are read before anything is sent: one that cannot be read stops here, at no cost.
    let urls: string[];
    try {
      urls = await Promise.all(
        references.map((reference) =>
          toDataUrl(reference.file, {
            maxDimension: REFERENCE_MAX_SIDE,
            maxBytes: REFERENCE_MAX_BYTES,
          }),
        ),
      );
    } catch (error) {
      throw new InvalidInputError(
        `A reference image could not be read (${userMessage(error)}). Remove it or choose another.`,
      );
    }
    const plans = buildRequests({
      model,
      form: sentForm,
      controls,
      references: urls,
      seed: runSeed,
    });

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      { title: shorten(asked.prompt.trim(), 80), settings: formSettings(sentForm) },
      signal,
    );
    if (runSeed !== null && !asked.seedLocked) {
      form.seed = runSeed;
      renderSeed();
    }
    const value = effective(sentForm, controls);
    const heading = [
      controls.name,
      plural(sentForm.count, 'image'),
      value.size ?? value.aspectRatio,
      runSeed !== null ? `seed ${runSeed}` : null,
      urls.length > 0 ? plural(Math.min(urls.length, referenceMax()), 'reference') : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const group = startGroup(model, sentForm, urls, plans, heading);
    await runGroup(handle, group, group.items);
  };

  const runner = ui.runner<RunArg>({ label: 'Generate', icon: 'image', run });
  const gate = retryGate(runner, {
    fallback: () => (runner.busy ? runner.stopButton : runner.button),
  });

  // --- state -----------------------------------------------------------------------------------------------
  const applyForm = (next: GenerationForm): void => {
    form = next;
    prompt.value = form.prompt;
    style.value = form.style;
    negative.value = form.negative;
    size.value = form.size;
    renderModel();
  };

  /** Settles when the current model's controls are known (received files wait for it: they need its limits). */
  let modelReady: Promise<void> = Promise.resolve();
  ctx.settings.subscribe(() => {
    modelReady = syncModel();
  });
  ctx.bus.on('models-refreshed', () => {
    modelReady = loadImageModels(true).then(syncModel);
  });
  renderModel();
  modelReady = syncModel();
  const whenReady = (files: File[]): void => {
    void modelReady.then(() => addReferences(files));
  };

  return {
    getState: () => ({ prompt: form.prompt, settings: formSettings(form) }),
    applyState: ({ prompt: text, settings }) => applyForm(parseForm(text, settings)),
    estimate: async (model) => {
      const controls = await controlsFor(model);
      if (!controls) return null;
      const { width, height } = approxDimensions(effective(form, controls));
      return ctx.models.estimate({
        kind: 'image',
        model,
        images: Math.max(1, Math.min(MAX_IMAGES, form.count)),
        width,
        height,
        references: Math.min(references.length, controls.references?.max ?? 0),
      });
    },
    onFiles: whenReady,
    onReceive: (items) => {
      whenReady(
        items.flatMap((item) =>
          item.kind === 'file' ? [new File([item.blob], item.name, { type: item.blob.type })] : [],
        ),
      );
    },
    sample: () => {
      applyForm({
        ...form,
        prompt: 'A lighthouse on a rocky coast at dusk, warm light in the windows, gentle waves',
        style: 'Watercolour, soft light',
        negative: 'Text, watermarks',
        aspectRatio: '16:9',
      });
    },
  };
}
