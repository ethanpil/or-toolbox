/**
 * The Models page without a DOM: filtering, sorting, price display and the comparison table. Pure functions over
 * `ModelInfo`, so the rules are unit-tested (models-logic.test.ts) and the page only draws the result.
 */
import type { Capability, ModelInfo } from '../core/types';
import { CAPABILITIES } from '../tools/types';
import { formatContext, formatMs, formatUsd, plural } from '../ui/format';
import { rank } from '../ui/shell/palette-search';

const PER_MILLION = 1_000_000;
/** USD per token → USD per 1M tokens, without float noise (0.000002 * 1e6 is not exactly 2). */
const perMillion = (price: number): number => Number((price * PER_MILLION).toPrecision(12));

export type ModelSort = 'relevance' | 'name' | 'newest' | 'price' | 'context';
export const MODEL_SORTS: readonly { id: ModelSort; label: string }[] = [
  { id: 'relevance', label: 'Best match' },
  { id: 'name', label: 'Name (A to Z)' },
  { id: 'newest', label: 'Newest first' },
  { id: 'price', label: 'Price (low to high)' },
  { id: 'context', label: 'Context (high to low)' },
];

export interface ModelFilters {
  text: string;
  capability: Capability | '';
  /** An input or output modality of the catalog (`image`, `audio`, …), or '' for any. */
  input: string;
  output: string;
  /** The author, i.e. the text before the slash of the id. */
  provider: string;
  freeOnly: boolean;
  favouritesOnly: boolean;
  /** USD per 1M tokens, input plus output; null = no limit. */
  maxPrice: number | null;
  /** Minimum context window in tokens; 0 = any. */
  minContext: number;
}

export const NO_FILTERS: Readonly<ModelFilters> = {
  text: '',
  capability: '',
  input: '',
  output: '',
  provider: '',
  freeOnly: false,
  favouritesOnly: false,
  maxPrice: null,
  minContext: 0,
};

/** Number of filters (not the search text) that are set. */
export function activeFilterCount(filters: ModelFilters): number {
  return [
    filters.capability !== '',
    filters.input !== '',
    filters.output !== '',
    filters.provider !== '',
    filters.freeOnly,
    filters.favouritesOnly,
    filters.maxPrice !== null,
    filters.minContext > 0,
  ].filter(Boolean).length;
}

const CAPABILITY_INFO: Record<Capability, { label: string; badge: string }> = {
  text: { label: 'Text', badge: 'Text' },
  vision: { label: 'Vision (image input)', badge: 'Vision' },
  image: { label: 'Image generation', badge: 'Image' },
  tts: { label: 'Text to speech', badge: 'Speech' },
  stt: { label: 'Speech to text', badge: 'Transcribe' },
  video: { label: 'Video generation', badge: 'Video' },
  music: { label: 'Music', badge: 'Music' },
  decisions: { label: 'Decisions', badge: 'Decisions' },
};

export const CAPABILITY_FILTERS: readonly { id: Capability; label: string }[] = CAPABILITIES.map(
  (id) => ({ id, label: CAPABILITY_INFO[id].label }),
);

/** Short name for a capability badge on a card. */
export const capabilityBadge = (capability: Capability): string =>
  CAPABILITY_INFO[capability].badge;

export const CONTEXT_STEPS: readonly { tokens: number; label: string }[] = [
  { tokens: 8_000, label: '8K or more' },
  { tokens: 32_000, label: '32K or more' },
  { tokens: 128_000, label: '128K or more' },
  { tokens: 200_000, label: '200K or more' },
  { tokens: 1_000_000, label: '1M or more' },
];

// --- prices ----------------------------------------------------------------------------------------------

export type PriceInfo =
  | { kind: 'free' }
  | { kind: 'tokens'; inputPer1M: number; outputPer1M: number }
  | { kind: 'unit'; text: string };

/** What non-token models bill by (docs/openrouter-api.md §4.3, §5.4, §6.3, §7.5); the catalog has no unit field. */
const UNIT_NOTES: Partial<Record<Capability, string>> = {
  tts: 'Billed by the provider per character or second',
  stt: 'Billed per second of audio',
  video: 'Billed per second of video',
  music: 'Billed per song or clip',
  image: 'Billed per image',
};

export function priceInfo(model: ModelInfo): PriceInfo {
  if (model.isFree) return { kind: 'free' };
  const { prompt, completion, request, image } = model.pricing;
  if (prompt !== null && completion !== null && (prompt > 0 || completion > 0)) {
    return {
      kind: 'tokens',
      inputPer1M: perMillion(prompt),
      outputPer1M: perMillion(completion),
    };
  }
  if (request) return { kind: 'unit', text: `${formatUsd(request)} per request` };
  if (image && prompt === null) return { kind: 'unit', text: `${formatUsd(image)} per image` };
  for (const capability of model.capabilities) {
    const note = UNIT_NOTES[capability];
    if (note) return { kind: 'unit', text: note };
  }
  return { kind: 'unit', text: 'Price varies' };
}

