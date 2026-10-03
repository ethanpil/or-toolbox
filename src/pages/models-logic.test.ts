import { describe, expect, it } from 'vitest';
import modelsFixture from '../../tests/fixtures/openrouter/models.json';
import type { RawModel } from '../core/api/types';
import { normalizeModel } from '../core/models/normalize';
import type { ModelInfo, StatsRow } from '../core/types';
import { comparablePrice, modelPrice } from '../ui/model-price';
import {
  activeFilterCount,
  compareSections,
  expiryOf,
  hiddenByPriceLimit,
  modelFacets,
  type ModelFilters,
  type ModelSort,
  type ModelUsage,
  NO_FILTERS,
  parseQuery,
  priceLines,
  priceText,
  queryModels,
  usageByModel,
  usageText,
} from './models-logic';

const models = (modelsFixture.data as unknown as RawModel[]).map(normalizeModel);
const byId = new Map(models.map((model) => [model.id, model]));
const get = (id: string): ModelInfo => {
  const model = byId.get(id);
  if (!model) throw new Error(`fixture lacks ${id}`);
  return model;
};

const NONE = new Set<string>();
const run = (
  filters: Partial<ModelFilters> = {},
  sort: ModelSort = 'name',
  favourites: ReadonlySet<string> = NONE,
): string[] =>
  queryModels(models, { ...NO_FILTERS, ...filters }, sort, favourites).map((model) => model.id);

const group = (id: string): number | null => comparablePrice(modelPrice(get(id)))?.group ?? null;

describe('prices (the unit rules are tested in src/ui/model-price.test.ts)', () => {
  it('shows Free only for :free ids, whatever the price says', () => {
    expect(priceText(get('nvidia/nemotron-3-super-120b-a12b:free'))).toBe('Free');
    // Every video model prices at "0" and is not free.
    expect(priceText(get('google/veo-3.1'))).toBe('Billed per second of video');
  });

  it("shows the model's own unit, and extra lines for audio and image output", () => {
    expect(priceText(get('openai/gpt-6.1-sol'))).toBe('$2.00 in · $10.00 out per 1M tokens');
    expect(priceText(get('hexgrad/kokoro-82m'))).toBe('$0.62 per 1M characters');
    expect(priceText(get('openai/whisper-1'))).toBe('$0.36 per hour of audio');
    expect(priceText(get('black-forest-labs/flux.2-pro'))).toBe('≈ $0.031 per image');
    expect(priceLines(get('openai/gpt-audio')).extras).toEqual([
      'Audio: $32.00 in · $64.00 out per 1M tokens',
    ]);
    expect(priceLines(get('openrouter/auto'))).toEqual({ text: 'Price varies', extras: [] });
  });
});

describe('expiry', () => {
  const day = 86_400_000;
  const model = { expirationDate: '2026-10-31' };

  it('counts the expiration day itself as available', () => {
    const lastDay = Date.UTC(2026, 9, 31, 12);
    expect(expiryOf(model, lastDay)).toMatchObject({ expired: false, daysLeft: 1 });
    expect(expiryOf(model, Date.UTC(2026, 10, 1, 0, 0, 1))).toMatchObject({
      expired: true,
      daysLeft: 0,
    });
    expect(expiryOf(model, Date.UTC(2026, 9, 3))?.daysLeft).toBe(29);
    expect(expiryOf(model, Date.UTC(2026, 9, 3) - day)?.date).toBe('Oct 31, 2026');
  });

  it('is null without a (valid) date', () => {
    expect(expiryOf({ expirationDate: null })).toBeNull();
    expect(expiryOf({ expirationDate: 'soon' })).toBeNull();
    expect(expiryOf(get('openai/gpt-6.1-sol'))).toBeNull();
    expect(expiryOf(get('poolside/laguna-s-2.1:free'))?.date).toBe('Oct 31, 2026');
  });
});

