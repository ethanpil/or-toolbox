import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFileDrop } from './file-drop';

/** jsdom has no DragEvent/DataTransfer: a cancelable event carrying just what the guard reads. */
function drag(type: string, files: File[], types = files.length > 0 ? ['Files'] : ['text/plain']) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  window.dispatchEvent(event);
  return event;
}

const toastText = (): string =>
  [...document.querySelectorAll('[data-testid="toast"]')].map((t) => t.textContent).join(' | ');

let handler: ((files: File[]) => void) | null = null;
installFileDrop({ accept: ['text/plain'], toolName: 'Chat', handler: () => handler });

afterEach(() => {
  handler = null;
  document.querySelectorAll('[data-testid="toast"]').forEach((node) => node.remove());
});

describe('installFileDrop', () => {
  it('catches file drags before the tool is ready, so a drop never opens the file', () => {
    expect(
      drag('dragover', [new File(['x'], 'a.txt', { type: 'text/plain' })]).defaultPrevented,
    ).toBe(true);
    const drop = drag('drop', [new File(['x'], 'a.txt', { type: 'text/plain' })]);
    expect(drop.defaultPrevented).toBe(true);
    expect(toastText()).toContain("Chat doesn't take files.");
  });

  it('hands only accepted files to the tool and names the rest', () => {
    const received = vi.fn();
    handler = received;
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    drag('drop', [text, new File([new Uint8Array([1])], 'b.png', { type: 'image/png' })]);
    expect(received).toHaveBeenCalledWith([text]);
    expect(toastText()).toContain('Skipped 1 file');
  });

  it('leaves drags without files (text, links) alone', () => {
    expect(drag('dragover', []).defaultPrevented).toBe(false);
    expect(drag('drop', []).defaultPrevented).toBe(false);
  });
});