/** Input plus output USD per 1M tokens; 0 for free models; null when the price is not per token. */
export function priceKey(model: ModelInfo): number | null {
  const price = priceInfo(model);
  if (price.kind === 'free') return 0;
  return price.kind === 'tokens' ? price.inputPer1M + price.outputPer1M : null;
}

/** `$0.10 in · $0.50 out per 1M tokens`, `Free`, or the model's own unit. */
export function priceText(model: ModelInfo): string {
  const price = priceInfo(model);
  if (price.kind === 'free') return 'Free';
  if (price.kind === 'unit') return price.text;
  return `${formatUsd(price.inputPer1M)} in · ${formatUsd(price.outputPer1M)} out per 1M tokens`;
}

// --- expiry ----------------------------------------------------------------------------------------------

export interface Expiry {
  /** `Oct 31, 2026`. */
  date: string;
  expired: boolean;
  daysLeft: number;
}

/** Models with an `expirationDate` (YYYY-MM-DD, UTC); null for the rest or an unreadable date. */
export function expiryOf(
  model: Pick<ModelInfo, 'expirationDate'>,
  now = Date.now(),
): Expiry | null {
  if (!model.expirationDate) return null;
  const time = Date.parse(`${model.expirationDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  const dayMs = 86_400_000;
  return {
    date: new Date(time).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }),
    // The model is available through its expiration day.
    expired: now >= time + dayMs,
    daysLeft: Math.max(0, Math.ceil((time + dayMs - now) / dayMs)),
  };
}

// --- facets, filtering, sorting --------------------------------------------------------------------------

export interface ModelFacets {
  providers: { id: string; count: number }[];
  inputs: string[];
  outputs: string[];
}

/** The choices of the provider and modality filters: what the catalog actually contains. */
export function modelFacets(models: readonly ModelInfo[]): ModelFacets {
  const providers = new Map<string, number>();
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  for (const model of models) {
    if (model.author) providers.set(model.author, (providers.get(model.author) ?? 0) + 1);
    for (const modality of model.inputModalities) inputs.add(modality);
    for (const modality of model.outputModalities) outputs.add(modality);
  }
  return {
    providers: [...providers]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    inputs: [...inputs].sort(),
    outputs: [...outputs].sort(),
  };
}

function passes(model: ModelInfo, filters: ModelFilters, favourites: ReadonlySet<string>): boolean {
  if (filters.capability && !model.capabilities.includes(filters.capability)) return false;
  if (filters.input && !model.inputModalities.includes(filters.input)) return false;
  if (filters.output && !model.outputModalities.includes(filters.output)) return false;
  if (filters.provider && model.author !== filters.provider) return false;
  if (filters.freeOnly && !model.isFree) return false;
  if (filters.favouritesOnly && !favourites.has(model.id)) return false;
  if (filters.maxPrice !== null) {
    // A price that is not per token cannot be compared, so such models do not pass a price limit.
    const key = priceKey(model);
    if (key === null || key > filters.maxPrice) return false;
  }
  if (filters.minContext > 0 && (model.contextLength ?? 0) < filters.minContext) return false;
  return true;
}

const byName = (a: ModelInfo, b: ModelInfo): number =>
  a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Nulls last, otherwise `ascending` or descending by the key; ties by name. */
function sortByKey(
  list: ModelInfo[],
  key: (model: ModelInfo) => number | null,
  ascending: boolean,
): ModelInfo[] {
  return list.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (x === null && y === null) return byName(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (ascending ? x - y : y - x) || byName(a, b);
  });
}

/**
 * The visible list: filters first, then the search text (ranked, with the name weighing most), then the sort.
 * "Best match" keeps the search ranking, and falls back to the name when nothing was typed.
 */
export function queryModels(
  models: readonly ModelInfo[],
  filters: ModelFilters,
  sort: ModelSort,
  favourites: ReadonlySet<string>,
): ModelInfo[] {
  let list = models.filter((model) => passes(model, filters, favourites));
  const text = filters.text.trim();
  const searching = text !== '';
  if (searching) {
    list = rank(
      list.map((model) => ({
        label: model.name,
        detail: model.id,
        keywords: `${model.author} ${model.capabilities.join(' ')}`,
        model,
      })),
      text,
    ).map((entry) => entry.model);
  } else {
    list = [...list];
  }
  switch (sort) {
    case 'relevance':
      return searching ? list : list.sort(byName);
    case 'name':
      return list.sort(byName);
    case 'newest':
      return sortByKey(list, (model) => model.created || null, false);
    case 'price':
      return sortByKey(list, priceKey, true);
    case 'context':
      return sortByKey(list, (model) => model.contextLength, false);
  }
}

/** The page's `?q=` value, trimmed and capped (it ends up in an input, never in markup). */
export function parseQuery(search: string): string {
  return (new URLSearchParams(search).get('q') ?? '').trim().slice(0, 200);
}

/** `12 runs · avg 1.2 s · $0.034` or "Not used yet". */
export interface ModelUsage {
  runs: number;
  avgLatencyMs: number | null;
  costUsd: number;
}

export function usageText(usage: ModelUsage | undefined): string {
  if (!usage || usage.runs === 0) return 'Not used yet';
  return [
    plural(usage.runs, 'run'),
    usage.avgLatencyMs === null ? null : `avg ${formatMs(usage.avgLatencyMs)}`,
    formatUsd(usage.costUsd),
  ]
    .filter(Boolean)
    .join(' · ');
}

// --- comparison ------------------------------------------------------------------------------------------

export interface CompareRow {
  label: string;
  /** One entry per model. For `flag` rows: `'yes'` or `'no'`. */
  values: string[];
  kind: 'text' | 'flag';
}

export interface CompareSection {
  title: string;
  rows: CompareRow[];
}

const dateText = (seconds: number): string =>
  seconds > 0
    ? new Date(seconds * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : '—';

const list = (items: readonly string[]): string => (items.length > 0 ? items.join(', ') : '—');

/** The side-by-side table of 2 to 4 models: prices, limits, modalities, parameters, your own use. */
export function compareSections(
  models: readonly ModelInfo[],
  usage: ReadonlyMap<string, ModelUsage> = new Map(),
  now = Date.now(),
): CompareSection[] {
  const text = (label: string, value: (model: ModelInfo) => string): CompareRow => ({
    label,
    values: models.map(value),
    kind: 'text',
  });
  const sidePrice = (model: ModelInfo, side: 'inputPer1M' | 'outputPer1M'): string => {
    const price = priceInfo(model);
    if (price.kind === 'free') return 'Free';
    return price.kind === 'tokens' ? formatUsd(price[side]) : '—';
  };

  const pricing: CompareRow[] = [
    text('Input, per 1M tokens', (model) => sidePrice(model, 'inputPer1M')),
    text('Output, per 1M tokens', (model) => sidePrice(model, 'outputPer1M')),
    text('Billing', (model) => {
      const price = priceInfo(model);
      return price.kind === 'unit' ? price.text : price.kind === 'free' ? 'Free' : 'Per token';
    }),
  ];
  if (models.some((model) => model.pricing.request)) {
    pricing.push(
      text('Per request', (model) =>
        model.pricing.request ? formatUsd(model.pricing.request) : '—',
      ),
    );
  }
  if (models.some((model) => model.pricing.image)) {
    pricing.push(
      text('Per input image', (model) =>
        model.pricing.image ? formatUsd(model.pricing.image) : '—',
      ),
    );
  }

  const parameters = [...new Set(models.flatMap((model) => model.supportedParameters))].sort();

  const sections: CompareSection[] = [
    {
      title: 'Model',
      rows: [
        text('Provider', (model) => model.author || '—'),
        text('Model id', (model) => model.id),
        text('Capabilities', (model) => list(model.capabilities.map(capabilityBadge))),
        text('Added', (model) => dateText(model.created)),
        text('Expires', (model) => {
          const expiry = expiryOf(model, now);
          return expiry ? (expiry.expired ? `Expired ${expiry.date}` : expiry.date) : '—';
        }),
      ],
    },
    { title: 'Pricing', rows: pricing },
    {
      title: 'Limits',
      rows: [
        text('Context window', (model) => formatContext(model.contextLength) ?? '—'),
        text('Max output', (model) =>
          model.maxCompletionTokens
            ? `${model.maxCompletionTokens.toLocaleString('en-US')} tokens`
            : '—',
        ),
      ],
    },
    {
      title: 'Modalities',
      rows: [
        text('Input', (model) => list(model.inputModalities)),
        text('Output', (model) => list(model.outputModalities)),
        ...(models.some((model) => model.supportedVoices)
          ? [
              text('Voices', (model) =>
                model.supportedVoices ? String(model.supportedVoices.length) : '—',
              ),
            ]
          : []),
      ],
    },
    {
      title: 'Your use',
      rows: [text('Runs, latency, spend', (model) => usageText(usage.get(model.id)))],
    },
  ];
  if (parameters.length > 0) {
    sections.push({
      title: 'Supported parameters',
      rows: parameters.map((parameter) => ({
        label: parameter,
        values: models.map((model) =>
          model.supportedParameters.includes(parameter) ? 'yes' : 'no',
        ),
        kind: 'flag' as const,
      })),
    });
  }
  return sections;
}