describe('filters', () => {
  it('starts with every model, sorted by name', () => {
    expect(run()).toHaveLength(models.length);
  });

  it('filters by capability', () => {
    expect(run({ capability: 'video' })).toEqual(
      expect.arrayContaining(['google/veo-3.1', 'alibaba/wan-2.7']),
    );
    expect(run({ capability: 'video' })).toHaveLength(5);
    expect(run({ capability: 'music' }).sort()).toEqual([
      'google/lyria-3-clip-preview',
      'google/lyria-3-pro-preview',
    ]);
    expect(run({ capability: 'decisions' })).toContain('typesafe/jev-1.13');
    expect(run({ capability: 'vision' })).toContain('openai/gpt-6.1-sol');
    expect(run({ capability: 'vision' })).not.toContain('nvidia/nemotron-3-super-120b-a12b:free');
  });

  it('filters by input and output modality', () => {
    expect(run({ output: 'speech' })).toContain('hexgrad/kokoro-82m');
    expect(run({ input: 'audio', output: 'transcription' })).toContain('openai/whisper-1');
    expect(run({ input: 'video', output: 'text' })).toContain('qwen/qwen3.8-27b:free');
    expect(run({ output: 'embeddings' })).toEqual(['liquid/lfm-2.5-embedding-350m:free']);
  });

  it('filters by provider', () => {
    expect(run({ provider: 'google' }).every((id) => id.startsWith('google/'))).toBe(true);
    expect(run({ provider: 'google' }).length).toBeGreaterThan(3);
    // The author of `~vendor/model` aliases is the vendor.
    expect(run({ provider: 'openai' })).toContain('~openai/gpt-sol-latest');
  });

  it('Free only keeps :free ids and the free router, not zero-priced media models', () => {
    const free = run({ freeOnly: true });
    expect(free).toContain('qwen/qwen3.8-27b:free');
    expect(free).toContain('openrouter/free');
    expect(free).not.toContain('google/veo-3.1');
    expect(free).not.toContain('black-forest-labs/flux.2-pro');
    expect(free.every((id) => id.endsWith(':free') || id === 'openrouter/free')).toBe(true);
  });

  it('max price compares input plus output per 1M tokens; other units never pass', () => {
    const cheap = run({ maxPrice: 1 });
    expect(cheap).toContain('qwen/qwen3.8-27b:free');
    expect(cheap).toContain('qwen/qwen3.8-omni-flash');
    expect(cheap).not.toContain('openai/gpt-6.1-sol');
    // Billed per hour, character, image or second of video: no per-token price to compare.
    expect(cheap).not.toContain('google/veo-3.1');
    expect(cheap).not.toContain('openai/whisper-1');
    expect(cheap).not.toContain('hexgrad/kokoro-82m');
    expect(cheap).not.toContain('black-forest-labs/flux.2-pro');
    expect(run({ maxPrice: 12 })).toContain('openai/gpt-6.1-sol');
    expect(run({ maxPrice: 11.99 })).not.toContain('openai/gpt-6.1-sol');
    expect(run({ maxPrice: 0 }).every((id) => get(id).isFree)).toBe(true);
  });

  it('counts the models a price limit hides because they are billed in another unit', () => {
    const limited = { ...NO_FILTERS, maxPrice: 1 };
    const hidden = hiddenByPriceLimit(models, limited, NONE);
    const unitModels = models.filter((model) => {
      const g = group(model.id);
      return g === null || g > 1;
    });
    expect(hidden).toBe(unitModels.length);
    expect(hidden).toBeGreaterThan(10);
    // Without a limit nothing is hidden; other filters narrow what could have been shown.
    expect(hiddenByPriceLimit(models, NO_FILTERS, NONE)).toBe(0);
    expect(hiddenByPriceLimit(models, { ...limited, capability: 'video' }, NONE)).toBe(5);
    expect(hiddenByPriceLimit(models, { ...limited, capability: 'text' }, NONE)).toBeLessThan(
      hidden,
    );
  });

  it('compares the limit in micro-dollars, without float artefacts', () => {
    // $0.10 in + $0.50 out is exactly $0.60, not 0.6000000000000001.
    const model = normalizeModel({
      id: 'a/b',
      name: 'a',
      created: 0,
      context_length: 8000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000001', completion: '0.0000005' },
    });
    const pass = (maxPrice: number) =>
      queryModels([model], { ...NO_FILTERS, maxPrice }, 'name', NONE).length;
    expect(pass(0.6)).toBe(1);
    expect(pass(0.59)).toBe(0);
  });

  it('min context drops smaller and unknown windows', () => {
    const big = run({ minContext: 1_000_000 });
    expect(big).toContain('anthropic/claude-sonnet-5.5');
    expect(big).not.toContain('qwen/qwen3.8-27b:free');
    expect(big).not.toContain('hexgrad/kokoro-82m');
    expect(run({ minContext: 8_000 })).not.toContain('google/veo-3.1');
  });

  it('favourites only', () => {
    expect(run({ favouritesOnly: true }, 'name', new Set(['openai/gpt-6.1-sol', 'nope']))).toEqual([
      'openai/gpt-6.1-sol',
    ]);
    expect(run({ favouritesOnly: true })).toEqual([]);
  });

  it('combines filters', () => {
    expect(run({ freeOnly: true, capability: 'vision', minContext: 262_144 }).sort()).toEqual([
      'google/gemma-4-31b-it:free',
      'qwen/qwen3.8-27b:free',
    ]);
  });

  it('counts the active filters, not the search text', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, text: 'gpt' })).toBe(0);
    expect(
      activeFilterCount({
        ...NO_FILTERS,
        freeOnly: true,
        maxPrice: 0,
        minContext: 8000,
        provider: 'x',
      }),
    ).toBe(4);
  });
});

