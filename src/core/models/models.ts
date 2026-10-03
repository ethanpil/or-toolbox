/**
 * Model catalog service. The catalog (`GET /models?output_modalities=all`, ~1 MB), the image and video model
 * lists and per-model endpoint lists are cached in IndexedDB `kv` as `{fetchedAt, models}` (endpoints:
 * `{fetchedAt, endpoints}`). Stale-while-revalidate: a copy older than 24 h is returned at once and refreshed in
 * the background (one attempt; a failure is remembered for 5 minutes so an offline page does not keep trying).
 * Only `refresh: true` or an empty cache waits for the network. A stored refresh emits `models-refreshed`; other
 * tabs drop their in-memory copy and reload from IndexedDB.
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
/** After a failed refresh, the next automatic attempt waits this long. */
export const REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
export const KV_CATALOG = 'models:catalog';
export const KV_IMAGE_MODELS = 'models:images';
export const KV_VIDEO_MODELS = 'models:videos';
export const kvEndpoints = (modelId: string): string => `models:endpoints:${modelId}`;

interface CacheOptions<T> {
  key: string;
  field: 'models' | 'endpoints';
  /** `retry: false` for background refreshes. */
  fetch: (opts: { retry: boolean }) => Promise<T[]>;
  now: () => number;
  maxAgeMs: number;
  /** Runs once a refreshed list is stored in IndexedDB (other tabs then read the new copy). */
  onRefreshed?: () => void;
}

/** One cached list: memory → IndexedDB → network, stale-while-revalidate, offline-tolerant. */
class ListCache<T> {
  private memory: { fetchedAt: number; items: T[] } | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private foreground: Promise<T[]> | null = null;
  private background: Promise<void> | null = null;
  private failure: { at: number; error: unknown } | null = null;
  private readonly options: CacheOptions<T>;

  constructor(options: CacheOptions<T>) {
    this.options = options;
  }

  get fetchedAt(): number | null {
    return this.memory?.fetchedAt ?? null;
  }

  invalidate(): void {
    this.memory = null;
    this.loaded = false;
  }

  async get(refresh = false): Promise<T[]> {
    if (refresh) return this.fetchNow();
    if (!this.memory && !this.loaded) {
      this.loading ??= this.read().then((entry) => {
        this.memory ??= entry;
        this.loaded = true;
        this.loading = null;
      });
      await this.loading;
    }
    if (this.memory) {
      if (!this.fresh(this.memory.fetchedAt)) this.revalidate();
      return this.memory.items;
    }
    // Nothing cached: wait for the network, unless it just failed (then fail fast until the backoff ends).
    if (this.failure && !this.backoffOver()) throw this.failure.error;
    return this.fetchNow();
  }

  private fresh(fetchedAt: number): boolean {
    const age = this.options.now() - fetchedAt;
    return age >= 0 && age < this.options.maxAgeMs;
  }

  private backoffOver(): boolean {
    return !this.failure || this.options.now() - this.failure.at >= REFRESH_FAILURE_BACKOFF_MS;
  }

  private fetchNow(): Promise<T[]> {
    this.foreground ??= this.options
      .fetch({ retry: true })
      .then(
        (items) => this.store(items),
        (error: unknown) => {
          this.failure = { at: this.options.now(), error };
          // Offline or OpenRouter down: a stale copy beats nothing.
          if (this.memory) return this.memory.items;
          throw error;
        },
      )
      .finally(() => {
        this.foreground = null;
      });
    return this.foreground;
  }

  /** Background refresh: one attempt, not while another runs or a recent one failed. */
  private revalidate(): void {
    if (this.background || this.foreground || !this.backoffOver()) return;
    this.background = this.options
      .fetch({ retry: false })
      .then(
        (items) => {
          this.store(items);
        },
        (error: unknown) => {
          this.failure = { at: this.options.now(), error };
        },
      )
      .finally(() => {
        this.background = null;
      });
  }

  /** Keeps a fresh list; the IndexedDB write is not awaited, and other tabs are told once it is stored. */
  private store(items: T[]): T[] {
    this.memory = { fetchedAt: this.options.now(), items };
    this.failure = null;
    void this.write(this.memory).then(() => this.options.onRefreshed?.());
    return items;
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

  function dropMemory(): void {
    catalog.invalidate();
    images.invalidate();
    videos.invalidate();
    endpointCaches.clear();
    normalized = null;
  }

  /**
   * Another tab refreshed: drop memory copies so the next read loads its result from IndexedDB. Data reset (any
   * tab): drop them too, so nothing deleted from IndexedDB lives on here and `lastRefreshed()` is null.
   */
  function listen(): void {
    if (listening) return;
    listening = true;
    core.bus.on('models-refreshed', () => {
      if (!emitting) dropMemory();
    });
    core.bus.on('data-reset', dropMemory);
  }

  const catalog = new ListCache<RawModel>({
    key: KV_CATALOG,
    field: 'models',
    fetch: (opts) => core.api.catalog.models({ output_modalities: 'all' }, opts),
    now,
    maxAgeMs,
    onRefreshed: announce,
  });
  const images = new ListCache<RawImageModel>({
    key: KV_IMAGE_MODELS,
    field: 'models',
    fetch: (opts) => core.api.catalog.imageModels(opts),
    now,
    maxAgeMs,
    onRefreshed: announce,
  });
  const videos = new ListCache<RawVideoModel>({
    key: KV_VIDEO_MODELS,
    field: 'models',
    fetch: (opts) => core.api.catalog.videoModels(opts),
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
        fetch: (opts) => core.api.catalog.modelEndpoints(modelId, opts),
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
        // Endpoint prices only: the catalog shows the cheapest endpoint, which would underestimate (§0).
        const endpoints = await endpointsCache(input.model)
          .get()
          .catch((): RawModelEndpoint[] => []);
        const speech: { model: string; characters: number; bytes?: number } = {
          model: input.model,
          characters: input.characters,
        };
        if (input.bytes !== undefined) speech.bytes = input.bytes;
        return estimateSpeech(speech, endpoints);
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
      listen();
      return endpointsCache(modelId).get();
    },

    async estimate(input) {
      listen();
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
      listen();
      return catalog.fetchedAt;
    },
  };
}
