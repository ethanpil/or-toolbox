/**
 * Image editor: load a picture, paint a mask on a canvas, and edit it with an image model through `POST /images`
 * in one of three modes: Inpaint (change the painted area), Outpaint (extend the canvas; the new area is the
 * mask) and Whole image (an instruction, no mask).
 *
 * There is no mask parameter (docs/openrouter-api.md §0, §3.3), so a masked edit sends the picture with the area
 * tinted magenta, the plain picture and the mask as a PNG, with an instruction naming the marked area
 * (request.ts). Models decide what they change; "Keep outside the mask" composites the result back onto the
 * picture through the mask (with a soft inner edge), so every pixel outside the mask stays exactly as it was.
 * Outpaint has nothing to blend under its new area, so its soft edge lies on the picture's side of the seam.
 *
 * Sizes: the editor paints at the size the model sees (at most 2048 px a side), and all references of an edit
 * are built from the decoded, upright pixels at that one size; compositing works on the full-size picture.
 * Pictures beyond what browsers can draw are scaled down on load. Only the picture on screen stays decoded.
 * A result of another shape is fitted inside the canvas, never stretched, and the version says so.
 * While an edit runs, loading, switching versions and painting wait for it.
 *
 * Every result is a new version (thumbnail strip); any version can be compared with the one it came from,
 * edited further, downloaded or removed. Versions are session results (leave guard); History keeps the
 * instruction and settings only.
 */
import { partialImageResult } from '../../core/api/client';
import type { GeneratedImage } from '../../core/api/types';
import type { ImageModelControls } from '../../core/models/image-params';
import { InvalidInputError, userMessage } from '../../core/errors';
import {
  fitWithin,
  imageSize,
  loadImage,
  type Mask,
  type RasterImage,
  readImageSize,
  resizeCanvas,
  toBlob,
  toDataUrls,
} from '../../core/media/image';
import {
  compositeMaskedAsync,
  maskOverlayAsync,
  maskToRasterAsync,
} from '../../core/media/image-async';
import type { ImageControlsResult } from '../../core/types';
import { createTicker, debounce } from '../../core/util';
import { type CompareSlider, compareSlider } from '../../ui/components/compare-slider';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { type ImageResultCard, imageResultCard } from '../../ui/components/image-result-card';
import { confirmUndownloaded } from '../../ui/components/result-removal';
import { switchField } from '../../ui/components/switch-field';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, plural, shorten } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { canvasEditor } from './canvas-editor';
import { clipMask, scaleMask } from './mask';
import {
  EXTEND_RATIOS,
  fitResult,
  type Margins,
  OUTPAINT_FILL,
  outpaintMask,
  outpaintPlan,
  pictureMask,
  planProblem,
  scaledPlan,
} from './outpaint';
import { drawToRaster } from './pixels';
import {
  buildEditRequest,
  EDIT_MODES,
  type EditMode,
  type EditorSettings,
  MASK_ALPHA,
  MASK_COLOUR,
  MAX_FEATHER,
  parseSettings,
  referenceRoles,
  settingsRecord,
} from './request';
import { type Version, VersionHistory, versionLabel } from './versions';

/** The size the model sees, and the editor paints at: at most this many pixels a side. */
const WORK_SIDE = 2048;
/**
 * The most pixels a picture may have: Safari's canvas area limit (4096 x 4096), the lowest of the browsers.
 * Bigger pictures are scaled down on load.
 */
const MAX_PIXELS = 16_777_216;
/** How long the outpaint preview waits for typing in the margins to stop. */
const PREVIEW_DELAY_MS = 150;
/** References (marked, plain, mask) are encoded together at one size under these limits. */
const REFERENCE_ENCODING = {
  maxDimension: WORK_SIDE,
  maxBytes: 4 * 1024 * 1024,
  type: 'image/png',
};
/** With the model's limits unknown (the list could not be read), every reference is sent: let it try. */
const ALL_REFERENCES = 3;

const MODE_LABEL: Record<EditMode, string> = {
  inpaint: 'Inpaint',
  outpaint: 'Outpaint',
  whole: 'Whole image',
};

const INSTRUCTION_LABEL: Record<EditMode, string> = {
  inpaint: 'What should the painted area become?',
  outpaint: 'What should the new area show? (optional)',
  whole: 'How should the picture change?',
};

const PLACEHOLDER: Record<EditMode, string> = {
  inpaint: 'For example: a red sailboat on the water',
  outpaint: 'For example: more of the beach and the evening sky',
  whole: 'For example: make it look like a winter evening',
};

