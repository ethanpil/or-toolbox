import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../core/storage/db';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { getTool } from '../../tools/registry';
import { h } from '../dom';
import { comingSoon } from './coming-soon';
import { createToolTestContext, type ToolTestContext } from './testing';
import type { ToolSetup } from './types';

let t: ToolTestContext | null = null;

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(() => {
  t?.cleanup();
  t = null;
});

/** A minimal tool with a prompt, one setting and an estimate per character. */
const tinyTool: ToolSetup = (ctx) => {
  const prompt = h('textarea', { 'data-testid': 'tool-prompt' });
  const length = h('select', null, h('option', { value: 'short' }), h('option', { value: 'long' }));
  ctx.ui.input.append(prompt, length);
  return {
    getState: () => ({ prompt: prompt.value, settings: { length: length.value } }),
    applyState: (state) => {
      prompt.value = state.prompt;
      if (state.settings['length'] === 'short' || state.settings['length'] === 'long') {
        length.value = state.settings['length'];
      }
    },
    estimate: () => Promise.resolve(prompt.value.length / 1000),
  };
};

describe('createToolTestContext', () => {
  it('mounts a tool so its state round-trips exactly', async () => {
    t = createToolTestContext(getTool('chat'));
    const tool = await t.mount(tinyTool);
    const state = { prompt: 'Summarise this', settings: { length: 'long' } };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
  });

  it('mounts the stand-in instance, with its disabled Run and the tool-prompt field', async () => {
    t = createToolTestContext(getTool('ocr'));
    const tool = await t.mount(comingSoon);
    expect(t.zones.input.querySelector('[data-testid="tool-prompt"]')).not.toBeNull();
    expect(t.runners[0]?.button.getAttribute('aria-disabled')).toBe('true');
    await tool.sample?.();
    expect(tool.getState().prompt).not.toBe('');
  });

  it('books the framework estimate when a run gives none, recomputed after the input changed', async () => {
    t = createToolTestContext(getTool('chat'));
    const tool = await t.mount(tinyTool);
    expect(t.estimate()).toBe(0);
    tool.applyState({ prompt: 'x'.repeat(50), settings: {} });
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBe(0.05);
    const run = await t.ctx.beginRun({});
    const record = await (await getDb()).get('runs', run.id);
    expect(record).toMatchObject({ reservedUsd: 0.05, prompt: 'x'.repeat(50), tool: 'chat' });
    await run.finish();
  });

  it('applies the header model only to the primary capability', () => {
    t = createToolTestContext(getTool('chat'), { modelOverride: 'x/override' });
    t.core.settings.update((draft) => {
      draft.tools.chat = { model: 'x/pinned' };
    });
    expect(t.ctx.model().model).toBe('x/override');
    expect(t.ctx.model('vision').model).not.toBe('x/pinned');
    expect(t.ctx.model('vision').model).not.toBe('x/override');
  });
});
