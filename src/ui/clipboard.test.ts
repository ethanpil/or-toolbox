import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, copyWithToast } from './clipboard';

const toastText = (): string | undefined =>
  document.querySelector('[data-testid="toast"]')?.textContent ?? undefined;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function clipboard(writeText: () => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

describe('copyText', () => {
  it('writes through the Clipboard API', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    clipboard(writeText);
    expect(await copyText('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });
});

describe('copyWithToast', () => {
  it('says what was copied', async () => {
    clipboard(() => Promise.resolve());
    expect(await copyWithToast('hello', 'Prompt copied.')).toBe(true);
    expect(toastText()).toContain('Prompt copied.');
  });

  it('warns when the browser blocked it', async () => {
    clipboard(() => Promise.reject(new Error('denied')));
    // The textarea fallback needs execCommand, which jsdom lacks: it counts as blocked.
    expect(await copyWithToast('hello', 'Prompt copied.')).toBe(false);
    expect(toastText()).toContain('Copying was blocked by the browser.');
    expect(toastText()).not.toContain('Prompt copied.');
  });
});
