import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImageRequest, ImageResult, RawImageModel, RawModel } from '../../core/api/types';
import { ApiError } from '../../core/errors';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import type { CallOptions } from '../../core/types';
import type * as ReferencePicker from '../../ui/components/reference-picker';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import { getTool } from '../registry';
import { buildInstruction } from './request';
import { setup } from './tool';

/**
 * jsdom has no canvas: decoding and encoding are replaced. The model's "answer" is a Blob whose text says what
 * it shows, decoded here into a 160 x 120 edit-model picture: a navy product with a white label on an
 * off-white background between 241 and 247 (partly below the 245 threshold), or the same product cut off by
 * the left edge. The pipeline itself (`isolateImage`, which runs on the page without workers) is the real one.
 */
/**
 * Test controls for the replaced raster I/O: `flaws` is what decoding an exported JPG's border finds, `hold`
 * keeps decoding waiting until it resolves, `decoded` counts decodes.
 */
const io = vi.hoisted(() => ({ flaws: 0, hold: null as Promise<void> | null, decoded: 0 }));
const announced = vi.hoisted(() => [] as string[]);
vi.mock('../../ui/feedback/announce', () => ({
  announce: (text: string) => {
    announced.push(text);
  },
}));
// jsdom cannot decode images: a thumbnail is the image itself.
vi.mock('../../ui/components/reference-picker', async (original) => ({
  ...(await original<typeof ReferencePicker>()),
  imageThumbnail: (blob: Blob) => Promise.resolve(blob),
}));
vi.mock('./raster-io', async () => {
  const { createRaster } = await import('../../core/media/image');
  const picture = (cut: boolean) => {
    const img = createRaster(160, 120, '#ffffff');
    for (let y = 0; y < 120; y++) {
      for (let x = 0; x < 160; x++) {
        const value = 241 + ((x * 7 + y * 13) % 7);
        img.data.set([value, value, value, 255], (y * 160 + x) * 4);
      }
    }
    const fill = (x0: number, y0: number, w: number, h: number, rgb: number[]) => {
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) img.data.set([...rgb, 255], (y * 160 + x) * 4);
      }
    };
    const left = cut ? 0 : 50;
    fill(left, 30, 60, 50, [20, 30, 90]);
    fill(left + 10, 40, 40, 30, [250, 250, 250]);
    return img;
  };
  return {
    referenceDataUrl: (file: File) => Promise.resolve(`data:${file.type};base64,${file.name}`),
    decodeRaster: async (blob: Blob) => {
      io.decoded += 1;
      if (io.hold) await io.hold;
      return picture((await blob.text()).startsWith('cut'));
    },
    encodeRaster: (raster: { width: number; height: number }, format: string) =>
      Promise.resolve(
        new Blob([`${format}:${raster.width}x${raster.height}`], {
          type: format === 'png' ? 'image/png' : 'image/jpeg',
        }),
      ),
    encodedBorderFlaws: () => Promise.resolve(io.flaws),
    samplePhoto: () => Promise.reject(new Error('no canvas in jsdom')),
  };
});

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const OTHER = 'google/gemini-3.1-flash-image';
/** $0.014 per megapixel: per image token. */
const KLEIN_TOKEN_PRICE = 0.000003418;

const catalogModel = (id: string, price: number): RawModel => ({
  id,
  name: id,
  created: 1,
  description: '',
  context_length: null,
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] },
  pricing: { prompt: '0', completion: '0', image_output: String(price) },
});
const imageModel = (id: string, supported: Record<string, unknown>): RawImageModel => ({
  id,
  name: id,
  supported_parameters: supported,
});
const IMAGE_MODELS = [
  imageModel(KLEIN, {
    output_format: { type: 'enum', values: ['png', 'jpeg'] },
    n: { type: 'range', min: 1, max: 1 },
    input_references: { type: 'range', min: 0, max: 4 },
  }),
  imageModel(OTHER, { input_references: { type: 'range', min: 0, max: 14 } }),
  imageModel('meta/muse-image', {}),
];

type Images = (body: ImageRequest, opts: CallOptions) => Promise<ImageResult>;

const answer = (text: string): ImageResult => ({
  created: 0,
  images: [{ blob: new Blob([text], { type: 'image/png' }), mediaType: 'image/png' }],
  usage: { cost: 0.014 },
  generationId: null,
});

