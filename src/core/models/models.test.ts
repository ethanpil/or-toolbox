import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import videosFixture from '../../../tests/fixtures/openrouter/videos-models.json';
import imagesFixture from '../../../tests/fixtures/openrouter/images-models.json';
import type { RawModel, RawModelEndpoint } from '../api/types';
import { isolateChannels, testCore } from '../api/test-fakes';
import { closeDbForTests, getDb } from '../storage/db';
import { resetDb } from '../testing/state-fakes';
import type { ApiClient, BusEvent, CoreServices, ModelsService, Settings } from '../types';
import {
  CATALOG_MAX_AGE_MS,
  KV_CATALOG,
  REFRESH_FAILURE_BACKOFF_MS,
  createModelsService,
  kvEndpoints,
} from './models';

const RAW = modelsFixture.data as unknown as RawModel[];
const DAY = CATALOG_MAX_AGE_MS;

interface Catalog {
  models: Mock<(params?: unknown, opts?: { retry?: boolean }) => Promise<RawModel[]>>;
  modelEndpoints: Mock<(id: string) => Promise<RawModelEndpoint[]>>;
  imageModels: Mock;
  videoModels: Mock;
}

let clock = 1_000_000;

function catalogApi(): Catalog {
  return {
    models: vi.fn(() => Promise.resolve(RAW)),
    modelEndpoints: vi.fn(() =>
      Promise.resolve([
        { name: 'a', provider_name: 'A', pricing: { prompt: '0.00000062', completion: '0' } },
        { name: 'b', provider_name: 'B', pricing: { prompt: '0.000004', completion: '0' } },
      ]),
    ),
    imageModels: vi.fn(() => Promise.resolve(imagesFixture.data)),
    videoModels: vi.fn(() => Promise.resolve(videosFixture.data)),
  };
}

interface Tab {
  models: ModelsService;
  core: CoreServices;
  /** models-refreshed events this tab received. */
  events: BusEvent[];
}

/** One tab with the real bus and settings; tabs in one test talk to each other. */
function tab(catalog: Catalog = catalogApi()): Tab {
  const core = testCore({ api: { catalog } as unknown as ApiClient });
  const events: BusEvent[] = [];
  core.bus.on('models-refreshed', (event) => events.push(event));
  const models = createModelsService(core, { now: () => clock });
  core.models = models;
  return { models, core, events };
}

const service = (catalog: Catalog = catalogApi()): ModelsService => tab(catalog).models;

async function storedCatalog(): Promise<unknown> {
  return (await (await getDb()).get('kv', KV_CATALOG))?.value;
}

beforeEach(async () => {
  isolateChannels();
  localStorage.clear();
  await resetDb();
  clock = 1_000_000;
});

afterEach(async () => {
  await closeDbForTests();
});

