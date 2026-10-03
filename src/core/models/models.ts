/**
 * Model catalog service. The catalog (`GET /models?output_modalities=all`, ~1 MB), the image and video model
 * lists and per-model endpoint lists are cached in IndexedDB `kv` as `{fetchedAt, models}` (endpoints:
 * `{fetchedAt, endpoints}`), refreshed when older than 24 h or on demand, and served from cache when offline.
 * A refresh emits `models-refreshed`; other tabs drop their in-memory copy and reload from IndexedDB.
 */

import type { RawImageModel, RawModel, RawModelEndpoint, RawVideoModel } from '../api/types';
import { getDb } from '../storage/db';
import type { CoreServices, ModelInfo, ModelsService, ResolvedModel } from '../types';
import { CAPABILITY_LABELS, SHIPPED_DEFAULTS } from './defaults';
import {
  estimateDecision,
  estimateImage,
  estimateMusic,
  estimateSpeech,
  estimateTokens,
  estimateTranscription,
  estimateVideo,
} from './estimate';
import { isFreeModelId } from './free';
import { normalizeModel } from './normalize';

export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const KV_CATALOG = 'models:catalog';
export const KV_IMAGE_MODELS = 'models:images';
export const KV_VIDEO_MODELS = 'models:videos';
export const kvEndpoints = (modelId: string): string => `models:endpoints:${modelId}`;

interface CacheOptions<T> {
  key: string;
  field: 'models' | 'endpoints';
  fetch: () => Promise<T[]>;
  now: () => number;
  maxAgeMs: number;
  onRefreshed?: () => void;
}

/** One cached list: memory → IndexedDB → network, with offline fallback to whatever is cached. */
class ListCache<T> {
  private memory: { fetchedAt: number; items: T[] } | null = null;
  private inflight: Promise<T[]> | null = null;
  private readonly options: CacheOptions<T>;

  constructor(options: CacheOptions<T>) {
    this.options = options;
  }

  get fetchedAt(): number | null {
    return this.memory?.fetchedAt ?? null;
  }

  invalidate(): void {
    this.memory = null;
  }

