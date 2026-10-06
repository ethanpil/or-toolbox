/**
 * The mask painting surface: the picture on a canvas with the mask over it (magenta, as the model sees it),
 * brush and eraser, a size slider, undo/redo of strokes, clear, invert, show/hide the mask, zoom (Ctrl/Cmd+wheel
 * or a pinch, buttons, fit; a plain wheel scrolls the page) and pan (the hand tool, Space or the middle button,
 * two fingers). Screen readers hear the brush position after keyboard moves and the mask's coverage after
 * painting, both debounced.
 *
 * Keyboard (inside the editor): B brush, E eraser, H hand, [ and ] brush size, M show/hide the mask, 0 fit,
 * + and - zoom, Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo. On the canvas: arrows move the brush
 * outline (Shift+arrow paints along the way), Enter paints a dot; with the hand tool, arrows pan.
 *
 * The mask is the source of truth (`Mask`, one byte per pixel); strokes are kept as operations and undo
 * replays them from blank (`replayOps`), so memory does not grow with the picture size.
 */
import type { Box, Mask } from '../../core/media/image';
import { debounce } from '../../core/util';
import { h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isApplePlatform } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import {
  applyOp,
  createMask,
  isMaskEmpty,
  maskCoverage,
  type MaskOp,
  paintSegment,
  replayOps,
  stampDisc,
} from './mask';

export type EditorTool = 'brush' | 'eraser' | 'pan';

export interface CanvasEditorOptions {
  /** After every committed mask change (a stroke ends, undo, redo, clear, invert, a new picture). */
  onMaskChange?: () => void;
}

