import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCore, isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { promptsPanel } from './prompts-panel';

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(() => {
  document.body.replaceChildren();
});

describe('promptsPanel for a promptless tool', () => {
  it('saves the settings as a named preset and shows it without Copy', async () => {
    const { core } = createTestCore();
    const applied = vi.fn();
    const panel = promptsPanel(core, {
      tool: 'isolated-image',
      getState: () => ({ prompt: '', settings: { size: 1024, shadow: true } }),
      applyState: applied,
      promptless: true,
    });
    document.body.append(panel.element);

    $('prompts-save-current')!.click();
    await vi.waitFor(() => expect($('prompt-dialog')).not.toBeNull());
    expect($('prompt-dialog')!.textContent).toContain('Save current settings');
    const input = $<HTMLInputElement>('prompt-input')!;
    input.form!.requestSubmit(); // a name is required: nothing to show otherwise
    expect(input.classList.contains('is-invalid')).toBe(true);
    input.value = 'Square with shadow';
    input.form!.requestSubmit();

    await vi.waitFor(() => expect($('prompt-name')?.textContent).toBe('Square with shadow'));
    expect($('prompt-text')?.textContent).toBe('Settings only');
    expect($('prompt-copy')).toBeNull();
    expect(await core.prompts.list('isolated-image', 'saved')).toMatchObject([
      { text: '', settings: { size: 1024, shadow: true }, name: 'Square with shadow' },
    ]);
    $('prompt-use')!.click();
    expect(applied).toHaveBeenCalledWith({ prompt: '', settings: { size: 1024, shadow: true } });
  });
});