describe('search', () => {
  it('matches name, id and provider, best first', () => {
    const ids = run({ text: 'kokoro' }, 'relevance');
    expect(ids[0]).toBe('hexgrad/kokoro-82m');
    expect(run({ text: 'hexgrad' }, 'relevance')).toContain('hexgrad/kokoro-82m');
    expect(run({ text: 'claude sonnet' }, 'relevance')[0]).toBe('anthropic/claude-sonnet-5.5');
  });

  it('finds models by an exact id (the palette links with ?q=<id>)', () => {
    expect(run({ text: 'qwen/qwen3.8-27b:free' }, 'relevance')[0]).toBe('qwen/qwen3.8-27b:free');
  });

  it('finds nothing for gibberish, and combines with filters', () => {
    expect(run({ text: 'zzzzqqqq' }, 'relevance')).toEqual([]);
    expect(run({ text: 'qwen', freeOnly: true }, 'relevance')).toEqual(['qwen/qwen3.8-27b:free']);
  });

  it('keeps the ranking for Best match and re-sorts for the other sorts', () => {
    const relevance = run({ text: 'sol' }, 'relevance');
    const byName = run({ text: 'sol' }, 'name');
    expect([...relevance].sort()).toEqual([...byName].sort());
  });

  it('reads and caps ?q=', () => {
    expect(parseQuery('?q=%20gpt%20')).toBe('gpt');
    expect(parseQuery('')).toBe('');
    expect(parseQuery(`?q=${'a'.repeat(500)}`)).toHaveLength(200);
  });
});

