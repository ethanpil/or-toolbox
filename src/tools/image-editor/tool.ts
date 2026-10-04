/**
 * Image editor: load a picture, paint a mask on a canvas, and edit it with an image model through `POST /images`
 * in one of three modes: Inpaint (change the painted area), Outpaint (extend the canvas; the new area is the
 * mask) and Whole image (an instruction, no mask).
 *
 * There is no mask parameter (docs/openrouter-api.md §0, §3.3), so a masked edit sends the picture with the area
 * tinted magenta, the plain picture and the mask as a PNG, with an instruction naming the marked area
 * (request.ts). Models decide what they change; "Keep outside the mask" composites the result back onto the
 * picture through the mask (with a soft inner edge), so every pixel outside the mask stays exactly as it was.
 *
 * Every result is a new version (thumbnail strip); any version can be compared with the one it came from,
 * edited further, downloaded or removed. Versions are session results (leave guard); History keeps the
 * instruction and settings only.
 */
import type { ImageModelControls } from '../../core/models/image-params';
import { imageModelControls } from '../../core/models/image-params';
import { InvalidInputError, userMessage } from '../../core/errors';
import type { RawImageModel } from '../../core/api/types';
import {
  imageDataFrom,
  imageSize,
  loadImage,
  type Mask,
  maskOverlay,
  maskToRaster,
  type RasterImage,
  toBlob,
  toDataUrl,
} from '../../core/media/image';
import { dropZone } from '../../ui/components/drop-zone';
import { emptyState } from '../../ui/components/empty-state';
import { type ImageResultCard, imageResultCard } from '../../ui/components/image-result-card';
import { switchField } from '../../ui/components/switch-field';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { formatBytes, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { canvasEditor } from './canvas-editor';
import { compositeMasked, featherInside } from './mask';
import {
  EXTEND_RATIOS,
  type Margins,
  OUTPAINT_FILL,
  outpaintMask,
  outpaintPlan,
  placeOnCanvas,
  planProblem,
} from './outpaint';
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

/** References are scaled to this before upload. */
const REFERENCE_MAX_SIDE = 2048;
const REFERENCE_MAX_BYTES = 4 * 1024 * 1024;

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

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

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

  // --- image models ----------------------------------------------------------------------------------------
  let imageModels: RawImageModel[] | null = null;
  let loading: Promise<void> | null = null;
  /** Reads the list (the cache when it has one); 
eread after a refresh elsewhere, never forcing the network. */
  const loadImageModels = (reread = false): Promise<void> => {
    if (loading && !reread) return loading;
    loading = ctx.models
      .imageModels()
      .then((list) => {
        imageModels = list;
      })
      .catch(() => undefined);
    return loading;
  };
  const controlsFor = async (model: string): Promise<ImageModelControls | null> => {
    await loadImageModels();
    const raw = imageModels?.find((entry) => entry.id === model);
    return raw ? imageModelControls(raw) : null;
  };
  let controls: ImageModelControls | null = null;

  // --- versions and decoded pictures -----------------------------------------------------------------------
  const versions = new VersionHistory();
  const bitmaps = new Map<string, ImageBitmap | HTMLImageElement>();
  const rasters = new Map<string, RasterImage>();
  const thumbs = new Map<string, string>();
  const cards = new Map<string, ImageResultCard>();
  let originalName = 'image.png';

  const bitmapOf = async (version: Version): Promise<ImageBitmap | HTMLImageElement> => {
    const known = bitmaps.get(version.id);
    if (known) return known;
    const decoded = await loadImage(version.blob);
    bitmaps.set(version.id, decoded);
    return decoded;
  };
  const rasterOf = async (version: Version): Promise<RasterImage> => {
    const known = rasters.get(version.id);
    if (known) return known;
    const raster = imageDataFrom(await bitmapOf(version), {
      width: version.width,
      height: version.height,
    });
    rasters.set(version.id, raster);
    return raster;
  };
  const forget = (id: string): void => {
    const bitmap = bitmaps.get(id);
    if (bitmap && 'close' in bitmap) bitmap.close();
    bitmaps.delete(id);
    rasters.delete(id);
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
    { class: 'alert alert-info small mb-0 d-flex gap-2', role: 'note' },
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
      h(
        'div',
        { id: ids.featherHelp, class: 'form-text' },
        'With “Keep outside the mask”: how many pixels inside the mask blend the result into your picture. 0 is a hard edge.',
      ),
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
  const setCompare = (on: boolean): void => {
    const working = versions.working;
    const parent = working ? versions.parentOf(working.id) : null;
    comparing = on && parent !== null;
    compare.setAttribute('aria-pressed', String(comparing));
    if (comparing && parent) {
      void bitmapOf(parent).then((bitmap) => {
        if (comparing) editor.preview(bitmap, parent.width, parent.height);
      });
      announce(`Showing ${versionLabel(parent).toLowerCase()}, before this edit.`);
    } else {
      showModePreview();
      if (!on) announce('Showing the current version.');
    }
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

  /** Puts a version on the canvas; the mask stays when the size is the same. */
  const showVersion = async (version: Version, keepMask: boolean): Promise<void> => {
    const bitmap = await bitmapOf(version);
    editor.setImage(bitmap, version.width, version.height, { keepMask });
    comparing = false;
    compare.setAttribute('aria-pressed', 'false');
    renderVersions();
    modeChanged();
  };

  const selectVersion = async (id: string): Promise<void> => {
    const version = versions.get(id);
    if (!version || versions.working?.id === id) return;
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

  const loadFile = async (file: File | Blob | undefined, name?: string): Promise<void> => {
    if (!file) return;
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
    let bitmap: ImageBitmap | HTMLImageElement;
    try {
      bitmap = await loadImage(file);
    } catch (error) {
      void presentError(error);
      return;
    }
    const { width, height } = imageSize(bitmap);
    for (const card of cards.values()) card.remove();
    for (const version of versions.all()) forget(version.id);
    originalName = fileName;
    const original = versions.reset({ blob: file, name: fileName, width, height });
    bitmaps.set(original.id, bitmap);
    empty.hidden = true;
    workspace.hidden = false;
    renderSource();
    await showVersion(original, false);
    ui.status(`Loaded ${fileName} (${width} × ${height}).`);
  };

  // --- mode-dependent parts --------------------------------------------------------------------------------
  /** The outpaint plan for the working version, or null. */
  const currentPlan = (): ReturnType<typeof outpaintPlan> | null => {
    const working = versions.working;
    return working
      ? outpaintPlan(working.width, working.height, settings.extend, settings.margins)
      : null;
  };

  /** Shows the new canvas on the editor while Outpaint is chosen (grey new area, tinted like the mask). */
  const showModePreview = (): void => {
    const working = versions.working;
    const plan = settings.mode === 'outpaint' ? currentPlan() : null;
    if (!working || !plan || comparing) {
      if (!comparing) editor.preview(null);
      return;
    }
    void bitmapOf(working).then((bitmap) => {
      if (settings.mode !== 'outpaint' || comparing) return;
      const canvas = document.createElement('canvas');
      canvas.width = plan.width;
      canvas.height = plan.height;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.fillStyle = `rgb(${OUTPAINT_FILL.join(',')})`;
      context.fillRect(0, 0, plan.width, plan.height);
      context.fillStyle = 'rgba(255, 0, 255, 0.5)';
      context.fillRect(0, 0, plan.width, plan.height);
      context.clearRect(plan.offsetX, plan.offsetY, working.width, working.height);
      context.drawImage(bitmap, plan.offsetX, plan.offsetY, working.width, working.height);
      editor.preview(canvas, plan.width, plan.height);
    });
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
    if (model && imageModels && !controls) {
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
    editor.setPainting(
      settings.mode === 'inpaint',
      settings.mode === 'outpaint'
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
    showModePreview();
    renderNotes();
    void ui.refreshEstimate();
  }

  const syncModel = async (): Promise<void> => {
    const model = ctx.model().model;
    controls = model ? await controlsFor(model) : null;
    renderNotes();
  };

  // --- running ---------------------------------------------------------------------------------------------
  /** What an edit of the working version sends, built before anything is paid for. */
  const prepare = async (
    model: string,
    modelControls: ImageModelControls,
  ): Promise<{
    working: Version;
    canvas: RasterImage;
    mask: Mask | null;
    body: ReturnType<typeof buildEditRequest>;
  } | null> => {
    const working = versions.working;
    if (!working) return null;
    const mode = settings.mode;
    const base = await rasterOf(working);
    let canvas = base;
    let mask: Mask | null = null;
    if (mode === 'inpaint') {
      const live = editor.mask();
      mask = { width: live.width, height: live.height, data: new Uint8Array(live.data) };
    } else if (mode === 'outpaint') {
      const plan = currentPlan()!;
      canvas = placeOnCanvas(base, plan);
      mask = outpaintMask(plan, working.width, working.height);
    }
    const roles = referenceRoles(mode, modelControls.references?.max ?? 0);
    const encode = async (raster: RasterImage, type: 'image/png' | 'image/jpeg'): Promise<string> =>
      toDataUrl(await toBlob(raster, { type }), {
        maxDimension: REFERENCE_MAX_SIDE,
        maxBytes: REFERENCE_MAX_BYTES,
        type,
      });
    const references = await Promise.all(
      roles.map((role) => {
        if (role === 'plain') {
          return mode === 'outpaint'
            ? encode(canvas, 'image/png')
            : toDataUrl(working.blob, {
                maxDimension: REFERENCE_MAX_SIDE,
                maxBytes: REFERENCE_MAX_BYTES,
              });
        }
        if (role === 'marked')
          return encode(maskOverlay(canvas, mask!, MASK_COLOUR, MASK_ALPHA), 'image/png');
        return encode(maskToRaster(mask!), 'image/png');
      }),
    );
    const body = buildEditRequest({
      model,
      mode,
      instruction: instruction.value,
      roles,
      references,
      controls: modelControls,
      width: canvas.width,
      height: canvas.height,
    });
    return { working, canvas, mask, body };
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
    const modelControls = await controlsFor(model);
    if (!modelControls) {
      ui.status(`${model} is not available for image editing. Choose another model.`);
      return;
    }
    if ((modelControls.references?.max ?? 0) === 0) {
      ui.status(`${modelControls.name} cannot take a picture to edit. Choose another model.`);
      return;
    }
    const mode = settings.mode;
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
    const featherRadius = settings.feather;

    // Everything is encoded before the run starts: a picture that cannot be read costs nothing.
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(model, modelControls);
    } catch (error) {
      throw new InvalidInputError(`The picture could not be prepared (${userMessage(error)}).`);
    }
    if (!prepared) return;
    const { canvas, mask, body } = prepared;

    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): nothing changes.
    const handle = await ctx.beginRun(
      {
        title: `${MODE_LABEL[mode]}: ${shorten(instruction.value.trim() || 'extend the picture', 70)}`,
      },
      signal,
    );
    const started = Date.now();
    ui.status(`${MODE_LABEL[mode]}…`);
    const ticker = setInterval(() => {
      ui.progress(`${MODE_LABEL[mode]}… ${Math.round((Date.now() - started) / 1000)} s`);
    }, 1000);
    try {
      const result = await ctx.api.images(body, { run: handle });
      const image = result.images[0]!;
      let blob = image.blob;
      let size = { width: canvas.width, height: canvas.height };
      if (keep && mask) {
        // The result is scaled to the canvas and laid in through the mask: outside it, the original pixels.
        const decoded = await loadImage(image.blob);
        try {
          const raster = imageDataFrom(decoded, size);
          blob = await toBlob(compositeMasked(canvas, raster, featherInside(mask, featherRadius)), {
            type: 'image/png',
          });
        } finally {
          if ('close' in decoded) decoded.close();
        }
      } else {
        const decoded = await loadImage(image.blob);
        size = imageSize(decoded);
        if ('close' in decoded) decoded.close();
      }
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
      cards.set(
        version.id,
        imageResultCard({
          ui,
          blob,
          name: version.name,
          title: versionLabel(version),
          headingLevel: 4,
          viewer: false,
          meta: [
            MODE_LABEL[mode],
            `${size.width} × ${size.height}`,
            keep ? 'outside kept' : null,
            formatBytes(blob.size),
          ],
          formats: ['png', 'jpg', 'webp'],
          extra: version.instruction
            ? h('p', { class: 'small mb-0 text-break' }, shorten(version.instruction, 200))
            : null,
          onRemove: () => void removeVersion(version.id),
          testId: 'editor-version',
        }),
      );
      clearInterval(ticker);
      // Same size (inpaint, whole): the mask stays, cleared as one undoable step. Outpaint starts a new mask.
      await showVersion(version, true);
      if (mode === 'inpaint') editor.clearMask();
      const summary = `${versionLabel(version)} ready: ${MODE_LABEL[mode].toLowerCase()}, ${size.width} × ${size.height}`;
      ui.status(summary);
      await handle.finish({
        output: `${summary}${keep ? ', outside the mask kept' : ''}.\nInstruction sent:\n${body.prompt}`,
        meta: {
          mode,
          width: size.width,
          height: size.height,
          keepOutside: keep,
          version: version.number,
        },
      });
    } catch (error) {
      clearInterval(ticker);
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      clearInterval(ticker);
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
    void loadImageModels(true).then(syncModel);
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
      const modelControls = await controlsFor(model);
      if (!modelControls) return null;
      const working = versions.working;
      const plan = settings.mode === 'outpaint' ? currentPlan() : null;
      const size = plan ?? (working ? { width: working.width, height: working.height } : null);
      return ctx.models.estimate({
        kind: 'image',
        model,
        images: 1,
        ...(size ? { width: size.width, height: size.height } : {}),
        references: referenceRoles(settings.mode, modelControls.references?.max ?? 0).length,
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
