import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ImageResult, RawImageModel, RawModel } from '../../core/api/types';
import type * as Client from '../../core/api/client';
import type * as Media from '../../core/media/image';
import type * as Dialogs from '../../ui/feedback/dialogs';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { ApiClient } from '../../core/types';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { setup } from './tool';

// What a Stop attaches to the abort (the real attachment is private to the client), what the dialogs answer,
// and what the stand-in image functions should refuse.
const hoisted = vi.hoisted(() => ({
  partials: new WeakMap<object, unknown>(),
  confirm: vi.fn<(options: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  failSize: false,
  failLoad: false,
}));
vi.mock('../../core/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Client>()),
  partialImageResult: (error: unknown) =>
    typeof error === 'object' && error !== null ? (hoisted.partials.get(error) ?? null) : null,
}));
vi.mock('../../ui/feedback/dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof Dialogs>()),
  confirmDialog: hoisted.confirm,
}));

// jsdom cannot decode or draw: pictures are 64 x 32 stand-ins, drawing gives blank rasters of the asked size.
vi.mock('../../core/media/image', async (importOriginal) => ({
  ...(await importOriginal<typeof Media>()),
  loadImage: () =>
    hoisted.failLoad
      ? Promise.reject(new Error('cannot decode'))
      : Promise.resolve({ width: 64, height: 32, close: () => undefined }),
  imageSize: (image: { width: number; height: number }) => ({
    width: image.width,
    height: image.height,
  }),
  imageDataFrom: (_source: unknown, size: { width: number; height: number }) => ({
    ...size,
    data: new Uint8ClampedArray(size.width * size.height * 4),
  }),
  readImageSize: () =>
    hoisted.failSize
      ? Promise.reject(new Error('unreadable'))
      : Promise.resolve({ width: 64, height: 32 }),
  toBlob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })),
  toDataUrls: (items: readonly unknown[]) =>
    Promise.resolve(items.map(() => 'data:image/png;base64,REF')),
}));
vi.mock('./pixels', () => ({
  drawToRaster: (_source: unknown, width: number, height: number) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }),
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
  hoisted.failSize = false;
  hoisted.failLoad = false;
  hoisted.confirm.mockReset();
  hoisted.confirm.mockImplementation(() => Promise.resolve(true));
});
afterEach(async () => {
  await t.cleanup();
  document.querySelectorAll('[data-testid="toasts"] > *').forEach((node) => node.remove());
});

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

  it('M5: loading, versions and painting wait from the moment Edit is pressed, also during the budget question', async () => {
    const calls: ImageRequest[] = [];
    const images: ApiClient['images'] = (body) => {
      calls.push(body);
      return Promise.resolve(answer());
    };
    const tool = await mount({ images });
    await loadAndPaint(tool);
    // Over the per-run threshold: the shell asks, and the answer is not given yet.
    t.core.settings.update((draft) => {
      draft.budgets = { ...draft.budgets, mode: 'warn', perRunUsd: 0.001 };
    });
    let answerBudget: (accept: boolean) => void = () => undefined;
    const asked = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answerBudget = resolve;
        }),
    );
    t.core.runs.setConfirmHandler(asked);
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(true));
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(calls).toHaveLength(0);

    tool.onFiles!([picture('other.png')]);
    await vi.waitFor(() => expect(t.status()).toMatch(/^An edit is running/));
    expect($('editor-source-name').textContent).toBe('photo.png · 64 × 32');

    // Declined: nothing was sent, and the editor is free again.
    answerBudget(false);
    await running;
    expect(calls).toHaveLength(0);
    expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(false);
  });

  it('M5: a size that cannot be read does not lose the paid picture', async () => {
    const tool = await mount({ images: () => Promise.resolve(answer()) });
    await loadAndPaint(tool);
    hoisted.failSize = true;
    await t.runners[0]!.trigger();
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(2);
    expect($('editor-version-result')).not.toBeNull();
    const [record] = await t.core.history.query({ tool: 'image-editor' });
    expect(record?.status).toBe('ok');
  });

  it('M5: a version that cannot be drawn stays in the strip with its card, and the error is shown', async () => {
    const images: ApiClient['images'] = () => {
      // The answer arrives; from here no picture can be decoded.
      hoisted.failLoad = true;
      return Promise.resolve(answer());
    };
    const tool = await mount({ images });
    await loadAndPaint(tool);
    await t.runners[0]!.trigger();
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(2);
    expect($('editor-version-result')).not.toBeNull();
    expect(t.status()).toContain('is kept, but it could not be shown');
    expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(false);
  });

  it('M5: an answer with no picture says so instead of failing on a missing field', async () => {
    const empty = { ...answer(), images: [] };
    const tool = await mount({ images: () => Promise.resolve(empty) });
    await loadAndPaint(tool);
    await t.runners[0]!.trigger();
    const [record] = await t.core.history.query({ tool: 'image-editor' });
    expect(record?.status).toBe('error');
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(1);
  });

  it('M5: removing a version that was not downloaded asks first; an edit in flight blocks it', async () => {
    const tool = await mount({ images: () => Promise.resolve(answer()) });
    await loadAndPaint(tool);
    await t.runners[0]!.trigger();
    const remove = (): HTMLButtonElement =>
      $('editor-version-result').querySelector<HTMLButtonElement>('button[aria-label^="Remove "]')!;
    hoisted.confirm.mockImplementation(() => Promise.resolve(false));
    remove().click();
    await vi.waitFor(() => expect(hoisted.confirm).toHaveBeenCalledTimes(1));
    expect(hoisted.confirm.mock.calls[0]![0]).toMatchObject({ title: 'Remove the image?' });
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(2);

    hoisted.confirm.mockImplementation(() => Promise.resolve(true));
    remove().click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(1),
    );
  });

  it('A10: Stop keeps a picture that was already made as a version', async () => {
    const images: ApiClient['images'] = (_body, options) =>
      new Promise((_, reject) => {
        options.run.signal.addEventListener('abort', () => {
          const stopped = new DOMException('Stopped by the user.', 'AbortError');
          hoisted.partials.set(stopped, { ...answer() });
          reject(stopped);
        });
      });
    const tool = await mount({ images });
    await loadAndPaint(tool);
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(t.runners[0]!.busy).toBe(true));
    await vi.waitFor(() => expect($<HTMLInputElement>('editor-tool-brush').disabled).toBe(true));
    // Wait until the request is out: the stop handler is attached when the call starts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    t.runners[0]!.stop();
    await running;
    expect(document.querySelectorAll('[data-testid="editor-version-thumb"]')).toHaveLength(2);
    expect(t.core.results.pending()).toHaveLength(1);
    expect(t.status()).toBe('Stopped');
    const [record] = await t.core.history.query({ tool: 'image-editor' });
    expect(record?.status).toBe('aborted');
  });

  it('the soft-edge help follows the mode: Outpaint blends on the picture’s side of the seam', async () => {
    const tool = await mount();
    const help = () => $('editor-feather-help').textContent ?? '';
    expect(help()).toContain('inside the mask');
    tool.applyState({ prompt: '', settings: { mode: 'outpaint' } });
    expect(help()).toContain('edge of your picture blend into the new area');
    tool.applyState({ prompt: '', settings: { mode: 'whole' } });
    expect(help()).toContain('Only used by Inpaint and Outpaint');
  });

  it('shows the note about the mask only in modes that use one', async () => {
    const tool = await mount();
    expect($('editor-model-note').hidden).toBe(false);
    tool.applyState({ prompt: '', settings: { mode: 'whole' } });
    expect($('editor-model-note').hidden).toBe(true);
    tool.applyState({ prompt: '', settings: { mode: 'outpaint' } });
    expect($('editor-model-note').hidden).toBe(false);
  });
});