describe('sorting', () => {
  it('by name, ignoring case, ties by id', () => {
    const names = queryModels(models, NO_FILTERS, 'name', NONE).map((model) => model.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
  });

  it('by price: free first, then each unit on its own, cheapest first, unknown last', () => {
    const list = queryModels(models, NO_FILTERS, 'price', NONE);
    const keys = list.map((model) => comparablePrice(modelPrice(model)));
    expect(keys[0]).toEqual({ group: 0, amount: 0 });
    const firstUnknown = keys.indexOf(null);
    expect(firstUnknown).toBeGreaterThan(0);
    expect(keys.slice(firstUnknown).every((key) => key === null)).toBe(true);
    const known = keys.slice(0, firstUnknown) as { group: number; amount: number }[];
    // Groups never interleave (tokens, images, hours of audio… are not compared with each other)…
    const groups = known.map((key) => key.group);
    expect(groups).toEqual([...groups].sort((x, y) => x - y));
    // …and inside a group the amounts only go up.
    for (let i = 1; i < known.length; i++) {
      if (known[i]!.group === known[i - 1]!.group) {
        expect(known[i]!.amount).toBeGreaterThanOrEqual(known[i - 1]!.amount);
      }
    }
    expect(new Set(groups).size).toBeGreaterThan(3);
  });

  it('by context: biggest first, unknown last', () => {
    const list = queryModels(models, NO_FILTERS, 'context', NONE);
    expect(list[0]?.id).toBe('openrouter/auto');
    const contexts = list.map((model) => model.contextLength);
    const firstUnknown = contexts.indexOf(null);
    expect(contexts.slice(firstUnknown).every((value) => value === null)).toBe(true);
    const known = contexts.slice(0, firstUnknown) as number[];
    expect(known).toEqual([...known].sort((a, b) => b - a));
  });

  it('by newest: highest created first', () => {
    const created = queryModels(models, NO_FILTERS, 'newest', NONE).map((model) => model.created);
    const known = created.filter((value) => value > 0);
    expect(known).toEqual([...known].sort((a, b) => b - a));
  });
});

describe('facets', () => {
  it('lists providers by count, and the modalities that exist', () => {
    const facets = modelFacets(models);
    expect(facets.providers[0]!.count).toBeGreaterThanOrEqual(facets.providers[1]!.count);
    expect(facets.providers.find((p) => p.id === 'google')?.count).toBeGreaterThan(3);
    expect(facets.inputs).toEqual(
      expect.arrayContaining(['text', 'image', 'audio', 'video', 'file']),
    );
    expect(facets.outputs).toEqual(
      expect.arrayContaining(['text', 'image', 'speech', 'transcription', 'video', 'decisions']),
    );
  });
});

const usage = (partial: Partial<ModelUsage> = {}): ModelUsage => ({
  runs: 1,
  requests: 1,
  avgLatencyMs: null,
  costUsd: 0,
  estimatedUsd: 0,
  ...partial,
});

describe('usage text', () => {
  it('summarises runs, latency and spend, or says it is unused', () => {
    expect(usageText(undefined)).toBe('Not used yet');
    expect(usageText(usage({ runs: 0, requests: 0 }))).toBe('Not used yet');
    expect(usageText(usage({ runs: 12, avgLatencyMs: 1234, costUsd: 0.034 }))).toBe(
      '12 runs · avg 1.2 s · $0.034',
    );
    expect(usageText(usage())).toBe('1 run · $0.00');
  });

  it('marks spend that includes estimates', () => {
    expect(usageText(usage({ runs: 2, costUsd: 0.05, estimatedUsd: 0.02 }))).toBe(
      '2 runs · ≈ $0.05',
    );
  });

  it('counts requests for a model that was only ever a second model of a run', () => {
    expect(usageText(usage({ runs: 0, requests: 3, avgLatencyMs: 500, costUsd: 0.01 }))).toBe(
      '3 requests · avg 500 ms · $0.01',
    );
  });
});

describe('usage from the ledger', () => {
  const row = (partial: Partial<StatsRow>): StatsRow => ({
    day: '2026-10-01',
    tool: 'chat',
    model: 'm/a',
    keyId: 'k',
    free: false,
    runs: 1,
    errors: 0,
    requests: 1,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0.01,
    estimatedUsd: 0,
    latencyMsTotal: 1000,
    ...partial,
  });

  it('sums every row of a model: runs, requests, latency, spend and its estimated part', () => {
    const map = usageByModel([
      row({ runs: 2, requests: 3, costUsd: 0.3, latencyMsTotal: 3000 }),
      row({
        day: '2026-10-02',
        runs: 1,
        requests: 1,
        costUsd: 0.1,
        estimatedUsd: 0.1,
        latencyMsTotal: 1000,
      }),
      row({ model: 'm/b', tool: 'ocr', runs: 0, requests: 2, costUsd: 0 }),
    ]);
    expect(map.get('m/a')).toEqual({
      runs: 3,
      requests: 4,
      avgLatencyMs: 1000,
      costUsd: expect.closeTo(0.4) as number,
      estimatedUsd: 0.1,
    });
    expect(map.get('m/b')).toMatchObject({ runs: 0, requests: 2 });
    expect(map.get('never/used')).toBeUndefined();
    expect(usageByModel([]).size).toBe(0);
  });

  it('has no average latency without requests', () => {
    const map = usageByModel([row({ runs: 1, requests: 0, latencyMsTotal: 0 })]);
    expect(map.get('m/a')?.avgLatencyMs).toBeNull();
  });
});

describe('comparison', () => {
  const pair = [get('openai/gpt-6.1-sol'), get('qwen/qwen3.8-27b:free')];
  const sections = compareSections(
    pair,
    new Map([['openai/gpt-6.1-sol', usage({ runs: 3, avgLatencyMs: 900, costUsd: 0.5 })]]),
    Date.UTC(2026, 9, 3),
  );
  const row = (title: string, label: string) =>
    sections.find((section) => section.title === title)?.rows.find((r) => r.label === label);

  it('has one value per model in every row', () => {
    for (const section of sections) {
      for (const r of section.rows) expect(r.values).toHaveLength(pair.length);
    }
  });

  it('compares prices, context and modalities', () => {
    expect(row('Pricing', 'Input, per 1M tokens')?.values).toEqual(['$2.00', 'Free']);
    expect(row('Pricing', 'Output, per 1M tokens')?.values).toEqual(['$10.00', 'Free']);
    expect(row('Pricing', 'Price')?.values).toEqual([
      '$2.00 in · $10.00 out per 1M tokens',
      'Free',
    ]);
    expect(row('Limits', 'Context window')?.values).toEqual(['1.1M context', '262K context']);
    expect(row('Modalities', 'Input')?.values[0]).toContain('image');
    expect(row('Model', 'Provider')?.values).toEqual(['openai', 'qwen']);
    expect(row('Model', 'Capabilities')?.values[1]).toBe('Text, Vision');
  });

  it('adds your own use, with "Not used yet" for the rest', () => {
    expect(row('Your use', 'Runs, latency, spend')?.values).toEqual([
      '3 runs · avg 900 ms · $0.50',
      'Not used yet',
    ]);
  });

  it('lists the union of parameters as yes/no flags', () => {
    const parameters = sections.find((section) => section.title === 'Supported parameters');
    expect(parameters).toBeDefined();
    expect(parameters!.rows.every((r) => r.kind === 'flag')).toBe(true);
    expect(parameters!.rows.map((r) => r.label)).toEqual(
      [...parameters!.rows.map((r) => r.label)].sort(),
    );
    const tools = parameters!.rows.find((r) => r.label === 'tools');
    expect(tools?.values.every((value) => value === 'yes' || value === 'no')).toBe(true);
  });

  it('shows expiry, and unit pricing for media models', () => {
    const media = compareSections(
      [get('poolside/laguna-s-2.1:free'), get('google/veo-3.1')],
      new Map(),
      Date.UTC(2026, 9, 3),
    );
    const find = (title: string, label: string) =>
      media.find((section) => section.title === title)?.rows.find((r) => r.label === label);
    expect(find('Model', 'Expires')?.values).toEqual(['Oct 31, 2026', '—']);
    expect(find('Pricing', 'Price')?.values).toEqual(['Free', 'Billed per second of video']);
    expect(find('Pricing', 'Input, per 1M tokens')?.values).toEqual(['Free', '—']);
  });
});

describe('comparison of other units', () => {
  it('lists audio and image output prices on an extra row, only when some model has one', () => {
    const rows = (ids: string[]) =>
      compareSections(ids.map(get), new Map(), Date.UTC(2026, 9, 3)).find(
        (section) => section.title === 'Pricing',
      )!.rows;
    const withExtras = rows(['openai/gpt-audio', 'openai/gpt-6.1-sol']);
    expect(withExtras.find((r) => r.label === 'Also billed')?.values).toEqual([
      'Audio: $32.00 in · $64.00 out per 1M tokens',
      '—',
    ]);
    expect(rows(['openai/gpt-6.1-sol', 'qwen/qwen3.8-27b:free']).map((r) => r.label)).not.toContain(
      'Also billed',
    );
    // Speech and transcription are compared in their own unit, with no token columns to fill.
    const media = rows(['hexgrad/kokoro-82m', 'openai/whisper-1']);
    expect(media.find((r) => r.label === 'Price')?.values).toEqual([
      '$0.62 per 1M characters',
      '$0.36 per hour of audio',
    ]);
    expect(media.find((r) => r.label === 'Input, per 1M tokens')?.values).toEqual(['—', '—']);
  });
});
