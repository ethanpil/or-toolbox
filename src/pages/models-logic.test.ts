import { describe, expect, it } from 'vitest';
import modelsFixture from '../../tests/fixtures/openrouter/models.json';
import type { RawModel } from '../core/api/types';
import { normalizeModel } from '../core/models/normalize';
import type { ModelInfo } from '../core/types';
import {
  activeFilterCount,
  compareSections,
  expiryOf,
  modelFacets,
  type ModelFilters,
  type ModelSort,
  NO_FILTERS,
  parseQuery,
  priceInfo,
  priceKey,
  priceText,
  queryModels,
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

describe('prices', () => {
  it('shows Free only for :free ids, whatever the price says', () => {
    expect(priceInfo(get('nvidia/nemotron-3-super-120b-a12b:free'))).toEqual({ kind: 'free' });
    expect(priceText(get('nvidia/nemotron-3-super-120b-a12b:free'))).toBe('Free');
    // Every video model prices at "0" and is not free.
    expect(priceInfo(get('google/veo-3.1'))).toEqual({
      kind: 'unit',
      text: 'Billed per second of video',
    });
  });

  it('prices token models per million tokens, input and output', () => {
    const info = priceInfo(get('openai/gpt-6.1-sol'));
    expect(info.kind).toBe('tokens');
    expect(priceText(get('openai/gpt-6.1-sol'))).toBe('$2.00 in · $10.00 out per 1M tokens');
    expect(priceKey(get('openai/gpt-6.1-sol'))).toBeCloseTo(12);
  });

  it('names the unit of media models and marks routers as varying', () => {
    expect(priceText(get('hexgrad/kokoro-82m'))).toBe(
      'Billed by the provider per character or second',
    );
    expect(priceText(get('openai/whisper-1'))).toBe('Billed per second of audio');
    expect(priceText(get('google/lyria-3-clip-preview'))).toBe('Billed per song or clip');
    expect(priceText(get('black-forest-labs/flux.2-pro'))).toBe('Billed per image');
    // "-1" is the router sentinel: no price at all.
    expect(priceKey(get('openrouter/auto'))).toBeNull();
    expect(priceText(get('openrouter/auto'))).toBe('Price varies');
  });

  it('sorts keys: free is 0, units are unknown', () => {
    expect(priceKey(get('qwen/qwen3.8-27b:free'))).toBe(0);
    expect(priceKey(get('google/veo-3.1'))).toBeNull();
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

  it('max price compares input plus output per 1M tokens; unknown prices never pass', () => {
    const cheap = run({ maxPrice: 1 });
    expect(cheap).toContain('qwen/qwen3.8-27b:free');
    expect(cheap).toContain('qwen/qwen3.8-omni-flash');
    expect(cheap).not.toContain('openai/gpt-6.1-sol');
    expect(cheap).not.toContain('google/veo-3.1');
    expect(run({ maxPrice: 12 })).toContain('openai/gpt-6.1-sol');
    expect(run({ maxPrice: 11.99 })).not.toContain('openai/gpt-6.1-sol');
    expect(run({ maxPrice: 0 }).every((id) => get(id).isFree)).toBe(true);
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

  it('by price: free first, then cheapest, unknown last', () => {
    const list = queryModels(models, NO_FILTERS, 'price', NONE);
    const keys = list.map(priceKey);
    expect(keys[0]).toBe(0);
    const firstUnknown = keys.indexOf(null);
    expect(firstUnknown).toBeGreaterThan(0);
    expect(keys.slice(firstUnknown).every((key) => key === null)).toBe(true);
    const known = keys.slice(0, firstUnknown) as number[];
    expect(known).toEqual([...known].sort((a, b) => a - b));
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

describe('usage text', () => {
  it('summarises runs, latency and spend, or says it is unused', () => {
    expect(usageText(undefined)).toBe('Not used yet');
    expect(usageText({ runs: 0, avgLatencyMs: null, costUsd: 0 })).toBe('Not used yet');
    expect(usageText({ runs: 12, avgLatencyMs: 1234, costUsd: 0.034 })).toBe(
      '12 runs · avg 1.2 s · $0.034',
    );
    expect(usageText({ runs: 1, avgLatencyMs: null, costUsd: 0 })).toBe('1 run · $0.00');
  });
});

describe('comparison', () => {
  const pair = [get('openai/gpt-6.1-sol'), get('qwen/qwen3.8-27b:free')];
  const sections = compareSections(
    pair,
    new Map([['openai/gpt-6.1-sol', { runs: 3, avgLatencyMs: 900, costUsd: 0.5 }]]),
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
    expect(row('Pricing', 'Billing')?.values).toEqual(['Per token', 'Free']);
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
    expect(find('Pricing', 'Billing')?.values).toEqual(['Free', 'Billed per second of video']);
    expect(find('Pricing', 'Input, per 1M tokens')?.values).toEqual(['Free', '—']);
  });
});