export interface CanvasEditor {
  readonly element: HTMLElement;
  /** The focusable canvas area. */
  readonly viewport: HTMLElement;
  /**
   * Shows a picture to edit. The mask (and its undo history) is kept when `keepMask` is set and the size is
   * unchanged; otherwise it starts blank.
   */
  setImage(
    source: CanvasImageSource,
    width: number,
    height: number,
    options?: { keepMask?: boolean },
  ): void;
  hasImage(): boolean;
  /** The live mask (do not keep it across edits: copy it). */
  mask(): Mask;
  isMaskEmpty(): boolean;
  /** Paints (or not) and shows the mask (or not); the reason is shown while painting is off. */
  setPainting(enabled: boolean, reason?: string): void;
  /**
   * Shows another picture instead of the one being edited (a "before" to compare with, an outpaint preview),
   * without touching the mask; null goes back.
   */
  preview(source: CanvasImageSource | null, width?: number, height?: number): void;
  /** Clears the mask as one undoable step. */
  clearMask(): void;
  /** Counts committed mask changes (strokes, undo, redo, clear, invert, a new picture). */
  revision(): number;
  undo(): void;
  redo(): void;
  fit(): void;
  select(tool: EditorTool): void;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
const MIN_SIZE = 2;
const MAX_SIZE = 400;
const KEY_STEP = 10;
/** Quiet time before the brush position or the mask's coverage is announced. */
const ANNOUNCE_DELAY_MS = 700;
/** CSS pixels per wheel "line" (Firefox reports lines). */
const LINE_PIXELS = 16;

const describeOp = (op: MaskOp): string =>
  op.type === 'stroke' ? (op.tool === 'brush' ? 'brush stroke' : 'eraser stroke') : `${op.type}`;

export function canvasEditor(options: CanvasEditorOptions = {}): CanvasEditor {
  const ids = { help: uid('editor-help'), size: uid('editor-size') };

  // --- state -----------------------------------------------------------------------------------------------
  let source: CanvasImageSource | null = null;
  let width = 0;
  let height = 0;
  let maskData: Mask = createMask(0, 0);
  let ops: MaskOp[] = [];
  let redoOps: MaskOp[] = [];
  let tool: EditorTool = 'brush';
  let diameter = 40;
  let painting = true;
  let overlayVisible = true;
  let shown: { source: CanvasImageSource; width: number; height: number } | null = null;
  let overlay: ImageData | null = null;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let fitted = true;
  /** The brush outline in image pixels (hover or keyboard), or null when hidden. */
  let pointer: { x: number; y: number } | null = null;
  let stroke: { pointerId: number; op: Extract<MaskOp, { type: 'stroke' }> } | null = null;
  let panning: { pointerId: number; x: number; y: number; tx: number; ty: number } | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: {
    distance: number;
    scale: number;
    cx: number;
    cy: number;
    tx: number;
    ty: number;
  } | null = null;
  let spaceDown = false;
  /** The tool chosen before painting was switched off, restored when it comes back. */
  let toolBeforePause: EditorTool | null = null;

  // --- elements --------------------------------------------------------------------------------------------
  const imageCanvas = h('canvas', { class: 'or-editor-image' });
  const maskCanvas = h('canvas', { class: 'or-editor-mask' });
  const stage = h('div', { class: 'or-editor-stage' }, imageCanvas, maskCanvas);
  const outline = h('div', { class: 'or-editor-cursor', hidden: true, 'aria-hidden': 'true' });
  const viewport = h(
    'div',
    {
      class: 'or-editor-viewport or-checkerboard',
      tabIndex: 0,
      role: 'application',
      'aria-roledescription': 'drawing canvas',
      'aria-label': 'Picture and mask',
      'aria-describedby': ids.help,
      'data-testid': 'editor-canvas',
    },
    stage,
    outline,
  );
  const coverageText = h('div', {
    class: 'small text-body-secondary me-auto',
    'data-testid': 'editor-coverage',
  });
  const reasonText = h('div', {
    class: 'small text-body-secondary',
    hidden: true,
    'data-testid': 'editor-reason',
  });

  const toolName = uid('editor-tool');
  const toolRadio = (
    value: EditorTool,
    label: string,
    glyph: string,
    key: string,
  ): { input: HTMLInputElement; element: HTMLElement } => {
    const id = uid('editor-tool-option');
    const input = h('input', {
      id,
      type: 'radio',
      class: 'btn-check',
      name: toolName,
      value,
      autocomplete: 'off',
      'aria-keyshortcuts': key,
      'data-testid': `editor-tool-${value}`,
      checked: value === tool,
      onchange: () => {
        if (input.checked) select(value);
      },
    });
    return {
      input,
      element: h(
        'span',
        null,
        input,
        h(
          'label',
          {
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            htmlFor: id,
            title: `${label} (${key})`,
          },
          icon(glyph),
          label,
        ),
      ),
    };
  };
  const tools = {
    brush: toolRadio('brush', 'Brush', 'brush', 'B'),
    eraser: toolRadio('eraser', 'Eraser', 'eraser', 'E'),
    pan: toolRadio('pan', 'Hand', 'arrows-move', 'H'),
  };

  const sizeInput = h('input', {
    id: ids.size,
    type: 'range',
    class: 'form-range or-editor-size',
    min: String(MIN_SIZE),
    max: String(MAX_SIZE),
    step: '1',
    value: String(diameter),
    'aria-keyshortcuts': '[ ]',
    'data-testid': 'editor-size',
  });
  const sizeValue = h('span', { class: 'small text-body-secondary' });
  sizeInput.addEventListener('input', () => setSize(Number(sizeInput.value)));

  const button = (
    label: string,
    glyph: string,
    testId: string,
    onClick: () => void,
    extra: Record<string, string> = {},
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-label': label,
        title: label,
        'data-testid': testId,
        onclick: onClick,
        ...extra,
      },
      icon(glyph),
    );
  // The shortcuts are the platform's own: ⌘ on Apple devices, Ctrl elsewhere (the key handler takes both).
  const apple = isApplePlatform();
  const modifier = apple ? '⌘' : 'Ctrl+';
  const modifierKey = apple ? 'Meta' : 'Control';
  const undoButton = button(
    `Undo (${modifier}Z)`,
    'arrow-counterclockwise',
    'editor-undo',
    () => undo(),
    { 'aria-keyshortcuts': `${modifierKey}+Z` },
  );
  const redoButton = button(
    `Redo (${modifier}${apple ? '⇧' : 'Shift+'}Z)`,
    'arrow-clockwise',
    'editor-redo',
    () => redo(),
    { 'aria-keyshortcuts': `${modifierKey}+Shift+Z` },
  );
  const clearButton = button('Clear the mask', 'x-square', 'editor-clear', () => clearMask());
  const invertButton = button('Invert the mask', 'symmetry-vertical', 'editor-invert', () =>
    commit({ type: 'invert' }),
  );
  const overlayButton = button(
    'Show the mask (M)',
    'eye',
    'editor-overlay',
    () => setOverlay(!overlayVisible),
    { 'aria-pressed': 'true', 'aria-keyshortcuts': 'M' },
  );
  const zoomLabel = h('span', {
    class: 'small text-body-secondary or-editor-zoom',
    'data-testid': 'editor-zoom',
  });
  const zoomOut = button('Zoom out (-)', 'zoom-out', 'editor-zoom-out', () => zoomBy(1 / 1.25));
  const zoomIn = button('Zoom in (+)', 'zoom-in', 'editor-zoom-in', () => zoomBy(1.25));
  const fitButton = button('Fit to the panel (0)', 'arrows-angle-contract', 'editor-fit', () =>
    fit(),
  );

