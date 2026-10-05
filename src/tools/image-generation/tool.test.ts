import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ImageResult, RawImageModel, RawModel } from '../../core/api/types';
import { ApiError, KeyLockedError } from '../../core/errors';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import type * as Media from '../../core/media/image';
import type * as Errors from '../../ui/feedback/errors';
import { presentError, wasPresented } from '../../ui/feedback/errors';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { stemFrom, setup } from './tool';

// jsdom cannot decode: sizes come from a stand-in header read, references from a stand-in encoder.
vi.mock('../../core/media/image', async (importOriginal) => ({
  ...(await importOriginal<typeof Media>()),
  loadImage: () => Promise.resolve({ width: 1024, height: 1024, close: () => undefined }),
  readImageSize: () => Promise.resolve({ width: 1024, height: 1024 }),
  toDataUrl: (blob: Blob) => Promise.resolve(`data:${blob.type};base64,REF`),
}));

// The shell's error presenter opens dialogs; here it only records what reached it.
vi.mock('../../ui/feedback/errors', async (importOriginal) => ({
  ...(await importOriginal<typeof Errors>()),
  presentError: vi.fn(() => Promise.resolve()),
}));

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const MULTI = 'openai/gpt-image-1';
const PER_TOKEN = 0.014 / 4096;

const catalog: RawModel[] = [
  {
    id: KLEIN,
    name: 'FLUX.2 klein 4B',
    created: 1,
    context_length: null,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    pricing: { prompt: '0', completion: '0', image: '0.001', image_output: String(PER_TOKEN) },
  },
  {
    id: MULTI,
    name: 'GPT Image 1',
    created: 1,
    context_length: null,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
    pricing: { prompt: '0', completion: '0', image_output: '0.00003' },
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
  {
    id: MULTI,
    name: 'GPT Image 1',
    supported_parameters: {
      aspect_ratio: { type: 'enum', values: ['1:1', '3:2'] },
      n: { type: 'range', min: 1, max: 4 },
      input_references: { type: 'range', min: 0, max: 16 },
    },
  },
];

const png = (): Blob => new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });

let t: ToolTestContext;
let calls: ImageRequest[];

