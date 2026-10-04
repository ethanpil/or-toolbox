/**
 * ORtoolbox core contract.
 *
 * These interfaces are the boundary between the core library (src/core), the shell (src/ui) and the
 * tools (src/tools). Implementations live in their own modules; everything outside src/core codes
 * against these types only. Change a signature here only together with every implementation and caller.
 *
 * Rules that the types cannot express are written as doc comments — they are part of the contract.
 */

import type {
  ChatRequest,
  ChatResponse,
  ChatStreamEvent,
  ChatStreamResult,
  DecisionRequest,
  DecisionResponse,
  ImageRequest,
  ImageResult,
  GeneratedImage,
  SpeechRequest,
  SpeechResult,
  TranscriptionRequest,
  TranscriptionResult,
  VideoRequest,
  VideoJobStatus,
  KeyStatusResponse,
  CreditsResponse,
  RawModel,
  RawModelEndpoint,
  RawImageModel,
  RawVideoModel,
} from './api/types';
import type { Capability, ToolCategory, ToolId, ToolManifest } from '../tools/types';
import type { ImageModelControls } from './models/image-params';

// ---------------------------------------------------------------------------------------------
// Identifiers (defined with their runtime constants in src/tools/types.ts)
// ---------------------------------------------------------------------------------------------

export type { Capability, ToolCategory, ToolId, ToolManifest };

// ---------------------------------------------------------------------------------------------
// Settings (localStorage `ortoolbox:settings`; never contains secrets)
// ---------------------------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system';
export type BudgetMode = 'disabled' | 'warn' | 'hard';

export interface ToolBinding {
  /** Pinned key id; absent → default key. */
  keyId?: string;
  /** Pinned model id; absent → capability default. */
  model?: string;
  /** The tool's saved option values (merged over manifest.defaults). JSON-safe. */
  options?: Record<string, unknown>;
}

export interface BudgetSettings {
  mode: BudgetMode;
  /** A single run estimated above this asks for confirmation in `warn` and `hard` modes. Default 0.10. */
  perRunUsd: number;
  /** App-wide limit for the current UTC month; null = none. */
  monthlyUsd: number | null;
  /** Per-key monthly limits by key id; missing/null = none. */
  perKeyMonthlyUsd: Record<string, number | null>;
}

export interface Settings {
  /** Schema version; migrations run at page start. */
  version: number;
  onboarding: { completed: boolean };
  /** Tools pinned on Home (onboarding asks for three). */
  favouriteTools: ToolId[];
  defaultKeyId: string | null;
  /** User overrides of the shipped default model per capability. */
  defaultModels: Partial<Record<Capability, string>>;
  /** Global free-only switch. Off by default. */
  freeOnly: boolean;
  tools: Partial<Record<ToolId, ToolBinding>>;
  budgets: BudgetSettings;
  appearance: {
    theme: ThemeMode;
    /** Hex colour overriding the primary colour, or null for the shipped one. */
    accent: string | null;
    density: 'comfortable' | 'compact';
    reducedMotion: boolean;
  };
  data: {
    /** History and Recent prompts older than this are pruned. Saved prompts and starred runs never are. Default 90. */
    retentionDays: number;
    /** "Record recent prompts" switch. Default true. */
    recordRecentPrompts: boolean;
  };
  security: {
    /**
     * Auto-lock after this many minutes without activity when the passphrase lock is on. Default 15; 0 = never
     * (the unlocked key still ends with the tab session); at most 1440.
     */
    autoLockMinutes: number;
  };
  models: {
    favourites: string[];
    /** Most recent first, capped at 20. */
    recent: string[];
  };
  /** Small persistent UI state, keys namespaced like `home.view` or `tool.chat.sidebar`. */
  ui: Record<string, unknown>;
}

