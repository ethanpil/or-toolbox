import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { announce } from '../../ui/feedback/announce';
import { canvasEditor } from './canvas-editor';

vi.mock('../../ui/feedback/announce', () => ({ announce: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(root: ParentNode, id: string): T =>
  root.querySelector<T>(`[data-testid="${id}"]`)!;

beforeAll(() => {
  // jsdom has no canvas: the mask logic runs without drawing.
  HTMLCanvasElement.prototype.getContext = () => null;
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(announce).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function mounted() {
  const onMaskChange = vi.fn();
  const editor = canvasEditor({ onMaskChange });
  document.body.append(editor.element);
  editor.setImage({} as CanvasImageSource, 200, 100);
  return { editor, onMaskChange };
}

const key = (target: HTMLElement, name: string, init: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...init }));

describe('canvasEditor', () => {
  it('says where the brush is after keyboard moves, and how much is masked after painting', () => {
    const { editor } = mounted();
    editor.viewport.focus();
    key(editor.viewport, 'ArrowRight');
    key(editor.viewport, 'ArrowRight');
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(announce).mock.calls.map(([text]) => text)).toEqual(['Brush at 100%, 50%.']);

    vi.mocked(announce).mockClear();
    key(editor.viewport, 'Enter');
    expect(announce).not.toHaveBeenCalled(); // debounced: strokes in a row are announced once
    vi.advanceTimersByTime(1000);
    expect(vi.mocked(announce).mock.calls.map(([text]) => text)).toEqual([
      expect.stringMatching(/^Mask covers (under 0\.1|\d+\.\d)% of the picture\.$/),
    ]);
  });

  it('counts committed mask changes, so a later step can tell whether the mask changed', () => {
    const { editor } = mounted();
    const before = editor.revision();
    editor.viewport.focus();
    key(editor.viewport, 'Enter');
    expect(editor.revision()).toBe(before + 1);
    editor.undo();
    expect(editor.revision()).toBe(before + 2);
  });

  it('leaves the wheel to the page unless Ctrl/Cmd is held (or a pinch); lines and pages count in full', () => {
    const { editor, onMaskChange } = mounted();
    const zoom = $(editor.element, 'editor-zoom');
    const fitted = zoom.textContent;
    const plain = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    editor.viewport.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(zoom.textContent).toBe(fitted);

    const pixels = new WheelEvent('wheel', {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.viewport.dispatchEvent(pixels);
    expect(pixels.defaultPrevented).toBe(true);
    const afterPixels = parseInt(zoom.textContent ?? '0', 10);

    editor.fit();
    const lines = new WheelEvent('wheel', {
      deltaY: -100,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.viewport.dispatchEvent(lines);
    // 100 lines are far more than 100 pixels: Firefox's line-based wheel zooms like everyone else's.
    expect(parseInt(zoom.textContent ?? '0', 10)).toBeGreaterThan(afterPixels * 5);
    expect(onMaskChange).toHaveBeenCalledTimes(1); // only the picture load
  });

  it('names the shortcut of the platform on Undo and Redo', () => {
    const platform = vi.spyOn(navigator, 'platform', 'get');
    platform.mockReturnValue('Win32');
    let { editor } = mounted();
    expect($(editor.element, 'editor-undo').getAttribute('aria-label')).toBe('Undo (Ctrl+Z)');
    expect($(editor.element, 'editor-redo').getAttribute('aria-label')).toBe('Redo (Ctrl+Shift+Z)');
    expect($(editor.element, 'editor-undo').getAttribute('aria-keyshortcuts')).toBe('Control+Z');
    document.body.replaceChildren();

    platform.mockReturnValue('MacIntel');
    ({ editor } = mounted());
    expect($(editor.element, 'editor-undo').getAttribute('aria-label')).toBe('Undo (⌘Z)');
    expect($(editor.element, 'editor-redo').getAttribute('aria-label')).toBe('Redo (⌘⇧Z)');
    expect($(editor.element, 'editor-undo').getAttribute('aria-keyshortcuts')).toBe('Meta+Z');
    platform.mockRestore();
  });
});
