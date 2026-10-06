import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../core/storage/db';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { getTool } from '../../tools/registry';
import { h } from '../dom';
import { createToolTestContext, type ToolTestContext } from './testing';
import type { ToolInstance, ToolSetup } from './types';

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

  it('mounts a tool with a disabled Run, the tool-prompt field and a sample', async () => {
    t = createToolTestContext(getTool('ocr'));
    const tool = await t.mount((ctx) => {
      const base = tinyTool(ctx) as ToolInstance;
      ctx.ui.runner({ run: () => Promise.resolve() }).setDisabled('Not ready');
      return { ...base, sample: () => base.applyState({ prompt: 'A sample', settings: {} }) };
    });
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

  it('adds paid add-ons to the badge and passes them to the run', async () => {
    t = createToolTestContext(getTool('ocr'));
    let pages = 10;
    const tool = await t.mount((ctx) => {
      const base = tinyTool(ctx) as ToolInstance;
      return {
        ...base,
        estimate: () => Promise.resolve(0.01),
        addons: () => [
          { id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR', estimateUsd: pages * 0.002 },
        ],
      };
    });
    expect(t.estimate()).toBeCloseTo(0.03);
    pages = 20;
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeCloseTo(0.05);
    const run = await t.ctx.beginRun({});
    expect((await (await getDb()).get('runs', run.id))?.reservedUsd).toBeCloseTo(0.05);
    await run.finish();

    t.core.settings.update((draft) => {
      draft.freeOnly = true;
    });
    await expect(t.ctx.beginRun({ model: 'a/b:free' })).rejects.toMatchObject({
      addons: ['Mistral OCR'],
    });
    expect(tool.getState()).toBeDefined();
  });

  it('books an estimate of the input as it is when the run starts, even without a refresh', async () => {
    t = createToolTestContext(getTool('chat'));
    const tool = await t.mount(tinyTool);
    tool.applyState({ prompt: 'x'.repeat(20), settings: {} });
    await t.ctx.ui.refreshEstimate();
    tool.applyState({ prompt: 'x'.repeat(400), settings: {} }); // pasted; no refresh before Run
    const run = await t.ctx.beginRun({});
    const record = await (await getDb()).get('runs', run.id);
    expect(record?.reservedUsd).toBeCloseTo(0.4);
    expect(t.estimate()).toBeCloseTo(0.4);
    await run.finish();
  });

  it('books the estimate of the model a run chooses, not of the header model', async () => {
    t = createToolTestContext(getTool('chat'));
    const asked: string[] = [];
    const tool = await t.mount((ctx) => ({
      ...(tinyTool(ctx) as ToolInstance),
      estimate: (model) => {
        asked.push(model);
        return Promise.resolve(model === 'x/dear' ? 2 : 0.01);
      },
    }));
    tool.applyState({ prompt: 'hello', settings: {} });
    t.core.settings.update((draft) => {
      draft.budgets.perRunUsd = 1;
    });
    // Over the per-run limit: with an unknown (null) estimate the check would be skipped.
    const checks: number[] = [];
    t.core.runs.setConfirmHandler((check) => {
      checks.push(check.reasons.length);
      return Promise.resolve(true);
    });
    const run = await t.ctx.beginRun({ model: 'x/dear' });
    expect(asked).toContain('x/dear');
    expect((await (await getDb()).get('runs', run.id))?.reservedUsd).toBe(2);
    expect(checks).toEqual([1]);
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
