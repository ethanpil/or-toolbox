import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ImageResult, RawImageModel, RawModel } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { stemFrom, setup } from './tool';

vi.mock('../../core/media/image', () => ({
  loadImage: () => Promise.resolve({ width: 1024, height: 1024, close: () => undefined }),
  imageSize: (image: { width: number; height: number }) => ({
    width: image.width,
    height: image.height,
  }),
  toDataUrl: (blob: Blob) => Promise.resolve(`data:${blob.type};base64,REF`),
  toBlob: () => Promise.resolve(new Blob(['x'], { type: 'image/png' })),
}));

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const PER_TOKEN = 0.014 / 4096;

const catalog: RawModel[] = [
  {
    id: KLEIN,
    name: 'FLUX.2 klein 4B',
    created: 1,
    context_length: null,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    pricing: { prompt: '0', completion: '0', image_output: String(PER_TOKEN) },
  },
];
const imageModels: RawImageModel[] = [
  {
    id: KLEIN,
    name: 'FLUX.2 klein 4B',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '16:9', '9:16'] },
      output_format: { type: 'enum', values: ['png', 'jpeg'] },
      n: { type: 'range', min: 1, max: 1 },
      input_references: { type: 'range', min: 0, max: 4 },
      seed: { type: 'boolean' },
    },
  },
];

const png = (): Blob => new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });

let t: ToolTestContext;
let calls: ImageRequest[];

async function mount(api: Partial<ApiClient> = {}) {
  calls = [];
  t = createToolTestContext(getTool('image-generation'), {
    catalog,
    api: {
      images: (body) => {
        calls.push(body);
        return Promise.resolve<ImageResult>({
          created: 0,
          images: [{ blob: png(), mediaType: 'image/png' }],
          usage: { cost: 0.014 },
          generationId: null,
        });
      },
      catalog: {
        models: () => Promise.resolve(catalog),
        modelEndpoints: () => Promise.resolve([]),
        imageModels: () => Promise.resolve(imageModels),
        videoModels: () => Promise.resolve([]),
      },
      ...api,
    },
  });
  const tool = await t.mount(setup);
  await vi.waitFor(() =>
    expect(t.zones.input.querySelector('[data-testid="imagegen-aspect-16-9"]')).not.toBeNull(),
  );
  return tool;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;

beforeAll(() => {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
});
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
});
afterEach(() => {
  t.cleanup();
  for (const result of t.core.results.pending()) t.core.results.remove(result.id);
});