describe('catalog cache', () => {
  it('fetches once, normalises, stores {fetchedAt, models} in IndexedDB and announces it', async () => {
    const catalog = catalogApi();
    const { models, events } = tab(catalog);
    const list = await models.list();
    expect(list).toHaveLength(RAW.length);
    expect(list[0]?.pricing.prompt).toBe(0.000002);
    await models.list();
    expect(catalog.models).toHaveBeenCalledTimes(1);
    expect(catalog.models).toHaveBeenCalledWith({ output_modalities: 'all' }, { retry: true });
    await vi.waitFor(async () =>
      expect(await storedCatalog()).toEqual({ fetchedAt: clock, models: RAW }),
    );
    await vi.waitFor(() => expect(events).toEqual([{ type: 'models-refreshed' }]));
    expect(models.lastRefreshed()).toBe(clock);
  });

  it('shares concurrent loads', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await Promise.all([models.list(), models.list(), models.get('typesafe/jev-1.13')]);
    expect(catalog.models).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh IndexedDB copy to a new page without fetching', async () => {
    await service().list();
    await vi.waitFor(async () => expect(await storedCatalog()).toBeDefined());
    const catalog = catalogApi();
    clock += DAY - 1;
    const list = await service(catalog).list();
    expect(list).toHaveLength(RAW.length);
    expect(catalog.models).not.toHaveBeenCalled();
  });

  it('returns a stale copy at once and refreshes it in the background, once, without retries', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await models.list();
    clock += DAY;
    let release: (value: RawModel[]) => void = () => undefined;
    catalog.models.mockImplementationOnce(
      () => new Promise<RawModel[]>((resolve) => (release = resolve)),
    );
    // The refresh hangs, yet the stale copy comes back immediately (twice, one refresh).
    expect(await models.list()).toHaveLength(RAW.length);
    expect(await models.list()).toHaveLength(RAW.length);
    expect(catalog.models).toHaveBeenCalledTimes(2);
    expect(catalog.models).toHaveBeenLastCalledWith({ output_modalities: 'all' }, { retry: false });
    release(RAW.slice(0, 3));
    await vi.waitFor(async () => expect(await models.list()).toHaveLength(3));
    expect(models.lastRefreshed()).toBe(clock);

    await models.list({ refresh: true });
    expect(catalog.models).toHaveBeenCalledTimes(3);
  });

  it('remembers a failed background refresh for a few minutes', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await models.list();
    clock += DAY;
    catalog.models.mockRejectedValue(new TypeError('offline'));
    await models.list();
    await vi.waitFor(() => expect(catalog.models).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await models.list();
    await models.list();
    expect(catalog.models).toHaveBeenCalledTimes(2);
    clock += REFRESH_FAILURE_BACKOFF_MS;
    await models.list();
    expect(catalog.models).toHaveBeenCalledTimes(3);
  });

  it('works offline from a stale cache and fails fast without one', async () => {
    await service().list();
    await vi.waitFor(async () => expect(await storedCatalog()).toBeDefined());
    const offline = catalogApi();
    offline.models.mockRejectedValue(new TypeError('offline'));
    clock += 3 * DAY;
    const models = service(offline);
    expect(await models.list()).toHaveLength(RAW.length);
    expect(await models.list({ refresh: true })).toHaveLength(RAW.length);
    expect(models.lastRefreshed()).toBe(1_000_000);

    await resetDb();
    const empty = catalogApi();
    empty.models.mockRejectedValue(new TypeError('offline'));
    const fresh = service(empty);
    await expect(fresh.list()).rejects.toThrow('offline');
    await expect(fresh.list()).rejects.toThrow('offline');
    expect(empty.models).toHaveBeenCalledTimes(1);
    await expect(fresh.list({ refresh: true })).rejects.toThrow('offline');
    expect(empty.models).toHaveBeenCalledTimes(2);
  });

  it('reloads from IndexedDB when another tab refreshed', async () => {
    const catalogA = catalogApi();
    const catalogB = catalogApi();
    const tabA = tab(catalogA);
    const tabB = tab(catalogB);
    await tabA.models.list();
    await vi.waitFor(async () => expect(await storedCatalog()).toBeDefined());
    await tabB.models.list();
    expect(catalogB.models).toHaveBeenCalledTimes(0);

    clock += 10;
    catalogA.models.mockResolvedValue(RAW.slice(0, 5));
    await tabA.models.list({ refresh: true });
    await vi.waitFor(() => expect(tabB.events.length).toBeGreaterThanOrEqual(2));
    expect(await tabB.models.list()).toHaveLength(5);
    expect(catalogB.models).toHaveBeenCalledTimes(0);
    // Its own announcement does not make tab A reload.
    expect(await tabA.models.list()).toHaveLength(5);
  });

  it('forgets everything in memory on a data reset from any tab', async () => {
    const catalog = catalogApi();
    const tabA = tab(catalog);
    const tabB = tab();
    await tabA.models.list();
    await tabA.models.endpoints('hexgrad/kokoro-82m');
    await vi.waitFor(async () => expect(await storedCatalog()).toBeDefined());
    await resetDb(); // what "Reset everything" does to IndexedDB
    tabB.core.bus.emit({ type: 'data-reset' });
    await vi.waitFor(() => expect(tabA.models.lastRefreshed()).toBeNull());
    await tabA.models.list();
    await tabA.models.endpoints('hexgrad/kokoro-82m');
    expect(catalog.models).toHaveBeenCalledTimes(2);
    expect(catalog.modelEndpoints).toHaveBeenCalledTimes(2);
  });
});