/** The photo a request is for, from its (mocked) data URL. */
const photoOf = (body: ImageRequest): string =>
  body.input_references?.[0]?.image_url.url.split(',')[1] ?? '';

const okImages = vi.fn<Images>((body) => Promise.resolve(answer(`edited:${photoOf(body)}`)));

const context = (images: Images = okImages): ToolTestContext =>
  createToolTestContext(getTool('isolated-image'), {
    api: {
      images: images,
      catalog: {
        models: () =>
          Promise.resolve([
            catalogModel(KLEIN, KLEIN_TOKEN_PRICE),
            catalogModel(OTHER, 0.00003),
            catalogModel('meta/muse-image', 0.00001),
          ]),
        modelEndpoints: () => Promise.resolve([]),
        imageModels: () => Promise.resolve(IMAGE_MODELS),
        videoModels: () => Promise.resolve([]),
      },
    },
  });

const photo = (name: string): File =>
  new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });

const $ = <E extends HTMLElement = HTMLElement>(root: ParentNode, testId: string): E | null =>
  root.querySelector<E>(`[data-testid="${testId}"]`);
const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const cards = (t: ToolTestContext) => $$(t.zones.output, 'iso-card');
const cardFor = (t: ToolTestContext, name: string) =>
  cards(t).find((card) => card.textContent?.includes(name));

/** Waits until no result is being made outside a run. */
async function settled(t: ToolTestContext): Promise<void> {
  await vi.waitFor(
    () => expect(cards(t).filter((card) => card.dataset['busy'] === 'true')).toEqual([]),
    { timeout: 10_000 },
  );
}