describe('Image generation', () => {
  it('round-trips its form through getState/applyState', async () => {
    const tool = await mount();
    const state = {
      prompt: 'A lighthouse at dusk',
      settings: {
        style: 'watercolour',
        negative: 'text',
        aspectRatio: '16:9',
        resolution: '',
        size: '',
        quality: '',
        outputFormat: 'png',
        transparent: false,
        seed: 99,
        seedLocked: true,
        count: 2,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    expect($<HTMLInputElement>('imagegen-aspect-16-9').checked).toBe(true);
    expect($<HTMLSelectElement>('imagegen-count').value).toBe('2');
    expect($<HTMLInputElement>('imagegen-seed').value).toBe('99');
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
  });

  it('estimates per image from the catalog price, times the count', async () => {
    const tool = await mount();
    await t.ctx.ui.refreshEstimate();
    const one = t.estimate()!;
    expect(one).toBeCloseTo(4175 * PER_TOKEN, 8);
    tool.applyState({ ...tool.getState(), settings: { ...tool.getState().settings, count: 3 } });
    await t.ctx.ui.refreshEstimate();
    expect(t.estimate()).toBeCloseTo(3 * one, 8);
  });

  it('makes two images as two requests with consecutive seeds, and shows both in the gallery', async () => {
    const tool = await mount();
    tool.applyState({
      prompt: 'A lighthouse at dusk',
      settings: {
        ...tool.getState().settings,
        count: 2,
        seed: 500,
        seedLocked: true,
        aspectRatio: '16:9',
      },
    });
    await t.runners[0]!.trigger();
    expect(calls.map((call) => call.seed)).toEqual([500, 501]);
    expect(calls[0]).toMatchObject({
      model: KLEIN,
      prompt: 'A lighthouse at dusk',
      aspect_ratio: '16:9',
    });
    expect(calls[0]?.n).toBeUndefined();
    const cards = t.zones.output.querySelectorAll('[data-testid="imagegen-result"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.querySelector('h4')?.textContent).toBe('Image 1');
    expect(t.status()).toBe('2 images ready');
    const runs = await t.core.history.query({ tool: 'image-generation' });
    expect(runs[0]).toMatchObject({ status: 'ok', settings: { seed: 500, count: 2 } });
  });

  it('draws a new seed for each run unless locked, shown in the field after the run starts', async () => {
    const tool = await mount();
    tool.applyState({ prompt: 'A cat', settings: {} });
    await t.runners[0]!.trigger();
    const seed = calls[0]?.seed;
    expect(typeof seed).toBe('number');
    expect(tool.getState().settings['seed']).toBe(seed);
    await t.runners[0]!.trigger();
    expect(calls[1]?.seed).not.toBe(seed);
  });

  it('Variations repeats a result’s request with a new seed; Use as reference adds it', async () => {
    await mount();
    $<HTMLTextAreaElement>('tool-prompt').value = 'A fox';
    $<HTMLTextAreaElement>('tool-prompt').dispatchEvent(new Event('input'));
    await t.runners[0]!.trigger();
    $<HTMLButtonElement>('imagegen-vary').click();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await vi.waitFor(() => expect(t.runners[0]!.busy).toBe(false));
    expect(calls[1]).toMatchObject({ prompt: 'A fox', model: KLEIN });
    expect(calls[1]?.seed).not.toBe(calls[0]?.seed);
    expect(t.zones.output.querySelectorAll('[data-testid="imagegen-group"]')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('[data-testid="imagegen-use-reference"]')!.click();
    await vi.waitFor(() =>
      expect(t.zones.input.querySelectorAll('[data-testid="imagegen-reference"]')).toHaveLength(1),
    );
    expect($('imagegen-reference-count').textContent).toBe('1 of 4');
    await t.runners[0]!.trigger();
    expect(calls[2]?.input_references).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,REF' } },
    ]);
  });

  it('keeps a failed request’s card with Retry, which sends the same request again', async () => {
    let fail = true;
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      if (fail) {
        fail = false;
        return Promise.reject(new ApiError('Provider returned an error', 502));
      }
      return Promise.resolve({
        created: 0,
        images: [{ blob: png(), mediaType: 'image/png' }],
        usage: { cost: 0.014 },
        generationId: null,
      });
    };
    await mount({ images });
    $<HTMLTextAreaElement>('tool-prompt').value = 'A fox';
    $<HTMLTextAreaElement>('tool-prompt').dispatchEvent(new Event('input'));
    await t.runners[0]!.trigger();
    expect($('imagegen-error').textContent).toBe('Provider returned an error');
    $<HTMLButtonElement>('imagegen-retry').click();
    await vi.waitFor(() =>
      expect(t.zones.output.querySelector('[data-testid="imagegen-result"]')).not.toBeNull(),
    );
    expect(calls[1]).toEqual(calls[0]);
  });

  it('says when the chosen model is not on the image endpoint, and does not run', async () => {
    t = createToolTestContext(getTool('image-generation'), {
      catalog,
      modelOverride: 'openai/gpt-5-image',
      api: {
        catalog: {
          models: () => Promise.resolve(catalog),
          modelEndpoints: () => Promise.resolve([]),
          imageModels: () => Promise.resolve(imageModels),
          videoModels: () => Promise.resolve([]),
        },
      },
    });
    await t.mount(setup);
    await vi.waitFor(() => expect(t.runners[0]!.disabledReason).toMatch(/not available/));
    expect($('imagegen-missing').textContent).toContain('openai/gpt-5-image is not served');
  });

  it('re-reads the image models after a catalog refresh without asking the network again', async () => {
    let reads = 0;
    await mount({
      catalog: {
        models: () => Promise.resolve(catalog),
        modelEndpoints: () => Promise.resolve([]),
        imageModels: () => {
          reads++;
          return Promise.resolve(imageModels);
        },
        videoModels: () => Promise.resolve([]),
      },
    });
    t.core.bus.emit({ type: 'models-refreshed' });
    t.core.bus.emit({ type: 'models-refreshed' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reads).toBe(1);
  });

  it('names files after the prompt', () => {
    expect(stemFrom('A lighthouse, on a ROCKY coast at dusk!')).toBe('a-lighthouse-on-a-rocky');
    expect(stemFrom('   ')).toBe('image');
  });
});