describe('queries', () => {
  it('gets by id and filters by capability, free-only aware', async () => {
    const { models, core } = tab();
    expect((await models.get('typesafe/jev-1.13'))?.capabilities).toEqual(['decisions']);
    expect(await models.get('nope/nope')).toBeUndefined();
    const tts = await models.forCapability('tts');
    expect(tts.length).toBeGreaterThan(2);
    core.settings.update((d) => {
      d.freeOnly = true;
    });
    expect((await models.forCapability('tts')).map((m) => m.id)).toEqual([
      'fish-audio/s2.1-pro-free:free',
    ]);
    expect(await models.forCapability('video')).toEqual([]);
  });

  it('checks free ids synchronously and exposes shipped defaults', () => {
    const models = service();
    expect(models.isFree('x/y:free')).toBe(true);
    expect(models.isFree('openrouter/free')).toBe(true);
    expect(models.isFree('google/veo-3.1')).toBe(false);
    expect(models.shippedDefault('video')).toEqual({ paid: 'x-ai/grok-imagine-video', free: null });
    expect(models.shippedDefault('decisions').free).toBe('inception/mercury-decide:free');
  });

  it('caches image models, video models and per-model endpoints', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await models.imageModels();
    await models.imageModels();
    await models.videoModels();
    await models.videoModels();
    await models.endpoints('hexgrad/kokoro-82m');
    await models.endpoints('hexgrad/kokoro-82m');
    expect(catalog.imageModels).toHaveBeenCalledTimes(1);
    expect(catalog.videoModels).toHaveBeenCalledTimes(1);
    expect(catalog.modelEndpoints).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const stored = await (await getDb()).get('kv', kvEndpoints('hexgrad/kokoro-82m'));
      expect((stored?.value as { endpoints: unknown[] } | undefined)?.endpoints).toHaveLength(2);
    });
    await models.imageModels({ refresh: true });
    expect(catalog.imageModels).toHaveBeenCalledTimes(2);
  });
});

describe('resolve', () => {
  function withSettings(patch: (draft: Settings) => void): ModelsService {
    const { models, core } = tab();
    core.settings.update(patch);
    return models;
  }

  it('cascades run override → tool binding → capability default → shipped default', () => {
    const models = withSettings((d) => {
      d.tools.chat = { model: 'anthropic/claude-sonnet-5.5' };
      d.defaultModels.text = 'openai/gpt-6.1-sol';
    });
    expect(models.resolve('chat', 'text', 'x/run-model')).toEqual({
      model: 'x/run-model',
      source: 'run',
      note: null,
    });
    expect(models.resolve('chat', 'text')).toMatchObject({
      model: 'anthropic/claude-sonnet-5.5',
      source: 'tool',
    });
    expect(models.resolve('ocr', 'text')).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      source: 'capability',
    });
    expect(models.resolve('ocr', 'vision')).toEqual({
      model: 'google/gemini-3.1-flash-lite',
      source: 'shipped',
      note: null,
    });
  });

  it('applies the tool binding and the run override only to the tool’s primary capability', () => {
    // Chat's primary capability is text; pinning a text-only model must not take over image input (vision).
    const models = withSettings((d) => {
      d.tools.chat = { model: 'x/text-only' };
      d.defaultModels.vision = 'google/gemini-3.1-flash-lite';
    });
    expect(models.resolve('chat', 'text')).toMatchObject({ model: 'x/text-only', source: 'tool' });
    expect(models.resolve('chat', 'vision')).toMatchObject({
      model: 'google/gemini-3.1-flash-lite',
      source: 'capability',
    });
    expect(models.resolve('chat', 'vision', 'x/run-model')).toMatchObject({
      model: 'google/gemini-3.1-flash-lite',
      source: 'capability',
    });
    expect(models.resolve('chat', 'text', 'x/run-model')).toMatchObject({
      model: 'x/run-model',
      source: 'run',
    });
  });

  it('in free-only mode keeps free choices and swaps paid ones, with a note', () => {
    const models = withSettings((d) => {
      d.freeOnly = true;
      d.tools.chat = { model: 'nvidia/nemotron-3-super-120b-a12b:free' };
    });
    expect(models.resolve('chat', 'text')).toEqual({
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      source: 'tool',
      note: null,
    });
    expect(models.resolve('chat', 'text', 'openai/gpt-6.1-sol')).toEqual({
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
      source: 'tool',
      note: 'Free-only mode: using nvidia/nemotron-3-super-120b-a12b:free instead of openai/gpt-6.1-sol.',
    });
    expect(models.resolve('text-to-speech', 'tts')).toEqual({
      model: 'fish-audio/s2.1-pro-free:free',
      source: 'shipped',
      note: 'Free-only mode: using fish-audio/s2.1-pro-free:free instead of hexgrad/kokoro-82m.',
    });
  });

  it('blocks capabilities that have no free model', () => {
    const models = withSettings((d) => {
      d.freeOnly = true;
    });
    expect(models.resolve('video-studio', 'video')).toEqual({
      model: null,
      source: 'none',
      note: 'No free video model exists; free-only mode blocks this tool.',
    });
    expect(models.resolve('music-generation', 'music').note).toBe(
      'No free music model exists; free-only mode blocks this tool.',
    );
  });
});