/** A file stem without its extension. */
const stemOf = (name: string): string =>
  name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'image';

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  let settings: EditorSettings = parseSettings({});
  const ids = {
    instruction: uid('editor-instruction'),
    extend: uid('editor-extend'),
    feather: uid('editor-feather'),
    featherHelp: uid('editor-feather-help'),
  };

  // --- image models: one policy for every image tool (models.imageControls) --------------------------------
  const controlsFor = (model: string): Promise<ImageControlsResult> =>
    ctx.models.imageControls(model);
  /** The current model's answer, for the notes. */
  let modelState: ImageControlsResult | null = null;
  /** The references an edit sends in `mode` for this model (all of them when its limits are unknown). */
  const rolesFor = (mode: EditMode, result: ImageControlsResult) =>
    referenceRoles(
      mode,
      result.status === 'unknown'
        ? ALL_REFERENCES
        : ((result.status === 'ready' ? result.controls.references?.max : 0) ?? 0),
    );
  // --- versions and decoded pictures -----------------------------------------------------------------------
  type Decoded = ImageBitmap | HTMLImageElement;
  const versions = new VersionHistory();
  const thumbs = new Map<string, string>();
  const cards = new Map<string, ImageResultCard>();
  let originalName = 'image.png';
  /** The one decoded picture kept: the version on screen. Others stay Blobs and are decoded when needed. */
  let onScreen: { id: string; bitmap: Decoded } | null = null;
  /** An edit in flight, from the moment its run starts until its version is shown (or it fails). */
  let editing = false;

  const close = (bitmap: Decoded | null | undefined): void => {
    if (bitmap && 'close' in bitmap) bitmap.close();
  };
  /** The version's decoded picture: the one on screen, or a fresh decode the caller closes (`release`). */
  const decode = async (version: Version): Promise<Decoded> =>
    onScreen?.id === version.id ? onScreen.bitmap : loadImage(version.blob);
  const release = (bitmap: Decoded): void => {
    if (onScreen?.bitmap !== bitmap) close(bitmap);
  };
  /** The size the editor paints at and the model sees, for a picture of `width` x `height`. */
  const workSize = (size: { width: number; height: number }) =>
    fitWithin(size.width, size.height, WORK_SIDE);

  const forget = (id: string): void => {
    if (onScreen?.id === id) {
      close(onScreen.bitmap);
      onScreen = null;
    }
    const thumb = thumbs.get(id);
    if (thumb) URL.revokeObjectURL(thumb);
    thumbs.delete(id);
    cards.delete(id);
  };

  // --- input: the picture ----------------------------------------------------------------------------------
  const sourceSlot = h('div', {
    class: 'd-flex flex-column gap-2',
    'data-testid': 'editor-source',
  });
  const renderSource = (): void => {
    const original = versions.original;
    replace(
      sourceSlot,
      original
        ? h(
            'div',
            { class: 'small text-body-secondary', 'data-testid': 'editor-source-name' },
            `${originalName} · ${original.width} × ${original.height}`,
          )
        : null,
      dropZone({
        accept: ctx.manifest.accepts,
        compact: original !== null,
        label: original ? 'Drop another picture to start over' : 'Drop a picture to edit',
        hint: 'PNG, JPEG or WebP',
        testId: 'editor-drop',
        onFiles: (files) => void loadFile(files[0]),
      }),
    );
  };

  // --- input: mode -----------------------------------------------------------------------------------------
  const modeName = uid('editor-mode');
  const modeInputs = EDIT_MODES.map((mode) => {
    const id = uid('editor-mode-option');
    const input = h('input', {
      id,
      type: 'radio',
      class: 'form-check-input',
      name: modeName,
      value: mode.id,
      'data-testid': `editor-mode-${mode.id}`,
      onchange: () => {
        if (!input.checked) return;
        settings.mode = mode.id;
        modeChanged();
      },
    });
    return {
      mode,
      input,
      element: h(
        'div',
        { class: 'form-check' },
        input,
        h(
          'label',
          { class: 'form-check-label', htmlFor: id },
          h('span', { class: 'fw-semibold' }, mode.label),
          `: ${mode.detail}`,
        ),
      ),
    };
  });

  // --- input: outpaint -------------------------------------------------------------------------------------
  const extend = h(
    'select',
    {
      id: ids.extend,
      class: 'form-select',
      'data-testid': 'editor-extend',
      onchange: () => {
        settings.extend = extend.value;
        outpaintChanged();
      },
    },
    h('option', { value: 'margins' }, 'By margins'),
    EXTEND_RATIOS.map((ratio) => h('option', { value: ratio }, `To ${ratio}`)),
  );
  const marginInput = (side: keyof Margins, label: string): HTMLElement => {
    const id = uid(`editor-margin-${side}`);
    const input = h('input', {
      id,
      type: 'number',
      class: 'form-control',
      min: '0',
      max: '200',
      step: '5',
      inputMode: 'numeric',
      'data-testid': `editor-margin-${side}`,
    });
    input.addEventListener('input', () => {
      const value = Number(input.value);
      settings.margins[side] = Number.isFinite(value) ? Math.min(200, Math.max(0, value)) : 0;
      outpaintChanged();
    });
    marginFields.set(side, input);
    return h(
      'div',
      { class: 'col-6 col-sm-3' },
      h('label', { class: 'form-label small', htmlFor: id }, label),
      h(
        'div',
        { class: 'input-group input-group-sm' },
        input,
        h('span', { class: 'input-group-text' }, '%'),
      ),
    );
  };
  const marginFields = new Map<keyof Margins, HTMLInputElement>();
  const margins = h(
    'div',
    { class: 'row g-2', 'data-testid': 'editor-margins' },
    marginInput('top', 'Top'),
    marginInput('right', 'Right'),
    marginInput('bottom', 'Bottom'),
    marginInput('left', 'Left'),
  );
  const schematicInner = h('div', { class: 'or-outpaint-inner' });
  const schematic = h(
    'div',
    { class: 'or-outpaint-schematic', 'aria-hidden': 'true' },
    schematicInner,
  );
  const outpaintSize = h('div', { class: 'small', 'data-testid': 'editor-outpaint-size' });
  const outpaintPanel = h(
    'fieldset',
    { class: 'd-flex flex-column gap-2', 'data-testid': 'editor-outpaint' },
    h('legend', { class: 'form-label fw-semibold fs-6 mb-0' }, 'New canvas'),
    h('label', { class: 'visually-hidden', htmlFor: ids.extend }, 'Extend'),
    extend,
    margins,
    h('div', { class: 'd-flex align-items-center gap-3' }, schematic, outpaintSize),
  );

  // --- input: instruction and options ----------------------------------------------------------------------
  const instructionLabel = h('label', {
    class: 'form-label fw-semibold',
    htmlFor: ids.instruction,
  });
  const instruction = h('textarea', {
    id: ids.instruction,
    class: 'form-control',
    rows: 3,
    'data-testid': 'tool-prompt',
  });
  instruction.addEventListener('input', () => void ui.refreshEstimate());

  const keepOutside = switchField({
    label: 'Keep outside the mask',
    help: 'Puts your picture back everywhere outside the mask, pixel for pixel, with a soft edge inside it.',
    checked: settings.keepOutside,
    testId: 'editor-keep-outside',
    onChange: (checked) => {
      settings.keepOutside = checked;
    },
  });
  const modelNote = h(
    'div',
    {
      class: 'alert alert-info small mb-0 d-flex gap-2',
      role: 'note',
      'data-testid': 'editor-model-note',
    },
    icon('info-circle'),
    h(
      'div',
      null,
      'The model decides what it changes and may also change things outside the mask. ',
      'There is no mask setting in the API: the marked picture, the plain one and the mask go to the model with an instruction.',
    ),
  );
  const notes = h('div', {
    class: 'd-flex flex-column gap-2 empty-hidden',
    'data-testid': 'editor-notes',
  });

  ui.input.append(
    sourceSlot,
    h(
      'fieldset',
      null,
      h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Mode'),
      modeInputs.map((entry) => entry.element),
    ),
    outpaintPanel,
    h('div', null, instructionLabel, instruction),
    keepOutside.element,
    modelNote,
    notes,
  );

  // --- drawer ----------------------------------------------------------------------------------------------
  const feather = h('input', {
    id: ids.feather,
    type: 'range',
    class: 'form-range',
    min: '0',
    max: String(MAX_FEATHER),
    step: '1',
    'aria-describedby': ids.featherHelp,
    'data-testid': 'editor-feather',
  });
  const featherValue = h('span', { class: 'small text-body-secondary' });
  feather.addEventListener('input', () => {
    settings.feather = Number(feather.value);
    featherValue.textContent = `${settings.feather} px`;
  });
  const featherHelp = h('div', {
    id: ids.featherHelp,
    class: 'form-text',
    'data-testid': 'editor-feather-help',
  });
  ui.drawer.append(
    h(
      'div',
      null,
      h(
        'div',
        { class: 'd-flex align-items-baseline gap-2' },
        h('label', { class: 'form-label', htmlFor: ids.feather }, 'Soft edge'),
        featherValue,
      ),
      feather,
      featherHelp,
    ),
  );

  // --- output: editor and versions -------------------------------------------------------------------------
  const editor = canvasEditor({ onMaskChange: () => renderNotes() });
  const empty = emptyState({
    icon: 'brush',
    title: 'No picture yet',
    text: 'Drop or choose a picture on the left, or send one here from Image generation.',
    testId: 'editor-empty',
  });
  const compare = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'aria-pressed': 'false',
      'data-testid': 'editor-compare',
      onclick: () => setCompare(compare.getAttribute('aria-pressed') !== 'true'),
    },
    icon('layout-split'),
    'Show before',
  );
  const strip = h('ol', {
    class: 'list-unstyled d-flex flex-nowrap gap-2 mb-0 or-version-strip',
    'aria-label': 'Versions',
    'data-testid': 'editor-versions',
  });
  const versionSlot = h('div', { 'data-testid': 'editor-version-slot' });
  /** The before/after wipe while "Show before" is pressed. */
  const compareSlot = h('div', { hidden: true, 'data-testid': 'editor-compare-slot' });
  const versionsHeading = uid('editor-versions-heading');
  const versionsSection = h(
    'section',
    { class: 'vstack gap-2', 'aria-labelledby': versionsHeading, hidden: true },
    h(
      'div',
      { class: 'd-flex align-items-center gap-2' },
      h('h3', { id: versionsHeading, class: 'h6 mb-0 me-auto' }, 'Versions'),
      compare,
    ),
    strip,
    compareSlot,
    versionSlot,
  );
  const workspace = h(
    'div',
    { class: 'vstack gap-3', hidden: true },
    editor.element,
    versionsSection,
  );
  ui.output.append(empty, workspace);

  let comparing = false;
  let slider: CompareSlider | null = null;
  /** "Show before": a before/after wipe of the version on screen and the one it was made from. */
  const setCompare = (on: boolean): void => {
    const working = versions.working;
    const parent = working ? versions.parentOf(working.id) : null;
    comparing = on && working !== null && parent !== null;
    compare.setAttribute('aria-pressed', String(comparing));
    compareSlot.hidden = !comparing;
    if (!comparing || !working || !parent) {
      replace(compareSlot);
      slider = null;
      if (!on) announce('Comparison closed.');
      return;
    }
    const images = {
      before: { src: thumbOf(parent), alt: `${versionLabel(parent)}, before this edit` },
      after: { src: thumbOf(working), alt: `${versionLabel(working)}, after it` },
    };
    if (slider) slider.setImages(images);
    else {
      slider = compareSlider({
        before: { ...images.before, label: versionLabel(parent) },
        after: { ...images.after, label: versionLabel(working) },
        label: `Compare ${versionLabel(working).toLowerCase()} with ${versionLabel(parent).toLowerCase()}`,
        testId: 'editor-compare-slider',
      });
      replace(compareSlot, slider.element);
    }
    announce(
      `Comparing ${versionLabel(working).toLowerCase()} with ${versionLabel(parent).toLowerCase()}.`,
    );
  };
  const thumbOf = (version: Version): string => {
    let url = thumbs.get(version.id);
    if (!url) {
      url = URL.createObjectURL(version.blob);
      thumbs.set(version.id, url);
    }
    return url;
  };

  const renderVersions = (): void => {
    const working = versions.working;
    versionsSection.hidden = versions.all().length < 2;
    replace(
      strip,
      versions.all().map((version) => {
        const current = version.id === working?.id;
        const label = versionLabel(version);
        return h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              class: [
                'btn btn-sm or-version-thumb',
                current ? 'btn-primary' : 'btn-outline-secondary',
              ],
              'aria-current': current ? 'true' : null,
              'aria-label': `${label}${version.mode ? `, ${MODE_LABEL[version.mode]}` : ''}${current ? ', being edited' : ''}. Edit from here`,
              'data-focus-key': `version:${version.id}`,
              'data-testid': 'editor-version-thumb',
              onclick: () => void selectVersion(version.id),
            },
            h('img', { src: thumbOf(version), alt: '', class: 'rounded', width: 64, height: 64 }),
            h('span', { class: 'd-block small' }, label),
          ),
        );
      }),
    );
    const card = working ? cards.get(working.id) : undefined;
    replace(
      versionSlot,
      card?.element ??
        (working
          ? h(
              'p',
              { class: 'small text-body-secondary mb-0' },
              `${versionLabel(working)}: ${originalName}, ${working.width} × ${working.height}. Edits appear here as new versions.`,
            )
          : null),
    );
    compare.disabled = !working || !versions.parentOf(working.id);
    if (compare.disabled && comparing) setCompare(false);
  };

  /**
   * Puts a version on the canvas at the size the model sees; the mask stays when that size is the same. The
   * picture that was on screen is closed (only Blobs are kept for the others).
   */
  const showVersion = async (version: Version, keepMask: boolean): Promise<void> => {
    const bitmap = await decode(version);
    if (onScreen && onScreen.bitmap !== bitmap) close(onScreen.bitmap);
    onScreen = { id: version.id, bitmap };
    const size = workSize(version);
    editor.setImage(bitmap, size.width, size.height, { keepMask });
    renderVersions();
    if (comparing) setCompare(false);
    modeChanged();
  };

  /** Says why the picture cannot change now (an edit is in flight), or returns false. */
  const busyEditing = (action: string): boolean => {
    if (!editing) return false;
    ui.status(`An edit is running: wait for it, or press Stop, before ${action}.`);
    return true;
  };

  const selectVersion = async (id: string): Promise<void> => {
    const version = versions.get(id);
    if (!version || versions.working?.id === id) return;
    if (busyEditing('switching versions')) return;
    versions.select(id);
    await showVersion(version, true);
    announce(`Editing from ${versionLabel(version).toLowerCase()}.`);
  };

  /** Removes a version (its card's Remove); focus goes to the strip once redrawn, else to the canvas. */
  const removeVersion = async (id: string): Promise<void> => {
    const wasWorking = versions.working?.id === id;
    if (!versions.remove(id)) return;
    forget(id);
    const working = versions.working;
    if (wasWorking && working) await showVersion(working, true);
    else renderVersions();
    const target = versionsSection.hidden
      ? editor.viewport
      : strip.querySelector<HTMLElement>('[aria-current="true"]');
    target?.focus();
  };

  // --- loading a picture -----------------------------------------------------------------------------------
  const unsaved = (): number =>
    [...cards.values()].filter((card) => !card.handle.result.downloaded).length;

  /**
   * Decodes a picture and scales it down when it has more pixels than browsers can draw (the scaled copy, a
   * PNG, becomes the original). Null with the reason shown when it cannot be opened.
   */
  const openPicture = async (
    file: Blob,
  ): Promise<{ blob: Blob; bitmap: Decoded; note: string | null } | null> => {
    let bitmap: Decoded;
    try {
      bitmap = await loadImage(file);
    } catch {
      void presentError(
        new InvalidInputError(
          'This picture could not be opened: it may be damaged, or too large for the browser.',
        ),
      );
      return null;
    }
    const { width, height } = imageSize(bitmap);
    if (width * height <= MAX_PIXELS) return { blob: file, bitmap, note: null };
    const scale = Math.sqrt(MAX_PIXELS / (width * height));
    const target = {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
    try {
      const blob = await toBlob(resizeCanvas(bitmap, target.width, target.height), {
        type: 'image/png',
      });
      close(bitmap);
      return {
        blob,
        bitmap: await loadImage(blob),
        note: `Scaled down from ${width} × ${height} to ${target.width} × ${target.height}: larger pictures are more than browsers can draw.`,
      };
    } catch {
      close(bitmap);
      void presentError(
        new InvalidInputError(
          `This picture (${width} × ${height}) is too large for the browser to work with. Try a smaller one.`,
        ),
      );
      return null;
    }
  };

  const loadFile = async (file: File | Blob | undefined, name?: string): Promise<void> => {
    if (!file) return;
    if (busyEditing('loading another picture')) return;
    const fileName = name ?? (file instanceof File ? file.name : 'image.png');
    const pending = unsaved();
    if (
      pending > 0 &&
      !(await confirmDialog({
        title: 'Start over with another picture?',
        message: `${plural(pending, 'version')} of the current picture ${pending === 1 ? 'is' : 'are'} not downloaded and will be removed.`,
        confirmLabel: 'Start over',
        tone: 'warning',
      }))
    ) {
      return;
    }
    const opened = await openPicture(file);
    if (!opened) return;
    const { width, height } = imageSize(opened.bitmap);
    for (const card of cards.values()) card.remove();
    for (const version of versions.all()) forget(version.id);
    originalName = fileName;
    const original = versions.reset({ blob: opened.blob, name: fileName, width, height });
    onScreen = { id: original.id, bitmap: opened.bitmap };
    empty.hidden = true;
    workspace.hidden = false;
    renderSource();
    await showVersion(original, false);
    ui.status(opened.note ?? `Loaded ${fileName} (${width} × ${height}).`);
  };

  // --- mode-dependent parts --------------------------------------------------------------------------------
  /** The outpaint plan for the working version, or null. */
  const currentPlan = (): ReturnType<typeof outpaintPlan> | null => {
    const working = versions.working;
    return working
      ? outpaintPlan(working.width, working.height, settings.extend, settings.margins)
      : null;
  };

  /** One canvas for the outpaint preview, redrawn (never reallocated per keystroke). */
  const previewCanvas = document.createElement('canvas');
  /**
   * Shows the new canvas on the editor while Outpaint is chosen (grey new area, tinted like the mask), at the
   * size the model would see; a plan beyond MAX_CANVAS_SIDE shows the picture alone (the notes say why).
   */
  const drawModePreview = (): void => {
    const working = versions.working;
    const plan = settings.mode === 'outpaint' ? currentPlan() : null;
    if (!working || !plan || planProblem(plan, working.width, working.height) || !onScreen) {
      editor.preview(null);
      return;
    }
    const size = workSize(plan);
    const at = scaledPlan(plan, working.width, working.height, size);
    previewCanvas.width = size.width;
    previewCanvas.height = size.height;
    const context = previewCanvas.getContext('2d');
    if (!context) return;
    context.fillStyle = `rgb(${OUTPAINT_FILL.join(',')})`;
    context.fillRect(0, 0, size.width, size.height);
    context.fillStyle = 'rgba(255, 0, 255, 0.5)';
    context.fillRect(0, 0, size.width, size.height);
    context.clearRect(at.offsetX, at.offsetY, at.imageWidth, at.imageHeight);
    context.imageSmoothingQuality = 'high';
    context.drawImage(onScreen.bitmap, at.offsetX, at.offsetY, at.imageWidth, at.imageHeight);
    editor.preview(previewCanvas, size.width, size.height);
  };
  const debouncedPreview = debounce(drawModePreview, PREVIEW_DELAY_MS);
  /** At once for a mode or version change; typing in the margins goes through `debouncedPreview`. */
  const showModePreview = (): void => {
    debouncedPreview.cancel();
    drawModePreview();
  };

  const renderOutpaint = (): void => {
    outpaintPanel.hidden = settings.mode !== 'outpaint';
    extend.value = settings.extend;
    margins.hidden = settings.extend !== 'margins';
    for (const [side, input] of marginFields) {
      if (document.activeElement !== input) input.value = String(settings.margins[side]);
    }
    const working = versions.working;
    const plan = currentPlan();
    if (!working || !plan) {
      outpaintSize.textContent = 'Load a picture to see the new canvas.';
      schematic.hidden = true;
      return;
    }
    schematic.hidden = false;
    schematic.style.aspectRatio = `${plan.width} / ${plan.height}`;
    schematicInner.style.left = `${(plan.offsetX / plan.width) * 100}%`;
    schematicInner.style.top = `${(plan.offsetY / plan.height) * 100}%`;
    schematicInner.style.width = `${(working.width / plan.width) * 100}%`;
    schematicInner.style.height = `${(working.height / plan.height) * 100}%`;
    outpaintSize.textContent = `${working.width} × ${working.height} → ${plan.width} × ${plan.height}`;
  };

  const renderNotes = (): void => {
    const list: HTMLElement[] = [];
    const model = ctx.model().model;
    const state = modelState;
    const controls = state && state.status !== 'missing' ? state.controls : null;
    if (model && state?.status === 'missing') {
      list.push(
        h(
          'div',
          {
            class: 'alert alert-warning small mb-0',
            role: 'note',
            'data-testid': 'editor-missing',
          },
          `${model} is not served by the image endpoint. Choose another model with the model button above.`,
        ),
      );
    } else if (state?.status === 'unknown') {
      list.push(
        h(
          'div',
          { class: 'alert alert-info small mb-0', role: 'note', 'data-testid': 'editor-unknown' },
          'The model options could not be loaded: the edit is sent with every reference picture, and the model may refuse it.',
        ),
      );
    } else if (controls && (controls.references?.max ?? 0) === 0) {
      list.push(
        h(
          'div',
          {
            class: 'alert alert-warning small mb-0',
            role: 'note',
            'data-testid': 'editor-no-references',
          },
          `${controls.name} cannot take a picture to edit. Choose a model that takes reference images.`,
        ),
      );
    } else if (controls && settings.mode !== 'whole') {
      const roles = referenceRoles(settings.mode, controls.references?.max ?? 0);
      if (roles.length < 3) {
        list.push(
          h(
            'div',
            { class: 'small text-warning-emphasis', role: 'note' },
            `${controls.name} takes ${plural(roles.length, 'reference image')}, so only the marked picture${roles.length > 1 ? ' and the plain one are' : ' is'} sent.`,
          ),
        );
      }
    }
    if (settings.mode === 'outpaint') {
      const working = versions.working;
      const plan = currentPlan();
      const problem = working && plan ? planProblem(plan, working.width, working.height) : null;
      if (problem)
        list.push(h('div', { class: 'small text-danger-emphasis', role: 'note' }, problem));
    }
    replace(notes, list);
  };

  function modeChanged(): void {
    for (const entry of modeInputs) entry.input.checked = entry.mode.id === settings.mode;
    instructionLabel.textContent = INSTRUCTION_LABEL[settings.mode];
    instruction.placeholder = PLACEHOLDER[settings.mode];
    keepOutside.element.hidden = settings.mode === 'whole';
    // The note is about a mask; a whole-image edit has none.
    modelNote.hidden = settings.mode === 'whole';
    // Outpaint blends on the picture's side of the seam (the new area is all result); inpaint inside the mask.
    featherHelp.textContent =
      settings.mode === 'outpaint'
        ? 'With “Keep outside the mask”: how many pixels at the edge of your picture blend into the new area. 0 is a hard edge.'
        : settings.mode === 'whole'
          ? 'Only used by Inpaint and Outpaint, which keep your picture outside the new area.'
          : 'With “Keep outside the mask”: how many pixels inside the mask blend the result into your picture. 0 is a hard edge.';
    editor.setPainting(
      settings.mode === 'inpaint' && !editing,
      editing
        ? 'Painting waits until the edit is back.'
        : settings.mode === 'outpaint'
          ? 'Outpaint marks the new area for you.'
          : 'Whole-image edits use no mask.',
    );
    renderOutpaint();
    showModePreview();
    renderNotes();
    void ui.refreshEstimate();
  }

  function outpaintChanged(): void {
    renderOutpaint();
    debouncedPreview();
    renderNotes();
    void ui.refreshEstimate();
  }

  const syncModel = async (): Promise<void> => {
    const model = ctx.model().model;
    modelState = model ? await controlsFor(model) : null;
    renderNotes();
  };

  // --- running ---------------------------------------------------------------------------------------------
  /** What one edit sends and needs afterwards, built before anything is paid for. */
  interface Prepared {
    working: Version;
    mode: EditMode;
    /** The canvas at full size: the picture, or the outpaint canvas (picture on grey). */
    canvas: { width: number; height: number };
    plan: ReturnType<typeof outpaintPlan> | null;
    /** The size every reference was built at (what the model sees). */
    refSize: { width: number; height: number };
    /** The mask at `refSize` (inpaint) or null. */
    mask: Mask | null;
    body: ReturnType<typeof buildEditRequest>;
  }

  /**
   * The references for an edit of the working version, all at one size (the canvas fitted in WORK_SIDE) and
   * from the decoded, upright pixels, so the marked picture, the plain one and the mask line up exactly.
   */
  const prepare = async (
    model: string,
    modelControls: ImageModelControls,
    roles: ReturnType<typeof referenceRoles>,
  ): Promise<Prepared> => {
    const working = versions.working!;
    const mode = settings.mode;
    const plan = mode === 'outpaint' ? currentPlan() : null;
    const canvas = plan ?? { width: working.width, height: working.height };
    const refSize = workSize(canvas);
    const bitmap = await decode(working);
    try {
      let plain: RasterImage;
      let mask: Mask | null = null;
      if (plan) {
        const at = scaledPlan(plan, working.width, working.height, refSize);
        plain = drawToRaster(bitmap, refSize.width, refSize.height, {
          box: { x: at.offsetX, y: at.offsetY, width: at.imageWidth, height: at.imageHeight },
          fill: OUTPAINT_FILL,
        });
        mask = outpaintMask(at, at.imageWidth, at.imageHeight);
      } else {
        plain = drawToRaster(bitmap, refSize.width, refSize.height);
        if (mode === 'inpaint') mask = scaleMask(editor.mask(), refSize.width, refSize.height);
      }
      // The marked picture and the mask picture are made in the worker; the set is encoded at one size.
      const pictures = await Promise.all(
        roles.map((role) =>
          role === 'plain'
            ? Promise.resolve(plain)
            : role === 'marked'
              ? maskOverlayAsync(plain, mask!, MASK_COLOUR, MASK_ALPHA)
              : maskToRasterAsync(mask!),
        ),
      );
      const references = await toDataUrls(pictures, REFERENCE_ENCODING);
      const body = buildEditRequest({
        model,
        mode,
        instruction: instruction.value,
        roles,
        references,
        controls: modelControls,
        width: refSize.width,
        height: refSize.height,
      });
      return {
        working,
        mode,
        canvas,
        plan,
        refSize,
        mask: mode === 'inpaint' ? mask : null,
        body,
      };
    } finally {
      release(bitmap);
    }
  };

  /**
   * "Keep outside the mask" at full size: the result fitted onto the canvas (filling it when the shapes agree,
   * else fitted inside and centred, never stretched) and laid in through the mask. Inpaint softens the inside of
   * the mask; outpaint keeps the new area all result and softens the picture's side of the seam, so the grey
   * filler never shows. Returns the PNG and whether the result had to be fitted.
   */
  const compositeKeepingOutside = async (
    prepared: Prepared,
    result: Blob,
  ): Promise<{ blob: Blob; fitted: boolean }> => {
    const { working, canvas, plan, refSize } = prepared;
    const bitmap = await decode(working);
    const answer = await loadImage(result);
    try {
      const feather = Math.round((settings.feather * canvas.width) / refSize.width);
      const { width, height } = imageSize(answer);
      const fit = fitResult(width, height, canvas.width, canvas.height);
      const laid = drawToRaster(answer, canvas.width, canvas.height, { box: fit.box });
      let out: RasterImage;
      if (plan) {
        // The picture on the grey canvas. Here the picture is the mask that is kept (with what the result does
        // not reach), so its soft edge lies on the picture's side and the grey never blends into the result.
        const base = drawToRaster(bitmap, plan.width, plan.height, {
          box: { x: plan.offsetX, y: plan.offsetY, width: working.width, height: working.height },
          fill: OUTPAINT_FILL,
        });
        const kept = pictureMask(plan, working.width, working.height, fit.fill ? null : fit.box);
        out = await compositeMaskedAsync(laid, base, kept, { feather }, { transfer: true });
      } else {
        const picture = drawToRaster(bitmap, working.width, working.height);
        const mask = scaleMask(prepared.mask!, canvas.width, canvas.height);
        out = await compositeMaskedAsync(
          picture,
          laid,
          fit.fill ? mask : clipMask(mask, fit.box),
          { feather },
          { transfer: true },
        );
      }
      return { blob: await toBlob(out, { type: 'image/png' }), fitted: !fit.fill };
    } finally {
      release(bitmap);
      close(answer);
    }
  };

  const run = async (signal: AbortSignal): Promise<void> => {
    const working = versions.working;
    if (!working) {
      ui.status('Load a picture first.');
      sourceSlot.querySelector<HTMLElement>('button')?.focus();
      return;
    }
    const model = ctx.model().model;
    if (!model) return;
    const state = await controlsFor(model);
    if (state.status === 'missing') {
      ui.status(`${model} is not available for image editing. Choose another model.`);
      return;
    }
    const mode = settings.mode;
    const roles = rolesFor(mode, state);
    if (roles.length === 0) {
      ui.status(`${state.controls.name} cannot take a picture to edit. Choose another model.`);
      return;
    }
    if (mode !== 'outpaint' && !instruction.value.trim()) {
      ui.status('Describe the change first.');
      instruction.focus();
      return;
    }
    if (mode === 'inpaint' && editor.isMaskEmpty()) {
      ui.status('Paint over the area to change first.');
      editor.viewport.focus();
      return;
    }
    if (mode === 'outpaint') {
      const problem = planProblem(currentPlan()!, working.width, working.height);
      if (problem) {
        ui.status(problem);
        return;
      }
    }
    const keep = settings.keepOutside && mode !== 'whole';

    // From here until the version is shown (or the run is refused or fails) the picture, the version and the mask
    // stay as they are: loading, switching versions and painting wait, also while the pictures are prepared and
    // the budget question is open.
    editing = true;
    modeChanged();
    const ticker = createTicker();
    try {
      // Everything is encoded before the run starts: a picture that cannot be read costs nothing.
      let prepared: Prepared;
      try {
        prepared = await prepare(model, state.controls, roles);
      } catch (error) {
        throw new InvalidInputError(`The picture could not be prepared (${userMessage(error)}).`);
      }
      const { body } = prepared;
      const maskRevision = editor.revision();

      // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
      const handle = await ctx.beginRun(
        {
          title: `${MODE_LABEL[mode]}: ${shorten(instruction.value.trim() || 'extend the picture', 70)}`,
        },
        signal,
      );
      ui.status(`${MODE_LABEL[mode]}…`);
      ticker.start((seconds) => ui.progress(`${MODE_LABEL[mode]}… ${seconds} s`));

      /**
       * The model's picture as the next version. It is paid for, so nothing below may lose it: keeping the outside
       * falls back to the model's own picture, an unreadable size to the canvas's, and a version that cannot be
       * drawn stays in the strip with its card (and the error is shown) instead of vanishing.
       */
      const makeVersion = async (image: GeneratedImage) => {
        let blob = image.blob;
        let fitted = false;
        let keepFailed: string | null = null;
        if (keep) {
          try {
            ({ blob, fitted } = await compositeKeepingOutside(prepared, image.blob));
          } catch (error) {
            keepFailed = `The outside of the mask could not be kept (${userMessage(error).replace(/\.$/, '')}): this is the model's own picture.`;
          }
        }
        const size = await readImageSize(blob).catch(() => prepared.canvas);
        const extension =
          blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : 'png';
        const version = versions.add({
          blob,
          name: '',
          width: size.width,
          height: size.height,
          parentId: working.id,
          mode,
          instruction: instruction.value.trim(),
          model,
        });
        version.name = `${stemOf(originalName)}-v${version.number}.${extension}`;
        const fitNote = fitted
          ? 'The model answered in another shape than the picture: its result was fitted inside and centered, not stretched; check the edges.'
          : keepFailed;
        const title = versionLabel(version);
        const card: ImageResultCard = imageResultCard({
          ui,
          blob,
          name: version.name,
          title,
          headingLevel: 4,
          viewer: false,
          meta: [
            MODE_LABEL[mode],
            `${size.width} × ${size.height}`,
            keep && !keepFailed ? 'outside kept' : null,
            formatBytes(blob.size),
          ],
          formats: ['png', 'jpg', 'webp'],
          extra: h(
            'div',
            { class: 'vstack gap-1 empty-hidden' },
            version.instruction
              ? h('p', { class: 'small mb-0 text-break' }, shorten(version.instruction, 200))
              : null,
            fitNote
              ? h(
                  'p',
                  {
                    class: 'small mb-0 text-warning-emphasis',
                    role: 'note',
                    'data-testid': 'editor-version-fitted',
                  },
                  fitNote,
                )
              : null,
          ),
          // An edit in flight keeps the versions; an undownloaded one asks before it goes.
          beforeRemove: () =>
            !busyEditing('removing a version') &&
            confirmUndownloaded(card.handle, title, 'image', 'editor-version'),
          onRemove: () => void removeVersion(version.id),
          testId: 'editor-version',
        });
        cards.set(version.id, card);
        ticker.stop();
        // The mask the user painted for this edit is cleared (one undoable step) only if it is still that one.
        const maskUntouched = editor.revision() === maskRevision;
        editing = false;
        let shownError: unknown = null;
        try {
          await showVersion(version, true);
          if (mode === 'inpaint' && maskUntouched) editor.clearMask();
        } catch (error) {
          shownError = error;
          renderVersions();
          modeChanged();
        }
        return { version, size, fitNote, fitted, shownError };
      };

      try {
        let answer: GeneratedImage | undefined;
        try {
          answer = (await ctx.api.images(body, { run: handle })).images[0];
        } catch (error) {
          // A Stop keeps a picture that was already made (paid for): it becomes a version, then the Stop goes on.
          const kept = partialImageResult(error)?.images[0];
          if (kept) {
            const { version } = await makeVersion(kept);
            announce(`Stopped: ${versionLabel(version)} was already made and is kept.`);
          }
          throw error;
        }
        if (!answer) throw new InvalidInputError('The model answered without a picture.');
        const { version, size, fitNote, fitted, shownError } = await makeVersion(answer);
        const summary = `${versionLabel(version)} ready: ${MODE_LABEL[mode].toLowerCase()}, ${size.width} × ${size.height}`;
        ui.status(fitNote ? `${summary}. ${fitNote}` : summary);
        if (shownError) {
          // The version is kept (its card has Download); only drawing it failed.
          ui.status(`${versionLabel(version)} is kept, but it could not be shown.`);
          void presentError(shownError);
        }
        await handle.finish({
          output: `${summary}${keep ? ', outside the mask kept' : ''}.\nInstruction sent:\n${body.prompt}`,
          meta: {
            mode,
            width: size.width,
            height: size.height,
            keepOutside: keep,
            fitted,
            version: version.number,
          },
        });
      } catch (error) {
        ticker.stop();
        ui.status(isStop(error) ? 'Stopped' : 'Failed');
        await handle.fail(error);
        throw error;
      }
    } finally {
      ticker.stop();
      if (editing) {
        editing = false;
        modeChanged();
      }
    }
  };
  ui.runner({ label: 'Edit', icon: 'brush', run });

  // --- state -----------------------------------------------------------------------------------------------
  const applySettings = (next: EditorSettings): void => {
    settings = next;
    keepOutside.input.checked = settings.keepOutside;
    feather.value = String(settings.feather);
    featherValue.textContent = `${settings.feather} px`;
    modeChanged();
  };

  ctx.settings.subscribe(() => void syncModel());
  ctx.bus.on('models-refreshed', () => {
    void syncModel();
  });
  renderSource();
  applySettings(settings);
  void syncModel();

  const firstImage = (files: readonly (File | { blob: Blob; name: string })[]): void => {
    const first = files[0];
    if (!first) return;
    if (first instanceof File) void loadFile(first);
    else void loadFile(first.blob, first.name);
  };

  return {
    getState: () => ({ prompt: instruction.value, settings: settingsRecord(settings) }),
    applyState: ({ prompt, settings: saved }) => {
      instruction.value = prompt;
      applySettings(parseSettings(saved));
    },
    estimate: async (model) => {
      const state = await controlsFor(model);
      if (state.status === 'missing') return null;
      const working = versions.working;
      const plan = settings.mode === 'outpaint' ? currentPlan() : null;
      const canvas = plan ?? (working ? { width: working.width, height: working.height } : null);
      // Priced at the size the model is sent and asked for (at most WORK_SIDE a side), not the full picture.
      const size = canvas ? workSize(canvas) : null;
      return ctx.models.estimate({
        kind: 'image',
        model,
        images: 1,
        ...(size ? { width: size.width, height: size.height } : {}),
        references: rolesFor(settings.mode, state).length,
      });
    },
    onFiles: (files) => firstImage(files),
    onReceive: (items) => firstImage(items.flatMap((item) => (item.kind === 'file' ? [item] : []))),
    sample: async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 768;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) return;
      const sky = context.createLinearGradient(0, 0, 0, 340);
      sky.addColorStop(0, '#1e3a8a');
      sky.addColorStop(1, '#f59e0b');
      context.fillStyle = sky;
      context.fillRect(0, 0, 768, 340);
      context.fillStyle = '#fde68a';
      context.beginPath();
      context.arc(560, 250, 60, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#0f766e';
      context.fillRect(0, 340, 768, 172);
      const blob = await toBlob(canvas, { type: 'image/png' });
      await loadFile(blob, 'sunset-sample.png');
      instruction.value = 'A full moon with soft craters';
      applySettings({ ...settings, mode: 'inpaint' });
      ui.status('Paint over the sun, then press Edit.');
    },
  };
}
