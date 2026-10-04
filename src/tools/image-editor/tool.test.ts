import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ImageResult, RawImageModel, RawModel } from '../../core/api/types';
import type * as Media from '../../core/media/image';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

// jsdom cannot decode or draw: pictures are 64 x 32 stand-ins, drawing gives blank rasters of the asked size.
vi.mock('../../core/media/image', async (importOriginal) => ({
  ...(await importOriginal<typeof Media>()),
  loadImage: () => Promise.resolve({ width: 64, height: 32, close: () => undefined }),
  imageSize: (image: { width: number; height: number }) => ({
    width: image.width,
    height: image.height,
  }),
  imageDataFrom: (_source: unknown, size: { width: number; height: number }) => ({
    ...size,
    data: new Uint8ClampedArray(size.width * size.height * 4),
  }),
  toBlob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
}));
vi.mock('./pixels', () => ({
  drawToRaster: (_source: unknown, width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }),
  referenceUrl: () => Promise.resolve('data:image/png;base64,REF'),
}));

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const SINGLE = 'test/one-reference';
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
  {
    id: SINGLE,
    name: 'One reference',
    supported_parameters: { input_references: { type: 'range', min: 0, max: 1 } },
  },
];

let t: ToolTestContext;
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;

async function mount(api: Partial<ApiClient> = {}, modelOverride: string | null = null) {
  t = createToolTestContext(getTool('image-editor'), {
    catalog,
    modelOverride,
    api: {
      ...api,
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

describe('Image editor runs', () => {
  const picture = (name: string) => new File(['x'], name, { type: 'image/png' });
  const answer = (): ImageResult => ({
    created: 0,
    images: [{ blob: new Blob(['y'], { type: 'image/png' }), mediaType: 'image/png' }],
    usage: { cost: 0.015 },
    generationId: null,
  });
  const loadAndPaint = async (tool: Awaited<ReturnType<typeof mount>>) => {
    tool.onFiles!([picture('photo.png')]);
    await vi.waitFor(() => expect($('editor-source-name').textContent).toBe('photo.png · 64 × 32'));
    $('editor-canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect($('editor-coverage').textContent).toMatch(/^Mask covers/);
    $<HTMLTextAreaElement>('tool-prompt').value = 'Make it blue';
  };

  it('holds the picture, the versions and the mask while an edit is in flight', async () => {
    const calls: ImageRequest[] = [];
    let respond: (result: ImageResult) => void = () => undefined;
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      return new Promise((resolve) => {
        respond = resolve;
      });
    };
    const tool = await mount({ images });
    await loadAndPaint(tool);
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    // Another picture, painting and the brush wait for the edit.
    tool.onFiles!([picture('other.png')]);
    await vi.waitFor(() => expect(t.status()).toMatch(/^An edit is running/));
    expect($('editor-source-name').textContent).toBe('photo.png · 64 × 32');
    expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(true);
    const painted = $('editor-coverage').textContent;
    expect($('editor-reason').textContent).toBe('Painting waits until the edit is back.');

    respond(answer());
    await running;
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(2);
    expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(false);
    // The mask sent for the edit is cleared afterwards (undoable); it was not changed meanwhile.
    expect($('editor-coverage').textContent).toBe('No mask painted yet.');
    expect(painted).toMatch(/^Mask covers/);
    expect(calls[0]?.input_references).toHaveLength(3);
  });

  it('names only the references actually sent (a one-reference model gets the marked picture)', async () => {
    const calls: ImageRequest[] = [];
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      return Promise.resolve(answer());
    };
    const tool = await mount({ images }, SINGLE);
    await loadAndPaint(tool);
    await t.runners[0]!.trigger();
    expect(calls[0]?.input_references).toHaveLength(1);
    expect(calls[0]?.prompt).toContain('tinted magenta');
    expect(calls[0]?.prompt).not.toMatch(/unmarked|without any marks|second reference/);
  });
});