describe('estimate', () => {
  it('covers each kind from the cached data', async () => {
    const models = service();
    expect(
      await models.estimate({
        kind: 'tokens',
        model: 'openai/gpt-6.1-sol',
        promptTokens: 1000,
        completionTokens: 0,
      }),
    ).toBeCloseTo(0.002, 10);
    expect(
      await models.estimate({ kind: 'decision', model: 'typesafe/jev-1.13', inputTokens: 476 }),
    ).toBeCloseTo(0.000019992, 12);
    expect(
      await models.estimate({ kind: 'speech', model: 'hexgrad/kokoro-82m', characters: 44 }),
    ).toBeCloseTo(0.000176, 10);
    expect(
      await models.estimate({
        kind: 'transcription',
        model: 'microsoft/mai-transcribe-2',
        seconds: 3.17,
      }),
    ).toBeCloseTo(0.000111, 6);
    expect(
      await models.estimate({ kind: 'image', model: 'bytedance-seed/seedream-4.5', images: 1 }),
    ).toBeCloseTo(0.04, 6);
    expect(
      await models.estimate({
        kind: 'video',
        model: 'x-ai/grok-imagine-video',
        seconds: 1,
        resolution: '480p',
      }),
    ).toBeCloseTo(0.05, 6);
    expect(await models.estimate({ kind: 'music', model: 'google/lyria-3-clip-preview' })).toBe(
      0.04,
    );
  });

  it('is zero for free models and null when unknown or offline', async () => {
    const offline = catalogApi();
    offline.models.mockRejectedValue(new TypeError('offline'));
    offline.videoModels.mockRejectedValue(new TypeError('offline'));
    offline.modelEndpoints.mockRejectedValue(new TypeError('offline'));
    const models = service(offline);
    expect(
      await models.estimate({
        kind: 'tokens',
        model: 'a/b:free',
        promptTokens: 9,
        completionTokens: 9,
      }),
    ).toBe(0);
    expect(
      await models.estimate({ kind: 'tokens', model: 'a/b', promptTokens: 9, completionTokens: 9 }),
    ).toBeNull();
    expect(
      await models.estimate({ kind: 'video', model: 'x-ai/grok-imagine-video', seconds: 1 }),
    ).toBeNull();
    expect(
      await models.estimate({ kind: 'speech', model: 'hexgrad/kokoro-82m', characters: 9 }),
    ).toBeNull();

    const online = service();
    expect(
      await online.estimate({
        kind: 'tokens',
        model: 'nope/nope',
        promptTokens: 1,
        completionTokens: 1,
      }),
    ).toBeNull();
  });

  it('never estimates TTS from the cheapest catalog price when endpoints are unavailable', async () => {
    const catalog = catalogApi();
    catalog.modelEndpoints.mockRejectedValue(new TypeError('offline'));
    const models = service(catalog);
    await models.list(); // the catalog itself is available and lists a Kokoro price
    expect(
      await models.estimate({ kind: 'speech', model: 'hexgrad/kokoro-82m', characters: 44 }),
    ).toBeNull();
  });
});