let t: ToolTestContext | null = null;
let urls = 0;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  okImages.mockClear();
  io.flaws = 0;
  io.hold = null;
  io.decoded = 0;
  announced.length = 0;
  urls = 0;
  URL.createObjectURL = vi.fn(() => `blob:test-${++urls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('Isolated image tool', { timeout: 30_000 }, () => {
  it('is promptless, and round-trips its settings, ignoring what it does not know', async () => {
    t = context();
    const tool = await t.mount(setup);
    expect(tool.promptless).toBe(true);
    expect($(t.zones.input, 'tool-prompt')).toBeNull();
    const state = {
      prompt: '',
      settings: {
        size: 1500,
        margin: 0.12,
        whiteThreshold: 240,
        sharpen: false,
        sharpenAmount: 1.5,
        shadow: true,
        format: 'png',
        jpegQuality: 80,
        filenamePattern: '{n:3}-{name}.{ext}',
        sendSize: 1536,
        concurrency: 3,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);
    // A text from an older snapshot is ignored: the instruction is fixed.
    tool.applyState({
      prompt: 'Keep the table',
      settings: { size: 'huge', margin: 2, other: true },
    });
    expect(tool.getState()).toEqual(state);
    // The drawer shows the restored values.
    expect($<HTMLSelectElement>(t.zones.drawer, 'iso-size')?.value).toBe('1500');
    expect($<HTMLInputElement>(t.zones.drawer, 'iso-margin-setting')?.value).toBe('12');
    expect($<HTMLInputElement>(t.zones.drawer, 'iso-quality')?.disabled).toBe(true);
    expect($(t.zones.drawer, 'iso-pattern-example')?.textContent).toBe('001-shoe.png');
  });

  it('estimates one edit per photo still to isolate', async () => {
    t = context();
    const tool = await t.mount(setup);
    expect(t.estimate()).toBeNull();
    tool.onFiles?.([photo('a.png'), photo('b.png'), photo('c.png')]);
    const perPhoto = 4175 * KLEIN_TOKEN_PRICE;
    await vi.waitFor(() => expect(t?.estimate()).toBeCloseTo(3 * perPhoto, 8));
    expect($(t.zones.input, 'iso-count')?.textContent).toBe('3 photos · ≈ $0.043');
    expect(await tool.estimate?.(KLEIN)).toBeCloseTo(3 * perPhoto, 8);
  });

  it('isolates a batch: one edit request per photo, results on white that pass the QA, History text', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png'), photo('c.png')]);
    await t.runners[0]!.trigger();

    expect(okImages).toHaveBeenCalledTimes(3);
    const body = okImages.mock.calls[0]![0];
    expect(body).toMatchObject({ model: KLEIN, n: 1, output_format: 'png' });
    expect(body.prompt).toBe(buildInstruction({ shadow: false }));
    expect(body.input_references).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,a.png' } },
    ]);

    expect(cards(t).map((card) => [card.dataset['phase'], card.dataset['qa']])).toEqual([
      ['done', 'pass'],
      ['done', 'pass'],
      ['done', 'pass'],
    ]);
    expect(t.status()).toBe('Done · 3 photos · 3 passed QA');
    expect($(t.zones.output, 'iso-summary')?.textContent).toBe('3 of 3 results passed QA');
    // Each result is 500 x 500 JPG, registered for the leave guard under the file name pattern.
    const pending = t.core.results.pending();
    expect(pending.map((result) => result.name)).toEqual([
      'a-white.jpg',
      'b-white.jpg',
      'c-white.jpg',
    ]);
    expect(await pending[0]!.blob.text()).toBe('jpg:500x500');
    // History keeps the settings and one QA line per photo, no pixels.
    const [record] = await t.core.history.query({ tool: 'isolated-image' });
    expect(record?.status).toBe('ok');
    expect(record?.output).toBe('a.png: QA passed\nb.png: QA passed\nc.png: QA passed');
    expect(record?.settings).toMatchObject({ size: 500, format: 'jpg' });
    expect(record?.prompt).toBe('');
    // Each result is a framework image card: the download as it is, Send to…, this tool's actions, Remove.
    const first = cards(t)[0]!;
    expect($(first, 'iso-result')).not.toBeNull();
    expect($(first, 'iso-download')?.textContent).toContain('.jpg');
    expect($(first, 'iso-send')).not.toBeNull();
    expect($(first, 'iso-review')).not.toBeNull();
    // Nothing is left to isolate: a second press sends nothing.
    await t.runners[0]!.trigger();
    expect(okImages).toHaveBeenCalledTimes(3);
    expect(t.status()).toContain('Every photo has a result');
  });

  it('reports a failed QA with its reason', async () => {
    t = context(() => Promise.resolve(answer('cut')));
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('cut.png')]);
    await t.runners[0]!.trigger();
    const card = cardFor(t, 'cut.png')!;
    expect(card.dataset['qa']).toBe('fail');
    expect($(card, 'iso-qa-reasons')?.textContent).toBe(
      'The product reaches the left edge of the edited photo: it may be cut off.',
    );
    const [record] = await t.core.history.query({ tool: 'isolated-image' });
    expect(record?.output).toBe(
      'cut.png: QA failed: The product reaches the left edge of the edited photo: it may be cut off.',
    );
  });

  it('retries one failed photo on its own, as a new run', async () => {
    let failB = true;
    const images = vi.fn<Images>((body) => {
      if (photoOf(body) === 'b.png' && failB) {
        failB = false;
        return Promise.reject(new ApiError('Mocked error 502', 502));
      }
      return Promise.resolve(answer(`edited:${photoOf(body)}`));
    });
    t = context(images);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png'), photo('c.png')]);
    await t.runners[0]!.trigger();
    const failed = cardFor(t, 'b.png')!;
    expect(failed.dataset['phase']).toBe('failed');
    expect($(failed, 'iso-error')?.textContent).toBe('Mocked error 502');
    // The run's last status names what went wrong.
    expect(t.status()).toBe(
      'Done · 2 of 3 photos; 1 failed · 2 passed QA · b.png: Mocked error 502',
    );

    $<HTMLButtonElement>(failed, 'iso-retry')!.click();
    await vi.waitFor(() => expect(cardFor(t!, 'b.png')?.dataset['qa']).toBe('pass'));
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    expect(images).toHaveBeenCalledTimes(4);
    expect(photoOf(images.mock.calls[3]![0])).toBe('b.png');
    const runs = await t.core.history.query({ tool: 'isolated-image' });
    expect(runs.map((run) => run.title)).toEqual(['Retry: b.png', 'a.png and 2 more photos']);
  });

  it('retries a photo with another model, booking that model', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png')]);
    await t.runners[0]!.trigger();
    const key = cardFor(t, 'a.png')!.dataset['key']!;
    const first = t.core.results.pending()[0]!;
    await t.runners[0]!.trigger({ keys: [key], model: OTHER });
    expect(okImages).toHaveBeenCalledTimes(2);
    // Gemini takes neither n nor output_format: they are not sent.
    const retried = okImages.mock.calls[1]![0];
    expect(retried.model).toBe(OTHER);
    expect('n' in retried || 'output_format' in retried).toBe(false);
    const [latest] = await t.core.history.query({ tool: 'isolated-image' });
    expect(latest?.model).toBe(OTHER);
    // The new result replaces the old one.
    expect(t.core.results.pending()).toHaveLength(1);
    expect(t.core.results.pending()[0]!.id).not.toBe(first.id);
  });

  it('refuses a model that cannot edit a photo before sending anything', async () => {
    t = createToolTestContext(getTool('isolated-image'), {
      modelOverride: 'meta/muse-image',
      api: {
        images: okImages,
        catalog: {
          models: () => Promise.resolve([catalogModel('meta/muse-image', 0.00001)]),
          modelEndpoints: () => Promise.resolve([]),
          imageModels: () => Promise.resolve(IMAGE_MODELS),
          videoModels: () => Promise.resolve([]),
        },
      },
    });
    const tool = await t.mount(setup);
    tool.onFiles?.([photo('a.png')]);
    await t.runners[0]!.trigger();
    expect(okImages).not.toHaveBeenCalled();
    expect(await t.core.history.query({ tool: 'isolated-image' })).toEqual([]);
    expect(cards(t)).toHaveLength(0);
  });

  it('re-makes one result from the review margin and threshold without a request', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png')]);
    await t.runners[0]!.trigger();
    const before = t.core.results.pending().map((result) => result.id);

    $<HTMLButtonElement>(cardFor(t, 'a.png')!, 'iso-review')!.click();
    const detail = $(t.zones.output, 'iso-detail')!;
    expect(detail.hidden).toBe(false);
    expect($(detail, 'iso-qa')?.textContent).toContain('QA passed');
    // The background (241-247) was darker than 245: the threshold went lower, and the review says so.
    const automatic = Number(detail.dataset['threshold']);
    expect(automatic).toBeLessThan(241);
    expect($(detail, 'iso-threshold-value')?.textContent).toBe(`${automatic} (automatic)`);
    expect($(detail, 'iso-qa')?.textContent).toContain(`Filled from ${automatic} instead of 245`);
    expect(detail.dataset['margin']).toBe('0.08');

    const margin = $<HTMLInputElement>(detail, 'iso-margin')!;
    margin.value = '12';
    margin.dispatchEvent(new Event('input'));
    expect($(detail, 'iso-margin-value')?.textContent).toBe('12%');
    await vi.waitFor(() => expect(detail.dataset['margin']).toBe('0.12'), { timeout: 10_000 });
    // Making it again is announced, politely.
    expect(announced).toContain('Updating a.png…');

    const threshold = $<HTMLInputElement>(detail, 'iso-threshold')!;
    threshold.value = '250';
    threshold.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(detail.dataset['threshold']).toBe('250'), { timeout: 10_000 });
    // At 250 the 241-247 background is content now: the box reaches every edge, and the QA says why.
    expect($(detail, 'iso-qa')?.textContent).toContain("The model's background is not white");
    await vi.waitFor(() =>
      expect(announced).toContainEqual(expect.stringMatching(/^a\.png: QA failed\. The model's/)),
    );
    $<HTMLButtonElement>(detail, 'iso-threshold-reset')!.click();
    await vi.waitFor(() => expect(detail.dataset['threshold']).toBe(String(automatic)), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(announced).toContain('a.png: QA passed.'));
    await settled(t);

    expect(okImages).toHaveBeenCalledTimes(2);
    const after = t.core.results.pending().map((result) => result.id);
    expect(after).toHaveLength(2);
    expect(after[0]).not.toBe(before[0]); // a.png's result was made again
    expect(after).toContain(before[1]); // b.png's was not touched

    $<HTMLButtonElement>(detail, 'iso-back')!.click();
    expect(detail.hidden).toBe(true);
    expect(document.activeElement).toBe($(cardFor(t, 'a.png')!, 'iso-review'));
  });

  it('applies output settings to every result without requests, and renames on a new pattern', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png')]);
    await t.runners[0]!.trigger();
    const [first] = t.core.results.pending();
    t.core.results.markDownloaded(first!.id);

    const pattern = $<HTMLInputElement>(t.zones.drawer, 'iso-pattern')!;
    pattern.value = 'product-{n:2}';
    pattern.dispatchEvent(new Event('change'));
    // Renamed (a new card each); the one already downloaded stays downloaded, so only the other is pending.
    await vi.waitFor(() =>
      expect(t!.core.results.pending().map((result) => result.name)).toEqual(['product-02.jpg']),
    );
    expect(cards(t)).toHaveLength(2);

    const format = $<HTMLSelectElement>(t.zones.drawer, 'iso-format')!;
    format.value = 'png';
    format.dispatchEvent(new Event('change'));
    await vi.waitFor(
      () =>
        expect(t!.core.results.pending().map((result) => result.name)).toEqual([
          'product-01.png',
          'product-02.png',
        ]),
      { timeout: 10_000 },
    );
    await settled(t);
    expect(await t.core.results.pending()[0]!.blob.text()).toBe('png:500x500');
    expect(okImages).toHaveBeenCalledTimes(2);
    expect(t.ctx.options.get()).toMatchObject({ format: 'png', filenamePattern: 'product-{n:2}' });
  });

  it('removes a photo and its result, asking first when the result was not downloaded', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.onFiles?.([photo('a.png'), photo('b.png')]);
    expect($$(t.zones.input, 'iso-photo')).toHaveLength(2);
    $<HTMLButtonElement>($$(t.zones.input, 'iso-photo')[0]!, 'iso-photo-remove')!.click();
    await vi.waitFor(() => expect($$(t!.zones.input, 'iso-photo')).toHaveLength(1));
    expect($(t.zones.input, 'iso-count')?.textContent).toMatch(/^1 photo/);
    expect(t.core.results.pending()).toHaveLength(0);
  });

  it('takes photos sent from another tool', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.onReceive?.([
      {
        kind: 'file',
        blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
        name: 'x.jpg',
      },
      { kind: 'text', text: 'not a photo' },
    ]);
    expect($$(t.zones.input, 'iso-photo').map((row) => row.textContent)).toEqual([
      expect.stringContaining('x.jpg'),
    ]);
  });

  it('keeps at least 24 px of white for JPG, and checks the border of the file it exports', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500, margin: 0.005 } });
    tool.onFiles?.([photo('a.png')]);
    await t.runners[0]!.trigger();
    expect(cardFor(t, 'a.png')?.dataset['qa']).toBe('pass');
    $<HTMLButtonElement>(cardFor(t, 'a.png')!, 'iso-review')!.click();
    const detail = $(t.zones.output, 'iso-detail')!;
    // 24 px of 500 is 4.8%: that, not the 0.5% asked for, is the margin of the JPG.
    expect(detail.dataset['margin']).toBe('0.048');
    expect($(detail, 'iso-margin-value')?.textContent).toBe('0.5% (JPG uses 4.8%)');
    // PNG is lossless: it gets the margin asked for.
    tool.applyState({ prompt: '', settings: { size: 500, margin: 0.005, format: 'png' } });
    await vi.waitFor(() => expect(detail.dataset['margin']).toBe('0.005'), { timeout: 10_000 });
    // A JPG whose decoded border is not pure white fails the QA, saying why.
    io.flaws = 3;
    tool.applyState({ prompt: '', settings: { size: 500, margin: 0.005, format: 'jpg' } });
    await vi.waitFor(() => expect(cardFor(t!, 'a.png')?.dataset['qa']).toBe('fail'), {
      timeout: 10_000,
    });
    expect($(detail, 'iso-qa')?.textContent).toContain(
      'After JPG compression 3 border pixels are not pure white',
    );
  });

  it('a replayed retry (the error toast’s Retry) sends only the photos still without a result', async () => {
    let refuse = true;
    const images = vi.fn<Images>((body) =>
      photoOf(body) === 'b.png' && refuse
        ? Promise.reject(new ApiError('Payment required', 402))
        : Promise.resolve(answer(`edited:${photoOf(body)}`)),
    );
    t = context(images);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500, concurrency: 1 } });
    tool.onFiles?.([photo('a.png'), photo('b.png'), photo('c.png')]);
    const keys = $$(t.zones.input, 'iso-photo').map((row) => row.dataset['key']!);
    // Toasts of earlier tests may still be on the page: this test's is the one that comes next.
    const toasts = (): HTMLButtonElement[] => [
      ...document.querySelectorAll<HTMLButtonElement>('[data-testid="toast-retry"]'),
    ];
    const before = toasts().length;
    // A retry of all three: a.png is made, then b.png's 402 stops the batch and the error toast offers Retry.
    await t.runners[0]!.trigger({ keys });
    expect(images.mock.calls.map(([body]) => photoOf(body))).toEqual(['a.png', 'b.png']);
    refuse = false;
    const retry = await vi.waitFor(() => {
      expect(toasts().length).toBe(before + 1);
      return toasts().at(-1)!;
    });
    retry.click(); // the runner replays the argument through replayArg (pendingOnly)
    await vi.waitFor(() =>
      expect(images.mock.calls.map(([body]) => photoOf(body))).toEqual([
        'a.png',
        'b.png',
        'b.png',
        'c.png',
      ]),
    );
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));
    // A new request for a photo that has a result ("Edit again") is still sent.
    await t.runners[0]!.trigger({ keys: [keys[0]!] });
    expect(images).toHaveBeenCalledTimes(5);
  });

  it('names a result that finishes after a new file name pattern with that pattern', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png')]);
    let release = (): void => undefined;
    io.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = t.runners[0]!.trigger();
    await vi.waitFor(() => expect(io.decoded).toBe(1));
    const pattern = $<HTMLInputElement>(t.zones.drawer, 'iso-pattern')!;
    pattern.value = 'renamed-{n}';
    pattern.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 500)); // past the rename's debounce
    release();
    await running;
    expect(t.core.results.pending().map((result) => result.name)).toEqual(['renamed-1.jpg']);
  });

  it('keeps the review in step: the margin follows the setting, Previous and Next the photos', async () => {
    t = context();
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png')]);
    await t.runners[0]!.trigger();
    $<HTMLButtonElement>(cardFor(t, 'a.png')!, 'iso-review')!.click();
    const detail = $(t.zones.output, 'iso-detail')!;
    const range = $<HTMLInputElement>(detail, 'iso-margin')!;
    expect(range.value).toBe('8');
    expect($<HTMLButtonElement>(detail, 'iso-previous')!.disabled).toBe(true);
    expect($<HTMLButtonElement>(detail, 'iso-next')!.disabled).toBe(false);
    // The global margin changes: the photo follows it, and so does its range.
    const setting = $<HTMLInputElement>(t.zones.drawer, 'iso-margin-setting')!;
    setting.value = '12';
    setting.dispatchEvent(new Event('change'));
    expect(range.value).toBe('12');
    expect(range.getAttribute('aria-valuetext')).toBe('12%');
    await vi.waitFor(() => expect(detail.dataset['margin']).toBe('0.12'), { timeout: 10_000 });
    // b.png goes: there is no next photo any more.
    for (const result of t.core.results.pending()) t.core.results.markDownloaded(result.id);
    $<HTMLButtonElement>($$(t.zones.input, 'iso-photo')[1]!, 'iso-photo-remove')!.click();
    await vi.waitFor(() => expect($<HTMLButtonElement>(detail, 'iso-next')!.disabled).toBe(true));
  });

  it('keeps focus when Retry failed or Remove all hides itself', async () => {
    let failB = true;
    const images = vi.fn<Images>((body) => {
      if (photoOf(body) === 'b.png' && failB) {
        failB = false;
        return Promise.reject(new ApiError('Mocked error 502', 502));
      }
      return Promise.resolve(answer(`edited:${photoOf(body)}`));
    });
    t = context(images);
    const tool = await t.mount(setup);
    tool.applyState({ prompt: '', settings: { size: 500 } });
    tool.onFiles?.([photo('a.png'), photo('b.png')]);
    await t.runners[0]!.trigger();
    const retryFailed = $<HTMLButtonElement>(t.zones.output, 'iso-retry-failed')!;
    expect(retryFailed.hidden).toBe(false);
    retryFailed.focus();
    retryFailed.click();
    await vi.waitFor(() => expect(retryFailed.hidden).toBe(true));
    expect([t.runners[0]!.stopButton, t.runners[0]!.button]).toContain(document.activeElement);
    await vi.waitFor(() => expect(t!.runners[0]!.busy).toBe(false));

    // Remove all, with nothing left to download: focus goes to the drop zone's button.
    for (const result of t.core.results.pending()) t.core.results.markDownloaded(result.id);
    const removeAll = $<HTMLButtonElement>(t.zones.input, 'iso-remove-all')!;
    removeAll.focus();
    removeAll.click();
    await vi.waitFor(() => expect($$(t!.zones.input, 'iso-photo')).toHaveLength(0));
    expect(removeAll.hidden).toBe(true);
    expect(document.activeElement).toBe($(t.zones.input, 'drop-zone-button'));
  });
});