  const element = h(
    'div',
    { class: 'or-editor vstack gap-2', 'data-testid': 'editor' },
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2' },
      h(
        'div',
        { class: 'd-flex flex-wrap gap-1', role: 'group', 'aria-label': 'Tool' },
        tools.brush.element,
        tools.eraser.element,
        tools.pan.element,
      ),
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        h('label', { class: 'small', htmlFor: ids.size }, 'Size'),
        sizeInput,
        sizeValue,
      ),
      h(
        'div',
        { class: 'd-flex flex-wrap gap-1', role: 'group', 'aria-label': 'Mask' },
        undoButton,
        redoButton,
        clearButton,
        invertButton,
        overlayButton,
      ),
      h(
        'div',
        {
          class: 'd-flex flex-wrap align-items-center gap-1 ms-auto',
          role: 'group',
          'aria-label': 'View',
        },
        zoomOut,
        zoomIn,
        fitButton,
        zoomLabel,
      ),
    ),
    viewport,
    h('div', { class: 'd-flex flex-wrap gap-2 align-items-baseline' }, coverageText, reasonText),
    h(
      'p',
      { id: ids.help, class: 'form-text mb-0' },
      'Paint over what should change. Keys: B brush, E eraser, H hand, [ and ] size, M show the mask, 0 fit, ' +
        `${modifier}Z undo. On the canvas, arrows move the brush, Shift+arrows paint, Enter paints a dot; ` +
        `${modifier}wheel or a pinch zooms.`,
    ),
  );

  // --- drawing ---------------------------------------------------------------------------------------------
  const context = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null =>
    canvas.getContext('2d');

  const drawImage = (): void => {
    const display = shown ?? (source ? { source, width, height } : null);
    if (!display) return;
    if (imageCanvas.width !== display.width || imageCanvas.height !== display.height) {
      imageCanvas.width = display.width;
      imageCanvas.height = display.height;
    }
    imageCanvas.style.width = `${display.width}px`;
    imageCanvas.style.height = `${display.height}px`;
    const ctx = context(imageCanvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(display.source, 0, 0, display.width, display.height);
  };

  /** Copies the mask into the overlay (all of it, or `box`) and draws that part. */
  const renderOverlay = (box: Box | null = { x: 0, y: 0, width, height }): void => {
    if (!box || width === 0) return;
    const ctx = context(maskCanvas);
    if (!ctx) return;
    if (!overlay || overlay.width !== width || overlay.height !== height) {
      overlay = ctx.createImageData(width, height);
      box = { x: 0, y: 0, width, height };
    }
    const data = overlay.data;
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const p = y * width + x;
        const i = p * 4;
        const marked = (maskData.data[p] ?? 0) > 0;
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = marked ? 128 : 0;
      }
    }
    ctx.putImageData(overlay, 0, 0, box.x, box.y, box.width, box.height);
  };

  const viewSize = (): { width: number; height: number } => {
    const display = shown ?? { width, height };
    return { width: display.width, height: display.height };
  };

  const applyTransform = (): void => {
    stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    drawOutline();
  };

  const drawOutline = (): void => {
    const show = pointer !== null && painting && tool !== 'pan' && !shown && source !== null;
    outline.hidden = !show;
    if (!show || !pointer) return;
    const size = diameter * scale;
    outline.style.width = `${size}px`;
    outline.style.height = `${size}px`;
    outline.style.transform = `translate(${tx + pointer.x * scale - size / 2}px, ${ty + pointer.y * scale - size / 2}px)`;
    outline.classList.toggle('is-eraser', tool === 'eraser');
  };

  const syncButtons = (): void => {
    const canPaint = painting && source !== null && !shown;
    undoButton.disabled = !canPaint || ops.length === 0;
    redoButton.disabled = !canPaint || redoOps.length === 0;
    clearButton.disabled = !canPaint || isMaskEmpty(maskData);
    invertButton.disabled = !canPaint;
    overlayButton.disabled = !painting || source === null;
    tools.brush.input.disabled = !canPaint;
    tools.eraser.input.disabled = !canPaint;
    for (const control of [zoomIn, zoomOut, fitButton]) control.disabled = source === null;
    const coverage = width > 0 ? maskCoverage(maskData) : 0;
    coverageText.hidden = !painting;
    coverageText.textContent = !source
      ? ''
      : coverage === 0
        ? 'No mask painted yet.'
        : `Mask covers ${coverage < 0.001 ? 'under 0.1' : (coverage * 100).toFixed(1)}% of the picture.`;
    viewport.classList.toggle('is-panning', tool === 'pan' || !canPaint);
  };

  let revision = 0;
  const changed = (): void => {
    revision += 1;
    syncButtons();
    options.onMaskChange?.();
  };

  /** Polite and debounced: a run of strokes or key presses is announced once. */
  const announceCoverage = debounce(() => {
    if (!source) return;
    const coverage = maskCoverage(maskData);
    announce(
      coverage === 0
        ? 'The mask is empty.'
        : `Mask covers ${coverage < 0.001 ? 'under 0.1' : (coverage * 100).toFixed(1)}% of the picture.`,
    );
  }, ANNOUNCE_DELAY_MS);
  const announcePosition = debounce(() => {
    if (!pointer || width === 0) return;
    announce(
      `Brush at ${Math.round((pointer.x / width) * 100)}%, ${Math.round((pointer.y / height) * 100)}%.`,
    );
  }, ANNOUNCE_DELAY_MS);

  // --- view ------------------------------------------------------------------------------------------------
  const fit = (): void => {
    const view = viewSize();
    if (view.width === 0) return;
    const box = viewport.getBoundingClientRect();
    const availableWidth = Math.max(1, box.width - 16);
    const availableHeight = Math.max(1, box.height - 16);
    scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(availableWidth / view.width, availableHeight / view.height)),
    );
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    tx = (box.width - view.width * scale) / 2;
    ty = (box.height - view.height * scale) / 2;
    fitted = true;
    applyTransform();
  };

  const zoomAt = (clientX: number, clientY: number, factor: number): void => {
    const box = viewport.getBoundingClientRect();
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const x = clientX - box.left;
    const y = clientY - box.top;
    tx = x - ((x - tx) * next) / scale;
    ty = y - ((y - ty) * next) / scale;
    scale = next;
    fitted = false;
    applyTransform();
  };
  const zoomBy = (factor: number): void => {
    const box = viewport.getBoundingClientRect();
    zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor);
  };

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (fitted) fit();
    }).observe(viewport);
  }

  // --- tools -----------------------------------------------------------------------------------------------
  const select = (next: EditorTool): void => {
    if ((next === 'brush' || next === 'eraser') && (!painting || shown)) return;
    tool = next;
    tools[next].input.checked = true;
    syncButtons();
    drawOutline();
  };

  const setSize = (value: number): void => {
    diameter = Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, value)));
    sizeInput.value = String(diameter);
    sizeValue.textContent = `${diameter} px`;
    drawOutline();
  };

  const setOverlay = (visible: boolean): void => {
    overlayVisible = visible;
    maskCanvas.hidden = !visible || !painting || shown !== null;
    overlayButton.setAttribute('aria-pressed', String(visible));
    overlayButton.replaceChildren(icon(visible ? 'eye' : 'eye-slash'));
  };

  const commit = (op: MaskOp): void => {
    if (!source || !painting) return;
    const box = applyOp(maskData, op);
    ops.push(op);
    redoOps = [];
    renderOverlay(box);
    changed();
    if (op.type !== 'stroke') announce(op.type === 'clear' ? 'Mask cleared.' : 'Mask inverted.');
    else announceCoverage();
  };

  const clearMask = (): void => {
    if (isMaskEmpty(maskData)) return;
    commit({ type: 'clear' });
  };

  const undo = (): void => {
    const op = ops.pop();
    if (!op) return;
    redoOps.push(op);
    maskData = replayOps(width, height, ops);
    renderOverlay();
    changed();
    announce(`Undid the ${describeOp(op)}.`);
  };

  const redo = (): void => {
    const op = redoOps.pop();
    if (!op) return;
    ops.push(op);
    renderOverlay(applyOp(maskData, op));
    changed();
    announce(`Redid the ${describeOp(op)}.`);
  };

  // --- pointer input ---------------------------------------------------------------------------------------
  const toImage = (clientX: number, clientY: number): [number, number] => {
    const box = viewport.getBoundingClientRect();
    const x = (clientX - box.left - tx) / scale;
    const y = (clientY - box.top - ty) / scale;
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  };

  const cancelStroke = (): void => {
    if (!stroke) return;
    stroke = null;
    maskData = replayOps(width, height, ops);
    renderOverlay();
  };

  viewport.addEventListener('pointerdown', (event) => {
    if (!source) return;
    viewport.focus({ preventScroll: true });
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        cancelStroke();
        panning = null;
        const [a, b] = [...touches.values()];
        if (a && b) {
          pinch = {
            distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            scale,
            cx: (a.x + b.x) / 2,
            cy: (a.y + b.y) / 2,
            tx,
            ty,
          };
        }
        return;
      }
    }
    const canPaint = painting && !shown && tool !== 'pan';
    if (event.button === 1 || spaceDown || !canPaint) {
      panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, tx, ty };
      viewport.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    const point = toImage(event.clientX, event.clientY);
    stroke = {
      pointerId: event.pointerId,
      op: {
        type: 'stroke',
        tool: tool === 'eraser' ? 'eraser' : 'brush',
        radius: diameter / 2,
        points: [point],
      },
    };
    renderOverlay(
      stampDisc(maskData, point[0], point[1], diameter / 2, tool === 'eraser' ? 0 : 255),
    );
    viewport.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!source) return;
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      if (!a || !b) return;
      const box = viewport.getBoundingClientRect();
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, (pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance),
      );
      const cx = (a.x + b.x) / 2 - box.left;
      const cy = (a.y + b.y) / 2 - box.top;
      const startX = pinch.cx - box.left;
      const startY = pinch.cy - box.top;
      tx = cx - ((startX - pinch.tx) * next) / pinch.scale;
      ty = cy - ((startY - pinch.ty) * next) / pinch.scale;
      scale = next;
      fitted = false;
      applyTransform();
      return;
    }
    if (panning && panning.pointerId === event.pointerId) {
      tx = panning.tx + event.clientX - panning.x;
      ty = panning.ty + event.clientY - panning.y;
      fitted = false;
      applyTransform();
      return;
    }
    const point = toImage(event.clientX, event.clientY);
    pointer = { x: point[0], y: point[1] };
    drawOutline();
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    const points = stroke.op.points as [number, number][];
    const last = points[points.length - 1]!;
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.5) return;
    points.push(point);
    renderOverlay(
      paintSegment(maskData, last, point, stroke.op.radius, stroke.op.tool === 'brush' ? 255 : 0),
    );
  });

  const endPointer = (event: PointerEvent, cancelled: boolean): void => {
    touches.delete(event.pointerId);
    if (pinch && touches.size < 2) pinch = null;
    if (panning && panning.pointerId === event.pointerId) panning = null;
    if (stroke && stroke.pointerId === event.pointerId) {
      if (cancelled) cancelStroke();
      else {
        const op = stroke.op;
        stroke = null;
        ops.push(op);
        redoOps = [];
        changed();
        announceCoverage();
      }
    }
  };
  viewport.addEventListener('pointerup', (event) => endPointer(event, false));
  viewport.addEventListener('pointercancel', (event) => endPointer(event, true));
  viewport.addEventListener('pointerleave', () => {
    if (stroke) return;
    pointer = null;
    drawOutline();
  });
  viewport.addEventListener(
    'wheel',
    (event) => {
      // A plain wheel scrolls the page; Ctrl/Cmd+wheel (and a trackpad pinch, which browsers send as one) zooms.
      if (!source || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const pixels =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * LINE_PIXELS
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * Math.max(1, viewport.clientHeight)
            : event.deltaY;
      zoomAt(event.clientX, event.clientY, Math.exp(-pixels * 0.0015));
    },
    { passive: false },
  );

  // --- keyboard --------------------------------------------------------------------------------------------
  viewport.addEventListener('keydown', (event) => {
    if (!source || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === ' ') {
      spaceDown = true;
      event.preventDefault();
      return;
    }
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const move = moves[event.key];
    const canPaint = painting && !shown && tool !== 'pan';
    if (move) {
      event.preventDefault();
      if (!canPaint) {
        tx -= move[0] * KEY_STEP * 4;
        ty -= move[1] * KEY_STEP * 4;
        fitted = false;
        applyTransform();
        return;
      }
      const from = pointer ?? { x: width / 2, y: height / 2 };
      const step = KEY_STEP / scale;
      const to = {
        x: Math.min(width, Math.max(0, from.x + move[0] * step)),
        y: Math.min(height, Math.max(0, from.y + move[1] * step)),
      };
      pointer = to;
      if (event.shiftKey) {
        commit({
          type: 'stroke',
          tool: tool === 'eraser' ? 'eraser' : 'brush',
          radius: diameter / 2,
          points: [
            [from.x, from.y],
            [to.x, to.y],
          ],
        });
      } else announcePosition();
      drawOutline();
      return;
    }
    if (event.key === 'Enter' && canPaint) {
      event.preventDefault();
      const at = pointer ?? { x: width / 2, y: height / 2 };
      pointer = at;
      commit({
        type: 'stroke',
        tool: tool === 'eraser' ? 'eraser' : 'brush',
        radius: diameter / 2,
        points: [[at.x, at.y]],
      });
      drawOutline();
    }
  });
  viewport.addEventListener('keyup', (event) => {
    if (event.key === ' ') spaceDown = false;
  });
  viewport.addEventListener('focus', () => {
    if (!pointer && source) pointer = { x: width / 2, y: height / 2 };
    drawOutline();
  });
  viewport.addEventListener('blur', () => {
    spaceDown = false;
  });

  element.addEventListener('keydown', (event) => {
    if (!source) return;
    const target = event.target as HTMLElement;
    if (target.matches('input[type="text"], input[type="number"], textarea, select')) return;
    const key = event.key.toLowerCase();
    if (event.ctrlKey || event.metaKey) {
      if (key === 'z' && !event.shiftKey) undo();
      else if ((key === 'z' && event.shiftKey) || (key === 'y' && event.ctrlKey)) redo();
      else return;
      event.preventDefault();
      return;
    }
    if (event.altKey) return;
    const actions: Record<string, () => void> = {
      b: () => select('brush'),
      e: () => select('eraser'),
      h: () => select('pan'),
      '[': () => setSize(diameter / 1.25),
      ']': () => setSize(diameter * 1.25),
      m: () => setOverlay(!overlayVisible),
      '0': () => fit(),
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(1 / 1.25),
    };
    const action = actions[key];
    if (!action) return;
    event.preventDefault();
    action();
    if (key === 'b' || key === 'e' || key === 'h') {
      announce(tool === 'pan' ? 'Hand tool.' : tool === 'eraser' ? 'Eraser.' : 'Brush.');
    } else if (key === '[' || key === ']') announce(`Brush size ${diameter} pixels.`);
  });

  setSize(diameter);
  setOverlay(true);
  syncButtons();

  return {
    element,
    viewport,
    setImage(next, nextWidth, nextHeight, setOptions = {}) {
      const sameSize = nextWidth === width && nextHeight === height;
      source = next;
      shown = null;
      cancelStroke();
      if (!(setOptions.keepMask && sameSize)) {
        width = nextWidth;
        height = nextHeight;
        maskData = createMask(width, height);
        ops = [];
        redoOps = [];
        overlay = null;
        maskCanvas.width = width;
        maskCanvas.height = height;
        maskCanvas.style.width = `${width}px`;
        maskCanvas.style.height = `${height}px`;
        if (!sameSize) pointer = null;
        // A brush about a twentieth of the short side.
        setSize(Math.round(Math.min(width, height) / 20));
      }
      drawImage();
      renderOverlay();
      setOverlay(overlayVisible);
      fit();
      changed();
    },
    hasImage: () => source !== null,
    mask: () => maskData,
    isMaskEmpty: () => isMaskEmpty(maskData),
    setPainting(enabled, reason) {
      painting = enabled;
      if (stroke) cancelStroke();
      reasonText.hidden = enabled || !reason;
      reasonText.textContent = enabled ? '' : (reason ?? '');
      if (!enabled && toolBeforePause === null) {
        toolBeforePause = tool;
        tool = 'pan';
        tools.pan.input.checked = true;
      } else if (enabled && toolBeforePause !== null) {
        tool = toolBeforePause;
        toolBeforePause = null;
        tools[tool].input.checked = true;
      }
      setOverlay(overlayVisible);
      syncButtons();
      drawOutline();
    },
    preview(next, nextWidth, nextHeight) {
      shown =
        next && source
          ? { source: next, width: nextWidth ?? width, height: nextHeight ?? height }
          : null;
      drawImage();
      setOverlay(overlayVisible);
      if (fitted || shown) fit();
      syncButtons();
      drawOutline();
    },
    clearMask,
    revision: () => revision,
    undo,
    redo,
    fit,
    select,
  };
}