export interface SettingsService {
  /** Current settings (frozen snapshot; read synchronously at page start). */
  get(): Readonly<Settings>;
  /** Mutate a draft; the result is validated, persisted, and broadcast to other tabs. */
  update(mutate: (draft: Settings) => void): Readonly<Settings>;
  /** Replace with shipped defaults (keys are not affected). */
  reset(): void;
  /** Fires after local updates and after changes made in other tabs. */
  subscribe(fn: (next: Readonly<Settings>, prev: Readonly<Settings>) => void): () => void;
  /** manifest.defaults merged with the user's saved options for that tool. */
  toolOptions<T extends Record<string, unknown> = Record<string, unknown>>(tool: ToolManifest): T;
  setToolOptions(tool: ToolId, options: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------------------------
// Keys (localStorage `ortoolbox:keys`, separate from settings so settings exports never hold secrets)
// ---------------------------------------------------------------------------------------------

/** Base64 AES-GCM payload. */
export interface EncryptedBlob {
  iv: string;
  ct: string;
}

export interface StoredKey {
  id: string;
  name: string;
  colour: string | null;
  /** e.g. `sk-or-…a1b2` — safe to display and export. */
  masked: string;
  source: 'pasted' | 'oauth';
  createdAt: number;
  /** Prefer providers that do not retain data (`provider.data_collection: "deny"`). Excludes free models. */
  noRetention: boolean;
  /** Plain secret when the lock is off; null when locked storage is in use. */
  secret: string | null;
  /** Encrypted secret when the lock is on; null otherwise. */
  enc: EncryptedBlob | null;
}

/** Exact JSON stored under `ortoolbox:keys`. */
export interface StoredKeysFile {
  version: 1;
  keys: StoredKey[];
  /** Present when the passphrase lock is enabled; then every key uses `enc`. */
  lock: { salt: string; iterations: number; verifier: EncryptedBlob } | null;
}

export type KeyInfo = Omit<StoredKey, 'secret' | 'enc'> & { isDefault: boolean };

export interface KeyStatus {
  /** OpenRouter's masked label for the key. */
  label: string | null;
  usageUsd: number;
  usageMonthlyUsd: number | null;
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  limitReset: string | null;
  isFreeTier: boolean;
  /** Account free-model counter; may lag (see docs/openrouter-api.md §10). */
  freeDaily: { used: number; limit: number; remaining: number } | null;
  fetchedAt: number;
}

export interface KeyLock {
  enabled(): boolean;
  /** True when the lock is off, or on and unlocked in this tab session. */
  unlocked(): boolean;
  enable(passphrase: string): Promise<void>;
  disable(passphrase: string): Promise<void>;
  /** Returns false on a wrong passphrase. Unlocked material lives in sessionStorage only. */
  unlock(passphrase: string): Promise<boolean>;
  lockNow(): void;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void>;
  /** Record user activity for the auto-lock timer. */
  touch(): void;
}

export interface KeysService {
  list(): KeyInfo[];
  get(id: string): KeyInfo | undefined;
  /** Validates the secret's format (not its liveness), stores it, makes it default if it is the first key. */
  add(input: {
    name: string;
    secret: string;
    colour?: string | null;
    source?: 'pasted' | 'oauth';
  }): Promise<KeyInfo>;
  update(id: string, patch: Partial<Pick<StoredKey, 'name' | 'colour' | 'noRetention'>>): void;
  remove(id: string): void;
  setDefault(id: string): void;
  /** Key for a tool: explicit override → tool binding → default key → null. */
  resolve(tool?: ToolId, overrideKeyId?: string): KeyInfo | null;
  /** The secret, for the API client only. Throws KeyLockedError when locked. Never log or display it. */
  secret(id: string): Promise<string>;
  /** `GET /key`, cached for 60 s unless `force`. */
  status(id: string, opts?: { force?: boolean }): Promise<KeyStatus>;
  readonly lock: KeyLock;
  subscribe(fn: () => void): () => void;
  /**
   * Backup, and Settings' Undo of a key removal: the validated keys file exactly as stored (secrets plain or
   * encrypted, as configured).
   */
  exportFile(): StoredKeysFile;
  /**
   * Backup, and Settings' Undo of a key removal: replace the whole keys file. Validates `next`; refuses with KeysChangedError when the stored file
   * no longer equals `expected` (another tab wrote meanwhile); drops this tab's unlocked session when the lock
   * changes; broadcasts `keys-changed`.
   */
  replaceFile(next: StoredKeysFile, opts?: { expected?: StoredKeysFile }): void;
  /** Data reset only: remove every key, the lock and this tab's unlocked session. */
  clear(): void;
}

export interface OAuthService {
  /** Builds the PKCE challenge, stores the verifier in sessionStorage, and navigates to openrouter.ai/auth. */
  start(opts?: { keyLabel?: string; returnTo?: string }): Promise<void>;
  /** Called on /auth/callback/: exchanges `code` for a key, stores it, returns it with the saved returnTo path. */
  complete(params: URLSearchParams): Promise<{ key: KeyInfo; returnTo: string | null }>;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

export interface ModelPricing {
  /** USD per prompt token (text models). null when the catalog gives "-1" or a non-token unit. */
  prompt: number | null;
  completion: number | null;
  /** USD per input image, when listed. */
  image: number | null;
  /** USD per request, when listed. */
  request: number | null;
  /** Original string-valued pricing object from the catalog. */
  raw: Record<string, unknown>;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** Text before the slash, e.g. `openai`. */
  author: string;
  description: string;
  created: number;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  supportedVoices: string[] | null;
  pricing: ModelPricing;
  /** True only for ids ending in `:free` (and the `openrouter/free` router). A zero price is NOT free. */
  isFree: boolean;
  expirationDate: string | null;
  /** Derived capabilities this model can serve. */
  capabilities: Capability[];
  raw: RawModel;
}

export interface ResolvedModel {
  /** null when nothing usable exists (e.g. free-only mode and no free model for this capability). */
  model: string | null;
  source: 'run' | 'tool' | 'capability' | 'shipped' | 'none';
  /** Human-readable note when free-only mode changed or blocked the choice. */
  note: string | null;
}

export type ImageControlsResult =
  | { status: 'ready'; controls: ImageModelControls }
  | { status: 'unknown'; controls: ImageModelControls }
  | { status: 'missing' };

export interface ModelsService {
  /** Cached catalog (IndexedDB), refreshed when older than 24 h or on `refresh`. Works offline from cache. */
  list(opts?: { refresh?: boolean }): Promise<ModelInfo[]>;
  get(id: string): Promise<ModelInfo | undefined>;
  /** Models able to serve a capability; filtered to free models when free-only mode is on. */
  forCapability(cap: Capability): Promise<ModelInfo[]>;
  /** Sync check by id. */
  isFree(id: string): boolean;
  /** Shipped defaults: cheap and fast paid model, and the best free model or null. */
  shippedDefault(cap: Capability): { paid: string; free: string | null };
  /**
   * Cascade: run override → tool binding → user capability default → shipped default; free-only applied. The run
   * override and the tool binding apply only to the tool's primary capability (`manifest.capabilities[0]`);
   * other capabilities start at their capability default.
   */
  resolve(tool: ToolId, cap: Capability, runOverride?: string): ResolvedModel;
  /** `GET /images/models` (cached like the catalog). */
  imageModels(opts?: { refresh?: boolean }): Promise<RawImageModel[]>;
  /**
   * What an image model takes, with ONE policy for every image tool: `ready` (from `GET /images/models`);
   * `missing` (the list was read and does not have it: refuse before the run); `unknown` (the list could not be
   * read or is empty: let the request try with `controls` = bare controls, the prompt only). A failed read is
   * tried again on a call after `IMAGE_CONTROLS_RETRY_MS`, and after `models-refreshed`.
   */
  imageControls(modelId: string): Promise<ImageControlsResult>;
  /** `GET /videos/models` (cached like the catalog). */
  videoModels(opts?: { refresh?: boolean }): Promise<RawVideoModel[]>;
  /** Per-provider endpoints for a model (`GET /models/{id}/endpoints`, cached). */
  endpoints(modelId: string): Promise<RawModelEndpoint[]>;
  /**
   * Pre-run cost estimate in USD, or null when it cannot be estimated. Conservative by design: TTS uses the
   * highest endpoint price (routing is not controllable and the catalog shows only the cheapest), music uses
   * the flat per-song price, video uses `/videos/models` pricing for the chosen duration/resolution.
   */
  estimate(input: EstimateInput): Promise<number | null>;
  lastRefreshed(): number | null;
}

export type EstimateInput =
  | { kind: 'tokens'; model: string; promptTokens: number; completionTokens: number }
  | {
      kind: 'speech';
      model: string;
      characters: number;
      /** UTF-8 byte length of the input; Fish Audio bills per byte. Assumed 4 per character when absent. */
      bytes?: number;
    }
  | { kind: 'transcription'; model: string; seconds: number }
  | {
      kind: 'image';
      model: string;
      images: number;
      width?: number;
      height?: number;
      /** Reference images sent with each request. */
      references?: number;
      /** Requests that send them (one with `n`, or one per image); default 1. */
      requests?: number;
    }
  | {
      kind: 'video';
      model: string;
      seconds: number;
      resolution?: string;
      aspectRatio?: string;
      withAudio?: boolean;
      /** Images sent with the request (frames and references), for per-image input charges. */
      images?: number;
    }
  | { kind: 'music'; model: string }
  | { kind: 'decision'; model: string; inputTokens: number };

// ---------------------------------------------------------------------------------------------
// Usage, runs and the API client
// ---------------------------------------------------------------------------------------------

/** One billed request as seen by the client. */
export interface Usage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens?: number;
  /** `usage.cost` from the response (0 on free models), or the client's estimate when `costEstimated`. */
  costUsd: number;
  /** True when the cost was estimated from catalog pricing because the response carries none (TTS, video content). */
  costEstimated: boolean;
  /**
   * True when no cost could be determined at all (no `usage` in the response and no estimate). `costUsd` is then
   * 0, and the run books its pre-run reservation instead (see `RunRecord.reservedUsd`), so unknown never means free.
   */
  costUnknown?: boolean;
  latencyMs: number;
  generationId?: string;
}

export interface ModelUsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMsTotal: number;
}

export interface UsageTotals extends ModelUsageTotals {
  costEstimated: boolean;
  /** Sticky: some request's cost was unknown (see `Usage.costUnknown`). */
  costUnknown: boolean;
  byModel: Record<string, ModelUsageTotals>;
}

export type RunStatus = 'running' | 'ok' | 'error' | 'aborted';

/**
 * Something a run pays for besides its models' tokens, e.g. OpenRouter's Mistral OCR PDF parser (billed per page,
 * even on a free model). Free-only mode refuses a run with a paid add-on, budgets add its estimate, and a run on
 * free models stops counting as free. `estimateUsd` 0 means free; null means the price is unknown (treated as
 * paid). `pdfEngineAddon()` (src/core/models/pdf-engines.ts) builds the PDF parser's.
 */
export interface RunAddon {
  /** Stable id, e.g. `pdf-engine:mistral-ocr`. */
  id: string;
  /** Named in messages, e.g. "Mistral OCR PDF parser (12 pages)". */
  label: string;
  estimateUsd: number | null;
}

export interface RunSpec {
  tool: ToolId;
  /** Primary model (shown in history). */
  model: string;
  /** Every model the run may call (arena, bot-to-bot). Free-only mode checks all of them. Defaults to [model]. */
  models?: string[];
  /** Overrides the key resolved from the tool binding / default key. */
  keyId?: string;
  /**
   * Pre-run estimate of the models' cost for budget checks; null/undefined = unknown (per-run threshold is then
   * not applied). Add-on estimates are added to it (never include them here).
   */
  estimateUsd?: number | null;
  /** Paid extras the run incurs (see `RunAddon`). */
  addons?: readonly RunAddon[];
  /** The user's main input text. Feeds Recent prompts (when recording is on) and history. */
  prompt?: string;
  /** JSON-safe snapshot of the tool's settings; restoring it must reproduce the form exactly. */
  settings?: Record<string, unknown>;
  /** Short label for history lists; defaults to an excerpt of `prompt`. */
  title?: string;
  /** Links parallel runs of one action (e.g. arena contenders). */
  groupId?: string;
}

/** `RunHandle.checkpoint`'s input: `output` may be a function, called only when the throttled write happens. */
export interface RunCheckpoint {
  output?: string | (() => string);
  meta?: Record<string, unknown>;
}

export interface RunResult {
  /** Text output only (transcript, OCR text, JSON, decision answers…). Never binary or data URLs. */
  output?: string;
  /** JSON-safe extra facts worth keeping, e.g. `{ videoJobIds: [...] }`. */
  meta?: Record<string, unknown>;
}

export interface RunHandle {
  readonly id: string;
  readonly tool: ToolId;
  readonly model: string;
  readonly keyId: string;
  /** Aborted by `abort()`, by the shell's Stop button, or on page unload. Pass to every call. */
  readonly signal: AbortSignal;
  abort(reason?: string): void;
  /** Called by the API client for every response; tools call it only for costs they estimate themselves. */
  addUsage(usage: Usage): void;
  readonly totals: UsageTotals;
  /** The job this run was handed off to (`handOff`), or null. A handed-off run is no longer the page's to lose. */
  readonly jobId: string | null;
  onUsage(fn: (totals: UsageTotals) => void): () => void;
  /** Persist partial text output during long runs (bot transcripts, batches). */
  /**
   * Persists partial output (throttled: at most one write per interval, the latest wins). Pass `output` as a
   * function to build long text only when a write actually happens; it is also read once more by `finish()`
   * when the result has no output of its own.
   */
  checkpoint(partial: RunCheckpoint): Promise<void>;
  finish(result?: RunResult): Promise<RunRecord>;
  /** AbortError → status 'aborted'; anything else → 'error' with a user-safe message. */
  fail(error: unknown): Promise<RunRecord>;
  /**
   * The run continues as a persisted job (video): from now on, page unload and aborts do not finalize it; the
   * job's completion handler calls `runs.reattach(id)` and finishes it. Call right after the job is queued.
   */
  handOff(jobId: string): void;
}

/** Asked by `runs.begin` when a budget rule wants confirmation; the shell registers a modal implementation. */
export type BudgetConfirmHandler = (check: BudgetCheck, spec: RunSpec) => Promise<boolean>;

export interface RunsService {
  /**
   * Gatekeeper for every model call. In order: resolve key (NoKeyError), ensure unlocked (KeyLockedError),
   * free-only check on all models (FreeOnlyError), budget check against finished spend PLUS the reservations of
   * running runs in every tab (BudgetBlockedError, or confirm → RunCancelledError when declined), then create a
   * `running` record holding `reservedUsd = estimateUsd ?? 0`, add the prompt to Recent, and return the handle.
   * History/prompt write failures must not block the run (storage full is not a reason to refuse a model call).
   */
  begin(spec: RunSpec): Promise<RunHandle>;
  /** Re-attach to a persisted run after a reload (video jobs). Null when the run is unknown or already final. */
  reattach(runId: string): Promise<RunHandle | null>;
  setConfirmHandler(fn: BudgetConfirmHandler): void;
  /** Runs started in this page that have not finished (including handed-off ones; see `RunHandle.jobId`). */
  active(): RunHandle[];
  /**
   * Finalize orphaned runs: `running` records whose page is gone (no live owner lock) and that were not handed
   * off to an open job become `aborted`, booking their checkpointed usage (or reservation) to stats. Called at
   * page start by boot(). Idempotent and safe to run in several tabs at once.
   */
  sweep(): Promise<number>;
}

export interface CallOptions {
  run: RunHandle;
  /** Defaults to run.signal. */
  signal?: AbortSignal;
  /** Retries on 429/5xx/network with backoff, honouring `error.metadata.retry_after_seconds`. Default true (never after a stream's first byte). */
  retry?: boolean;
}

/**
 * The only module that talks to openrouter.ai. Adds auth and attribution headers, retries, throttles `:free`
 * models to 20 requests/minute client-side, maps errors to ApiError, and reports usage to `opts.run` on every
 * response (including errors that carry usage).
 */
export interface ApiClient {
  chat(body: ChatRequest, opts: CallOptions): Promise<ChatResponse>;
  chatStream(
    body: ChatRequest,
    opts: CallOptions & { onEvent: (event: ChatStreamEvent) => void },
  ): Promise<ChatStreamResult>;
  /** `POST /images`; `onPartial` receives streamed partial images where the provider streams. */
  images(
    body: ImageRequest,
    opts: CallOptions & { onPartial?: (image: GeneratedImage) => void },
  ): Promise<ImageResult>;
  speech(body: SpeechRequest, opts: CallOptions): Promise<SpeechResult>;
  transcribe(body: TranscriptionRequest, opts: CallOptions): Promise<TranscriptionResult>;
  decide(body: DecisionRequest, opts: CallOptions): Promise<DecisionResponse>;
  videos: {
    submit(body: VideoRequest, opts: CallOptions): Promise<VideoJobStatus>;
    /** Status read; takes a key id instead of a run so polling can resume after a reload. */
    status(jobId: string, opts: { keyId: string; signal?: AbortSignal }): Promise<VideoJobStatus>;
    /** Downloads the finished clip through the authenticated content endpoint. */
    content(
      jobId: string,
      opts: { keyId: string; signal?: AbortSignal; index?: number },
    ): Promise<Blob>;
  };
  /** Keyless catalog reads (used by ModelsService). */
  catalog: {
    /** `retry: false` for background refreshes (one attempt, no backoff). */
    models(params?: Record<string, string>, opts?: { retry?: boolean }): Promise<RawModel[]>;
    modelEndpoints(modelId: string, opts?: { retry?: boolean }): Promise<RawModelEndpoint[]>;
    imageModels(opts?: { retry?: boolean }): Promise<RawImageModel[]>;
    videoModels(opts?: { retry?: boolean }): Promise<RawVideoModel[]>;
  };
  /** Account reads with an explicit secret (used by KeysService and OAuth). */
  account: {
    key(secret: string, signal?: AbortSignal): Promise<KeyStatusResponse>;
    credits(secret: string, signal?: AbortSignal): Promise<CreditsResponse | null>;
    exchangeAuthCode(input: {
      code: string;
      codeVerifier: string;
      codeChallengeMethod: 'S256';
    }): Promise<{ key: string }>;
  };
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

export interface BudgetReason {
  kind: 'per-run' | 'monthly' | 'key-monthly';
  limitUsd: number;
  /** Spend this period + estimate (or the estimate alone for per-run). */
  projectedUsd: number;
  message: string;
}

export interface BudgetCheck {
  verdict: 'ok' | 'confirm' | 'block';
  reasons: BudgetReason[];
}

export interface BudgetsService {
  /**
   * disabled → ok. warn → confirm when any rule is exceeded. hard → block when a monthly rule is exceeded,
   * confirm when only the per-run threshold is exceeded. Spend comes from local stats (current UTC month).
   */
  check(input: { keyId: string; estimateUsd: number | null }): Promise<BudgetCheck>;
}

// ---------------------------------------------------------------------------------------------
// History (IndexedDB `runs`; text only)
// ---------------------------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  tool: ToolId;
  status: RunStatus;
  model: string;
  models: string[];
  keyId: string;
  /** Key alias at run time (kept even if the key is later deleted). */
  keyName: string;
  startedAt: number;
  finishedAt: number | null;
  latencyMs: number | null;
  title: string;
  prompt: string | null;
  settings: Record<string, unknown> | null;
  /** Text output, capped at 500 000 characters. */
  output: string | null;
  error: string | null;
  usage: UsageTotals;
  /**
   * The pre-run estimate held against budgets while the run is `running` (0 when unknown). When the run is
   * final and its cost was unknown, `max(usage.costUsd, reservedUsd)` is what stats book.
   */
  reservedUsd: number;
  /** Job id after `handOff()`; such runs are finalized by the job, never by unload or the sweep. */
  jobId: string | null;
  meta: Record<string, unknown>;
  starred: boolean;
  groupId: string | null;
}

export interface HistoryQuery {
  tool?: ToolId;
  status?: RunStatus;
  starred?: boolean;
  model?: string;
  keyId?: string;
  /** Case-insensitive match on title, prompt, output and model. */
  text?: string;
  from?: number;
  to?: number;
  /** Pagination cursor: only runs that started before this timestamp. */
  before?: number;
  /** Default 50. */
  limit?: number;
}

export interface HistoryService {
  /** Newest first. */
  query(q?: HistoryQuery): Promise<RunRecord[]>;
  get(id: string): Promise<RunRecord | undefined>;
  setStarred(id: string, starred: boolean): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /**
   * Puts runs back that `remove` deleted (Undo); an existing id is overwritten. A run removed while `running`
   * comes back `aborted` (with `finishedAt`), never running. Stats are never touched.
   */
  restore(runs: RunRecord[]): Promise<void>;
  /** Removes all runs, or all runs of one tool; returns how many were removed. */
  clear(scope?: { tool?: ToolId }): Promise<number>;
  count(scope?: { tool?: ToolId }): Promise<number>;
  exportJson(ids?: string[]): Promise<Blob>;
  /** Applies the retention setting (starred runs are kept). Called at page start, at most daily. */
  prune(): Promise<number>;
  subscribe(fn: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Prompts (IndexedDB `prompts`)
// ---------------------------------------------------------------------------------------------

export interface PromptEntry {
  id: string;
  tool: ToolId;
  kind: 'recent' | 'saved';
  name: string | null;
  text: string;
  /** The tool's settings at the time; "Use" restores them. JSON-safe. */
  settings: Record<string, unknown>;
  createdAt: number;
  usedAt: number;
}

export interface PromptsService {
  /** Newest (by usedAt) first. */
  list(tool: ToolId, kind: 'recent' | 'saved'): Promise<PromptEntry[]>;
  /** No-op (null) when recording is off or the text is blank. Same text moves to the top instead of duplicating. Capped at 50 per tool. */
  addRecent(
    tool: ToolId,
    text: string,
    settings: Record<string, unknown>,
  ): Promise<PromptEntry | null>;
  save(input: {
    tool: ToolId;
    text: string;
    settings: Record<string, unknown>;
    name?: string | null;
  }): Promise<PromptEntry>;
  /** Copy a Recent entry into Saved. */
  saveFromRecent(recentId: string, name?: string | null): Promise<PromptEntry>;
  rename(id: string, name: string | null): Promise<void>;
  /** Marks an entry used (updates usedAt). */
  touch(id: string): Promise<void>;
  /** Returns what was removed so the caller can offer Undo via `restore`. */
  remove(ids: string[]): Promise<PromptEntry[]>;
  clear(tool: ToolId | 'all', kind: 'recent' | 'saved' | 'all'): Promise<PromptEntry[]>;
  restore(entries: PromptEntry[]): Promise<void>;
  counts(): Promise<Partial<Record<ToolId, { recent: number; saved: number }>>>;
  /** Fires on local and cross-tab changes. */
  subscribe(fn: (tool: ToolId | 'all') => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Jobs (IndexedDB `jobs`) — persistent polling for long-running remote work
// ---------------------------------------------------------------------------------------------

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface JobRecord<P = unknown, R = unknown> {
  id: string;
  tool: ToolId;
  /** Handler type, e.g. `video`. */
  type: string;
  state: JobState;
  runId: string | null;
  keyId: string;
  /** Remote id (e.g. OpenRouter video job id). */
  remoteId: string | null;
  /** Groups jobs of one sequence. */
  groupId: string | null;
  payload: P;
  result: R | null;
  progress: number | null;
  remoteStatus: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  /** Only on tombstones passed to `JobsService.subscribe` for removed jobs; never stored. */
  removed?: true;
}

export type JobPollResult<R> =
  | { state: 'running'; progress?: number | null; remoteStatus?: string }
  | { state: 'succeeded'; result: R }
  | { state: 'failed'; error: string };

export interface JobHandler<P = unknown, R = unknown> {
  poll(job: JobRecord<P, R>, signal: AbortSignal): Promise<JobPollResult<R>>;
  /** Poll interval; default 5000 ms with gentle backoff on errors. */
  intervalMs?: number | ((job: JobRecord<P, R>) => number);
}

export interface JobsService {
  /** Register before `resume()`. */
  register<P, R>(type: string, handler: JobHandler<P, R>): void;
  add<P, R>(input: {
    tool: ToolId;
    type: string;
    payload: P;
    keyId: string;
    remoteId?: string | null;
    runId?: string | null;
    groupId?: string | null;
    state?: JobState;
  }): Promise<JobRecord<P, R>>;
  update<P, R>(
    id: string,
    patch: Partial<Omit<JobRecord<P, R>, 'id' | 'createdAt'>>,
  ): Promise<JobRecord<P, R>>;
  get<P, R>(id: string): Promise<JobRecord<P, R> | undefined>;
  list(filter?: { tool?: ToolId; groupId?: string; states?: JobState[] }): Promise<JobRecord[]>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Start polling every non-final job of a registered type. Only one tab polls a given job at a time. */
  resume(): void;
  /**
   * Fires on every change, local or from another tab. Shows a browser notification on completion when the page
   * is hidden and permission was granted. A removed job (`remove()`, data deletion or reset) is reported once as
   * a tombstone: the last record this tab saw with `state: 'cancelled'` and `removed: true` (only `id`, `state`
   * and `removed` are guaranteed when the tab never saw the job).
   */
  subscribe(fn: (job: JobRecord) => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Stats (IndexedDB `stats` daily rollups; survive history pruning)
// ---------------------------------------------------------------------------------------------

export interface StatsRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  tool: ToolId;
  model: string;
  keyId: string;
  free: boolean;
  /**
   * Runs whose primary model (`RunRecord.model`) this is. A run that called several models counts once, on its
   * primary one, so the sum over rows is the number of runs; the other models only gain requests, tokens and cost.
   */
  runs: number;
  /** Failed runs, counted on the primary model like `runs`, so `errors / runs` is a real error rate. */
  errors: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  /**
   * The part of `costUsd` that is not what OpenRouter reported: costs estimated from catalog prices (the whole
   * run's cost when `usage.costEstimated`) plus reservations booked for unknown costs. Always <= `costUsd`.
   */
  estimatedUsd: number;
  latencyMsTotal: number;
}

export interface StatsService {
  /** Daily rows between two UTC days inclusive; callers aggregate. */
  rows(range: { from: string; to: string }): Promise<StatsRow[]>;
  /** Spend in the current UTC month, optionally for one key. */
  monthSpend(opts?: { keyId?: string }): Promise<number>;
  /** Requests made to `:free` models today (UTC), counted locally. */
  freeRequestsToday(): Promise<number>;
  /** `runs` counts runs whose primary model this is (see `StatsRow.runs`). */
  modelSummary(
    model: string,
  ): Promise<{ runs: number; avgLatencyMs: number | null; costUsd: number }>;
  subscribe(fn: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Session results — in-memory binaries and the leave-page guard
// ---------------------------------------------------------------------------------------------

export type ResultKind = 'image' | 'audio' | 'video' | 'file';

export interface SessionResult {
  id: string;
  tool: ToolId;
  kind: ResultKind;
  /** Suggested download filename. */
  name: string;
  blob: Blob;
  downloaded: boolean;
  createdAt: number;
}

export interface ResultsService {
  add(input: { tool: ToolId; kind: ResultKind; name: string; blob: Blob }): SessionResult;
  /** Triggers a browser download and marks it downloaded. */
  download(id: string): void;
  markDownloaded(id: string): void;
  /** Discard without downloading (user deleted it). Revokes any object URL created through `objectUrl`. */
  remove(id: string): void;
  /** Cached object URL for display; revoked on remove. */
  objectUrl(id: string): string;
  pending(): SessionResult[];
  /** e.g. "3 images and 1 video not downloaded", or null when nothing is pending. */
  summary(): string | null;
  /** Downloads every pending result (one ZIP when more than one). */
  downloadAll(): Promise<void>;
  /**
   * Marks unsaved in-memory work that is not a downloadable result (a recording in progress, paid parts not
   * joined yet): leaving the page asks first, naming `description`. Returns the release (idempotent).
   */
  hold(description: string): () => void;
  /** Descriptions of the work held now, oldest first. */
  holds(): string[];
  /** Drops every hold (the user chose to leave anyway). */
  releaseHolds(): void;
  subscribe(fn: () => void): () => void;
}

// ---------------------------------------------------------------------------------------------
// Per-tool persistent state (IndexedDB `kv`), e.g. video sequences, saved deciders, chat threads
// ---------------------------------------------------------------------------------------------

export interface ToolStateStore {
  get<T>(key: string): Promise<T | undefined>;
  /** JSON-safe values only; never binaries. */
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------
// Backup / data management
// ---------------------------------------------------------------------------------------------

export interface BackupPreview {
  createdAt: number;
  appVersion: string;
  scope: 'all' | 'settings';
  keysIncluded: boolean;
  keysEncrypted: boolean;
  counts: {
    keys: number;
    runs: number;
    prompts: number;
    jobs: number;
    toolState: number;
    statsRows: number;
  };
  /** Human-readable list of what an import would change, e.g. "Replace 3 keys", "Add 120 runs". */
  changes: string[];
}

export type BackupExportOptions =
  | { scope: 'all' | 'settings'; includeKeys: false }
  | { scope: 'all' | 'settings'; includeKeys: true; passphrase: string };

export interface BackupService {
  /** A `.ortoolbox.json` file. Keys are excluded unless opted in, and then always passphrase-encrypted. */
  export(opts: BackupExportOptions): Promise<Blob>;
  inspect(
    file: Blob,
    opts: { mode: 'merge' | 'replace'; passphrase?: string },
  ): Promise<BackupPreview>;
  import(
    file: Blob,
    opts: { mode: 'merge' | 'replace'; passphrase?: string },
  ): Promise<BackupPreview>;
}

export interface DataService {
  storage(): Promise<{ usedBytes: number | null; quotaBytes: number | null }>;
  /** History + prompts for one tool. */
  deleteToolData(tool: ToolId): Promise<void>;
  /** All prompts, history, jobs and tool state; keys, settings and stats (the budget ledger) untouched. */
  deleteAllPromptsAndHistory(): Promise<void>;
  /** Everything, including keys and settings. */
  resetEverything(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Cross-tab bus (BroadcastChannel('ortoolbox') with `storage`-event fallback)
// ---------------------------------------------------------------------------------------------

export type BusEvent =
  | { type: 'settings-changed' }
  | { type: 'keys-changed' }
  | { type: 'history-changed'; ids?: string[] }
  | { type: 'prompts-changed'; tool: ToolId | 'all' }
  | { type: 'jobs-changed'; id: string }
  | { type: 'run-finished'; id: string; tool: ToolId; status: RunStatus }
  | { type: 'stats-changed' }
  | { type: 'models-refreshed' }
  | { type: 'data-reset' }
  /** A tool's state store wrote or deleted `key` (in this tab or another): re-read it if you show it. */
  | { type: 'tool-state-changed'; tool: ToolId; key: string };

export interface Bus {
  /** Delivers to listeners in this tab and in other tabs on the origin. */
  emit(event: BusEvent): void;
  on<T extends BusEvent['type']>(
    type: T,
    fn: (event: Extract<BusEvent, { type: T }>) => void,
  ): () => void;
}

// ---------------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------------

export interface CoreServices {
  bus: Bus;
  settings: SettingsService;
  keys: KeysService;
  oauth: OAuthService;
  models: ModelsService;
  api: ApiClient;
  budgets: BudgetsService;
  runs: RunsService;
  history: HistoryService;
  prompts: PromptsService;
  jobs: JobsService;
  stats: StatsService;
  results: ResultsService;
  backup: BackupService;
  data: DataService;
  /** Per-tool state store factory. */
  toolState(tool: ToolId): ToolStateStore;
}
