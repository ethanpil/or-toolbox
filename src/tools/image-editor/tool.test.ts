import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawImageModel, RawModel } from '../../core/api/types';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const PER_TOKEN = 0.014 / 4096;
const catalog: RawModel[] = [
  {
    id: KLEIN,
    name: 'FLUX.2 klein 4B',
    created: 1,
    context_length: null,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    pricing: { prompt: '0', completion: '0', image: '0.000001', image_output: String(PER_TOKEN) },
  },
];
const imageModels: RawImageModel[] = [
  {
    id: KLEIN,
    name: 'FLUX.2 klein 4B',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9'] },
      input_references: { type: 'range', min: 0, max: 4 },
    },
  },
];

let t: ToolTestContext;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;

async function mount() {
  t = createToolTestContext(getTool('image-editor'), {
    catalog,
    api: {
      catalog: {
        models: () => Promise.resolve(catalog),
        modelEndpoints: () => Promise.resolve([]),
        imageModels: () => Promise.resolve(imageModels),
        videoModels: () => Promise.resolve([]),
      },
    },
  });
  return t.mount(setup);
}

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(() => t.cleanup());

describe('Image editor', () => {
  it('round-trips its form through getState/applyState and follows the mode', async () => {
    const tool = await mount();
    const state = {
      prompt: 'More beach',
      settings: {
        mode: 'outpaint',
        keepOutside: false,
        feather: 10,
        extend: '16:9',
        margins: { top: 5, right: 10, bottom: 15, left: 20 },
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    expect($<HTMLInputElement>('editor-mode-outpaint').checked).toBe(true);
    expect($('editor-outpaint').hidden).toBe(false);
    expect($<HTMLSelectElement>('editor-extend').value).toBe('16:9');
    expect($<HTMLInputElement>('editor-keep-outside').checked).toBe(false);

    tool.applyState({ prompt: 'x', settings: { mode: 'whole' } });
    expect($('editor-outpaint').hidden).toBe(true);
    expect($('editor-keep-outside').closest('.form-switch')?.hasAttribute('hidden')).toBe(true);
    expect(tool.getState().settings).toMatchObject({
      mode: 'whole',
      keepOutside: true,
      feather: 6,
    });
  });

  it('estimates one image plus the references the mode sends', async () => {
    const tool = await mount();
    await t.ctx.ui.refreshEstimate();
    const inpaint = t.estimate()!;
    // Three references (marked, plain, mask) at 4096 tokens each on top of one output image.
    expect(inpaint).toBeCloseTo(4175 * PER_TOKEN + 3 * 4096 * 0.000001, 8);
    tool.applyState({ prompt: 'x', settings: { mode: 'whole' } });
    await vi.waitFor(async () => {
      await t.ctx.ui.refreshEstimate();
      expect(t.estimate()).toBeCloseTo(4175 * PER_TOKEN + 4096 * 0.000001, 8);
    });
  });

  it('asks for a picture before anything else', async () => {
    await mount();
    expect($('editor-empty').hidden).toBe(false);
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Load a picture first.');
  });
});