  get(refresh = false): Promise<T[]> {
    if (!refresh && this.memory && this.fresh(this.memory.fetchedAt)) {
      return Promise.resolve(this.memory.items);
    }
    this.inflight ??= this.load(refresh).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private fresh(fetchedAt: number): boolean {
    const age = this.options.now() - fetchedAt;
    return age >= 0 && age < this.options.maxAgeMs;
  }

  private async load(refresh: boolean): Promise<T[]> {
    this.memory ??= await this.read();
    if (!refresh && this.memory && this.fresh(this.memory.fetchedAt)) return this.memory.items;
    try {
      const items = await this.options.fetch();
      this.memory = { fetchedAt: this.options.now(), items };
      await this.write(this.memory);
      this.options.onRefreshed?.();
      return items;
    } catch (error) {
      // Offline or OpenRouter down: a stale copy beats nothing.
      if (this.memory) return this.memory.items;
      throw error;
    }
  }

  private async read(): Promise<{ fetchedAt: number; items: T[] } | null> {
    try {
      const entry = await (await getDb()).get('kv', this.options.key);
      const value = entry?.value as Record<string, unknown> | undefined;
      const items = value?.[this.options.field];
      const fetchedAt = value?.['fetchedAt'];
      if (Array.isArray(items) && typeof fetchedAt === 'number') {
        return { fetchedAt, items: items as T[] };
      }
    } catch {
      // IndexedDB unavailable (some private modes): memory only.
    }
    return null;
  }

  private async write(entry: { fetchedAt: number; items: T[] }): Promise<void> {
    try {
      await (
        await getDb()
      ).put('kv', {
        key: this.options.key,
        value: { fetchedAt: entry.fetchedAt, [this.options.field]: entry.items },
        updatedAt: entry.fetchedAt,
      });
    } catch {
      // Not cached; the next page load fetches again.
    }
  }
}

export interface ModelsServiceOptions {
  now?: () => number;
  maxAgeMs?: number;
}

export function createModelsService(
  core: CoreServices,
  options: ModelsServiceOptions = {},
): ModelsService {
  const now = options.now ?? (() => Date.now());
  const maxAgeMs = options.maxAgeMs ?? CATALOG_MAX_AGE_MS;
  let emitting = false;
  let listening = false;

  function announce(): void {
    emitting = true;
    try {
      core.bus.emit({ type: 'models-refreshed' });
    } finally {
      emitting = false;
    }
  }

  /** Another tab refreshed: drop memory copies so the next read loads its result from IndexedDB. */
  function listen(): void {
    if (listening) return;
    listening = true;
    core.bus.on('models-refreshed', () => {
      if (emitting) return;
      catalog.invalidate();
      images.invalidate();
      videos.invalidate();
      normalized = null;
    });
  }

  const catalog = new ListCache<RawModel>({
    key: KV_CATALOG,
    field: 'models',
    fetch: () => core.api.catalog.models({ output_modalities: 'all' }),
    now,
    maxAgeMs,
    onRefreshed: announce,
  });
  const images = new ListCache<RawImageModel>({
    key: KV_IMAGE_MODELS,
    field: 'models',
    fetch: () => core.api.catalog.imageModels(),
    now,
    maxAgeMs,
    onRefreshed: announce,
  });
  const videos = new ListCache<RawVideoModel>({
    key: KV_VIDEO_MODELS,
    field: 'models',
    fetch: () => core.api.catalog.videoModels(),
    now,
    maxAgeMs,
    onRefreshed: announce,
  });
  const endpointCaches = new Map<string, ListCache<RawModelEndpoint>>();

  let normalized: { source: RawModel[]; models: ModelInfo[]; byId: Map<string, ModelInfo> } | null =
    null;

  async function list(opts?: { refresh?: boolean }): Promise<ModelInfo[]> {
    listen();
    const raw = await catalog.get(opts?.refresh === true);
    if (normalized?.source !== raw) {
      const models = raw.map(normalizeModel);
      normalized = { source: raw, models, byId: new Map(models.map((m) => [m.id, m])) };
    }
    return normalized.models;
  }

  async function get(id: string): Promise<ModelInfo | undefined> {
    await list();
    return normalized?.byId.get(id);
  }

  function endpointsCache(modelId: string): ListCache<RawModelEndpoint> {
    let cache = endpointCaches.get(modelId);
    if (!cache) {
      cache = new ListCache<RawModelEndpoint>({
        key: kvEndpoints(modelId),
        field: 'endpoints',
        fetch: () => core.api.catalog.modelEndpoints(modelId),
        now,
        maxAgeMs,
      });
      endpointCaches.set(modelId, cache);
    }
    return cache;
  }

  async function estimateOrNull(
    input: Parameters<ModelsService['estimate']>[0],
  ): Promise<number | null> {
    switch (input.kind) {
      case 'tokens': {
        const model = await get(input.model);
        return model ? estimateTokens(model, input.promptTokens, input.completionTokens) : null;
      }
      case 'decision': {
        const model = await get(input.model);
        return model ? estimateDecision(model, input.inputTokens) : null;
      }
      case 'speech': {
        const model = await get(input.model).catch(() => undefined);
        const endpoints = await endpointsCache(input.model)
          .get()
          .catch(() => []);
        if (!model && endpoints.length === 0) return null;
        return estimateSpeech(input.characters, endpoints, model?.pricing.raw ?? {});
      }
      case 'transcription': {
        const model = await get(input.model);
        return model ? estimateTranscription(input.seconds, model.pricing.raw) : null;
      }
      case 'image': {
        const model = await get(input.model);
        return model ? estimateImage(model, input) : null;
      }
      case 'video': {
        const model = (await videos.get()).find((m) => m.id === input.model);
        if (!model) return null;
        const videoInput: { seconds: number; resolution?: string; withAudio?: boolean } = {
          seconds: input.seconds,
        };
        if (input.resolution) videoInput.resolution = input.resolution;
        if (input.withAudio !== undefined) videoInput.withAudio = input.withAudio;
        return estimateVideo(model, videoInput);
      }
      case 'music': {
        const model = await get(input.model).catch(() => undefined);
        return estimateMusic(model ?? { id: input.model, description: '' });
      }
    }
  }

  return {
    list,
    get,

    async forCapability(cap) {
      const freeOnly = core.settings.get().freeOnly;
      return (await list()).filter(
        (model) => model.capabilities.includes(cap) && (!freeOnly || model.isFree),
      );
    },

    isFree: isFreeModelId,

    shippedDefault(cap) {
      const { paid, free } = SHIPPED_DEFAULTS[cap];
      return { paid, free };
    },

    resolve(tool, cap, runOverride) {
      const settings = core.settings.get();
      const candidates: Array<[ResolvedModel['source'], string | undefined]> = [
        ['run', runOverride],
        ['tool', settings.tools[tool]?.model],
        ['capability', settings.defaultModels[cap]],
        ['shipped', SHIPPED_DEFAULTS[cap].paid],
      ];
      let wanted: string | undefined;
      for (const [source, id] of candidates) {
        if (!id) continue;
        wanted ??= id;
        if (!settings.freeOnly) return { model: id, source, note: null };
        if (isFreeModelId(id)) {
          return {
            model: id,
            source,
            note: id === wanted ? null : `Free-only mode: using ${id} instead of ${wanted}.`,
          };
        }
      }
      const free = SHIPPED_DEFAULTS[cap].free;
      if (free) {
        return {
          model: free,
          source: 'shipped',
          note: `Free-only mode: using ${free} instead of ${wanted ?? 'the paid default'}.`,
        };
      }
      return {
        model: null,
        source: 'none',
        note: `No free ${CAPABILITY_LABELS[cap]} model exists; free-only mode blocks this tool.`,
      };
    },

    imageModels(opts) {
      listen();
      return images.get(opts?.refresh === true);
    },

    videoModels(opts) {
      listen();
      return videos.get(opts?.refresh === true);
    },

    endpoints(modelId) {
      return endpointsCache(modelId).get();
    },

    async estimate(input) {
      if (isFreeModelId(input.model)) return 0;
      try {
        const value = await estimateOrNull(input);
        return value !== null && Number.isFinite(value) ? value : null;
      } catch {
        // No catalog (offline, never fetched): unknown.
        return null;
      }
    },

    lastRefreshed() {
      return catalog.fetchedAt;
    },
  };
}
