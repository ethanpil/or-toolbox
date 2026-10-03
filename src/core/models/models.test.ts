import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import videosFixture from '../../../tests/fixtures/openrouter/videos-models.json';
import imagesFixture from '../../../tests/fixtures/openrouter/images-models.json';
import type { RawModel, RawModelEndpoint } from '../api/types';
import { fakeCore, fakeSettings, linkedBuses } from '../api/test-fakes';
import { closeDbForTests, getDb } from '../storage/db';
import type { ApiClient, ModelsService, Settings, SettingsService } from '../types';
import { CATALOG_MAX_AGE_MS, KV_CATALOG, createModelsService, kvEndpoints } from './models';

const RAW = modelsFixture.data as unknown as RawModel[];
const DAY = CATALOG_MAX_AGE_MS;

interface Catalog {
  models: Mock<() => Promise<RawModel[]>>;
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

function service(
  catalog: Catalog,
  settings: SettingsService = fakeSettings(),
  bus = linkedBuses(1)[0],
): ModelsService {
  return createModelsService(
    fakeCore({ api: { catalog } as unknown as ApiClient, settings, ...(bus ? { bus } : {}) }),
    { now: () => clock },
  );
}

beforeEach(async () => {
  await closeDbForTests();
  globalThis.indexedDB = new IDBFactory();
  clock = 1_000_000;
});

afterEach(async () => {
  await closeDbForTests();
});

describe('catalog cache', () => {
  it('fetches once, normalises, stores {fetchedAt, models} in IndexedDB and announces it', async () => {
    const catalog = catalogApi();
    const [bus] = linkedBuses(1);
    const models = service(catalog, fakeSettings(), bus);
    const list = await models.list();
    expect(list).toHaveLength(RAW.length);
    expect(list[0]?.pricing.prompt).toBe(0.000002);
    await models.list();
    expect(catalog.models).toHaveBeenCalledTimes(1);
    expect(catalog.models).toHaveBeenCalledWith({ output_modalities: 'all' });
    const stored = await (await getDb()).get('kv', KV_CATALOG);
    expect(stored?.value).toEqual({ fetchedAt: clock, models: RAW });
    expect(bus?.events).toEqual([{ type: 'models-refreshed' }]);
    expect(models.lastRefreshed()).toBe(clock);
  });

  it('shares concurrent loads', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await Promise.all([models.list(), models.list(), models.get('typesafe/jev-1.13')]);
    expect(catalog.models).toHaveBeenCalledTimes(1);
  });

  it('serves a fresh IndexedDB copy to a new page without fetching', async () => {
    await service(catalogApi()).list();
    const catalog = catalogApi();
    clock += DAY - 1;
    const list = await service(catalog).list();
    expect(list).toHaveLength(RAW.length);
    expect(catalog.models).not.toHaveBeenCalled();
  });

  it('refreshes when older than 24 hours or on demand', async () => {
    const catalog = catalogApi();
    const models = service(catalog);
    await models.list();
    clock += DAY;
    await models.list();
    expect(catalog.models).toHaveBeenCalledTimes(2);
    await models.list({ refresh: true });
    expect(catalog.models).toHaveBeenCalledTimes(3);
  });

  it('works offline from a stale cache and fails without one', async () => {
    await service(catalogApi()).list();
    const offline = catalogApi();
    offline.models.mockRejectedValue(new TypeError('offline'));
    clock += 3 * DAY;
    const models = service(offline);
    expect(await models.list()).toHaveLength(RAW.length);
    expect(await models.list({ refresh: true })).toHaveLength(RAW.length);
    expect(models.lastRefreshed()).toBe(1_000_000);

    globalThis.indexedDB = new IDBFactory();
    await closeDbForTests();
    await expect(service(offline).list()).rejects.toThrow('offline');
  });

  it('reloads from IndexedDB when another tab refreshed', async () => {
    const [busA, busB] = linkedBuses(2);
    const catalogA = catalogApi();
    const catalogB = catalogApi();
    const tabA = service(catalogA, fakeSettings(), busA);
    const tabB = service(catalogB, fakeSettings(), busB);
    await tabA.list();
    await tabB.list();
    expect(catalogB.models).toHaveBeenCalledTimes(0);

    clock += 10;
    catalogA.models.mockResolvedValue(RAW.slice(0, 5));
    await tabA.list({ refresh: true });
    expect(await tabB.list()).toHaveLength(5);
    expect(catalogB.models).toHaveBeenCalledTimes(0);
    // Its own announcement does not make tab A reload.
    expect(await tabA.list()).toHaveLength(5);
  });
});

describe('queries', () => {
  it('gets by id and filters by capability, free-only aware', async () => {
    const settings = fakeSettings();
    const models = service(catalogApi(), settings);
    expect((await models.get('typesafe/jev-1.13'))?.capabilities).toEqual(['decisions']);
    expect(await models.get('nope/nope')).toBeUndefined();
    const tts = await models.forCapability('tts');
    expect(tts.length).toBeGreaterThan(2);
    settings.update((d) => {
      d.freeOnly = true;
    });
    expect((await models.forCapability('tts')).map((m) => m.id)).toEqual([
      'fish-audio/s2.1-pro-free:free',
    ]);
    expect(await models.forCapability('video')).toEqual([]);
  });

  it('checks free ids synchronously and exposes shipped defaults', () => {
    const models = service(catalogApi());
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
    const stored = await (await getDb()).get('kv', kvEndpoints('hexgrad/kokoro-82m'));
    expect((stored?.value as { endpoints: unknown[] }).endpoints).toHaveLength(2);
    await models.imageModels({ refresh: true });
    expect(catalog.imageModels).toHaveBeenCalledTimes(2);
  });
});

describe('resolve', () => {
  function withSettings(patch: (draft: Settings) => void): ModelsService {
    const settings = fakeSettings();
    settings.update(patch);
    return service(catalogApi(), settings);
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
    const models = service(catalogApi());
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

    const online = service(catalogApi());
    expect(
      await online.estimate({
        kind: 'tokens',
        model: 'nope/nope',
        promptTokens: 1,
        completionTokens: 1,
      }),
    ).toBeNull();
  });
});