async function mount(api: Partial<ApiClient> = {}, modelOverride: string | null = null) {
  calls = [];
  t = createToolTestContext(getTool('image-generation'), {
    catalog,
    modelOverride,
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
    expect(t.zones.input.querySelector('[data-testid="imagegen-aspect-1-1"]')).not.toBeNull(),
  );
  return tool;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;

beforeAll(() => {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  HTMLCanvasElement.prototype.getContext = () => null;
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

  it('a locked seed is always the seed sent; clearing the field unlocks it', async () => {
    const tool = await mount();
    tool.applyState({ prompt: 'A cat', settings: { seed: 77, seedLocked: true } });
    await t.runners[0]!.trigger();
    await t.runners[0]!.trigger();
    expect(calls.map((call) => call.seed)).toEqual([77, 77]);

    const field = $<HTMLInputElement>('imagegen-seed');
    field.value = '';
    field.dispatchEvent(new Event('input'));
    expect(tool.getState().settings).toMatchObject({ seed: null, seedLocked: false });
    expect($('imagegen-seed-lock').getAttribute('aria-pressed')).toBe('false');
  });

  it('records the seed a run used as locked, so History and Recent prompts reproduce it', async () => {
    const tool = await mount();
    tool.applyState({ prompt: 'A cat', settings: { count: 2 } });
    await t.runners[0]!.trigger();
    const [run] = await t.core.history.query({ tool: 'image-generation' });
    expect(run?.settings).toMatchObject({ seed: calls[0]!.seed, seedLocked: true, count: 2 });
    // The form itself stays unlocked: the next run draws a new seed.
    expect(tool.getState().settings['seedLocked']).toBe(false);
    tool.applyState({ prompt: run!.prompt ?? '', settings: run!.settings ?? {} });
    await t.runners[0]!.trigger();
    expect(calls.slice(2).map((call) => call.seed)).toEqual(
      calls.slice(0, 2).map((call) => call.seed),
    );

    // A variation is recorded with its own seed, locked.
    document.querySelector<HTMLButtonElement>('[data-testid="imagegen-vary"]')!.click();
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    await vi.waitFor(() => expect(t.runners[0]!.busy).toBe(false));
    const [variation] = await t.core.history.query({ tool: 'image-generation' });
    expect(variation?.settings).toMatchObject({ seed: calls[4]!.seed, seedLocked: true, count: 1 });
  });

  it('marks images a request did not deliver as failed, with a Retry for just those', async () => {
    let answer: ImageResult = {
      created: 0,
      images: [{ blob: png(), mediaType: 'image/png' }],
      usage: { cost: 0.01 },
      generationId: null,
      error: new ApiError('Provider returned an error', 502),
    };
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      return Promise.resolve(answer);
    };
    const tool = await mount({ images }, MULTI);
    tool.applyState({ prompt: 'A fox', settings: { count: 3 } });
    await t.runners[0]!.trigger();
    expect(calls[0]?.n).toBe(3);
    expect(t.zones.output.querySelectorAll('[data-testid="imagegen-result"]')).toHaveLength(1);
    const failed = t.zones.output.querySelector('[data-testid="imagegen-failed"]')!;
    expect(failed.querySelector('h4')?.textContent).toBe('Image 2');
    expect(failed.textContent).toContain('Provider returned an error');
    expect(t.status()).toBe('1 of 3 images ready; 2 failed');

    answer = {
      created: 0,
      images: [png(), png()].map((blob) => ({ blob, mediaType: 'image/png' })),
      usage: { cost: 0.02 },
      generationId: null,
    };
    $<HTMLButtonElement>('imagegen-retry').click();
    await vi.waitFor(() =>
      expect(t.zones.output.querySelectorAll('[data-testid="imagegen-result"]')).toHaveLength(3),
    );
    expect(calls[1]).toMatchObject({ prompt: 'A fox', n: 2 });
    expect(t.zones.output.querySelector('[data-testid="imagegen-failed"]')).toBeNull();
    const titles = [...t.zones.output.querySelectorAll('[data-testid="imagegen-result"] h4')].map(
      (heading) => heading.textContent,
    );
    expect(titles).toEqual(['Image 1', 'Image 2', 'Image 3']);
  });

  it('a retry that needs an action (locked keys) reaches the shell instead of being swallowed', async () => {
    const locked = new KeyLockedError();
    let attempt = 0;
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      attempt++;
      return Promise.reject(
        attempt === 1 ? new ApiError('Provider returned an error', 502) : locked,
      );
    };
    await mount({ images });
    vi.mocked(presentError).mockClear();
    $<HTMLTextAreaElement>('tool-prompt').value = 'A fox';
    $<HTMLTextAreaElement>('tool-prompt').dispatchEvent(new Event('input'));
    await t.runners[0]!.trigger();
    $<HTMLButtonElement>('imagegen-retry').click();
    await vi.waitFor(() => expect(attempt).toBe(2));
    await vi.waitFor(() => expect(t.runners[0]!.busy).toBe(false));
    expect(vi.mocked(presentError).mock.calls.map(([error]) => error)).toContain(locked);
    // Not marked as shown by the card: presentError opens the unlock dialog for it.
    expect(wasPresented(locked)).toBe(false);
  });

  it('offers an SVG result as PNG or a sanitized SVG: no Edit, no Use as reference', async () => {
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      return Promise.resolve({
        created: 0,
        images: [
          { blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }), mediaType: 'image/svg+xml' },
        ],
        usage: { cost: 0.01 },
        generationId: null,
      });
    };
    await mount({ images });
    $<HTMLTextAreaElement>('tool-prompt').value = 'A logo';
    $<HTMLTextAreaElement>('tool-prompt').dispatchEvent(new Event('input'));
    await t.runners[0]!.trigger();
    const card = t.zones.output.querySelector('[data-testid="imagegen-result"]')!;
    expect([...card.querySelectorAll('.dropdown-item')].map((item) => item.textContent)).toEqual([
      'PNG.png',
      'SVG.svg',
    ]);
    expect(card.querySelector('[data-testid="imagegen-vary"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="imagegen-edit"]')).toBeNull();
    expect(card.querySelector('[data-testid="imagegen-use-reference"]')).toBeNull();
  });

  it('prices references once per request that uploads them', async () => {
    const tool = await mount();
    tool.applyState({ prompt: 'A cat', settings: { count: 2 } });
    await t.ctx.ui.refreshEstimate();
    const without = t.estimate()!;
    tool.onFiles!([new File(['x'], 'ref.png', { type: 'image/png' })]);
    await vi.waitFor(() =>
      expect(t.zones.input.querySelectorAll('[data-testid="imagegen-reference"]')).toHaveLength(1),
    );
    await t.ctx.ui.refreshEstimate();
    // FLUX.2 klein makes one image per request: two requests, each uploading the reference ($0.001).
    expect(t.estimate()! - without).toBeCloseTo(2 * 0.001, 8);
  });

  it('a Retry from the error toast sends only the requests without images', async () => {
    let attempt = 0;
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      attempt++;
      if (attempt === 2) return Promise.reject(new ApiError('Not enough credits', 402));
      return Promise.resolve({
        created: 0,
        images: [{ blob: png(), mediaType: 'image/png' }],
        usage: { cost: 0.014 },
        generationId: null,
      });
    };
    const tool = await mount({ images });
    tool.applyState({ prompt: 'A fox', settings: { count: 2, seed: 10, seedLocked: true } });
    vi.mocked(presentError).mockClear();
    await t.runners[0]!.trigger();
    expect(calls.map((call) => call.seed)).toEqual([10, 11]);
    // The 402 stops the batch and reaches the shell, whose toast offers Retry.
    const [, options] = vi.mocked(presentError).mock.calls.at(-1)!;
    options!.retry!();
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    await vi.waitFor(() => expect(t.runners[0]!.busy).toBe(false));
    expect(calls[2]?.seed).toBe(11); // only the second request again; the first image is not paid twice
    expect(t.zones.output.querySelectorAll('[data-testid="imagegen-result"]')).toHaveLength(2);
  });

  it('names files after the prompt', () => {
    expect(stemFrom('A lighthouse, on a ROCKY coast at dusk!')).toBe('a-lighthouse-on-a-rocky');
    expect(stemFrom('   ')).toBe('image');
  });
});
