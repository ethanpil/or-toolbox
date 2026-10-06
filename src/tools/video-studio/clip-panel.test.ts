// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { clipPanel } from './clip-panel';

describe('the frame pickers', () => {
  it('do not call a frame optional where the mode needs it', () => {
    const panel = clipPanel({
      ui: { status: vi.fn() },
      onMode: vi.fn(),
      onPrompt: vi.fn(),
      onSource: vi.fn(),
      onExtendUrl: vi.fn(),
      onUploads: vi.fn(),
      onImages: vi.fn(),
    });
    document.body.append(panel.element);
    for (const picker of [panel.first, panel.last, panel.references]) {
      expect(picker.element.textContent).not.toContain('(optional)');
      expect(picker.problem()).toMatch(/needs at least 1/i);
    }
  });
});
