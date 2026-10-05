import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { Capability } from '../../core/types';
import { getTool } from '../../tools/registry';
import { createToolTestContext } from '../tool/testing';
import { modelPicker } from './model-picker';

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});

afterEach(() => {
  document.body.replaceChildren();
});

const $ = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Opens the picker, runs `check` on it, and closes it again. */
async function withPicker(capability: Capability, check: () => void): Promise<void> {
  const t = createToolTestContext(getTool('decision'));
  const closed = modelPicker(t.core, { capability });
  await vi.waitFor(() => expect($('model-search')).not.toBeNull());
  check();
  document
    .querySelector<HTMLElement>('[data-testid="model-picker"] [data-bs-dismiss="modal"]')!
    .click();
  await closed;
}

describe('modelPicker', () => {
  it('describes the search field by the capability’s help note, when there is one', async () => {
    await withPicker('decisions', () => {
      const help = $('model-picker-help')!;
      expect(help).not.toBeNull();
      expect(help.id).not.toBe('');
      expect($('model-search')!.getAttribute('aria-describedby')).toBe(help.id);
    });
  });

  it('adds no description when the capability has no note', async () => {
    await withPicker('text', () => {
      expect($('model-picker-help')).toBeNull();
      expect($('model-search')!.hasAttribute('aria-describedby')).toBe(false);
    });
  });
});
