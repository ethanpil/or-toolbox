/**
 * The tool contract's code half (the manifest is the static half, src/tools/types.ts). A tool's main.ts calls
 * `mountTool(manifest, setup)`; `setup(ctx)` builds the tool into `ctx.ui` and returns a `ToolInstance`.
 * docs/tool-authoring.md explains every member with a worked example.
 */
import type {
  Capability,
  CoreServices,
  ResolvedModel,
  ResultKind,
  RunAddon,
  RunHandle,
  RunSpec,
  SessionResult,
  ToolId,
  ToolManifest,
  ToolStateStore,
} from '../../core/types';
import type { ToastAction } from '../feedback/toast';

/** What the Prompts panel saves and restores, and what History reopens. Must round-trip exactly. */
export interface ToolSnapshot {
  /** The main input text. */
  prompt: string;
  /** Every other setting of the form, JSON-safe. */
  settings: Record<string, unknown>;
}

/** Something handed from one tool to another ("Send to…"). Kept in memory only. */
export type SendItem =
  | { kind: 'text'; text: string; /** default `text/plain` */ type?: string; name?: string }
  | { kind: 'file'; blob: Blob; name: string };

export interface ToolInstance {
  /** The form as a snapshot (for Save current, Recent prompts and History). */
  getState(): ToolSnapshot;
  /** Restores a snapshot exactly (Use a prompt, `?run=`, `?prompt=`). Unknown settings keys are ignored. */
  applyState(state: ToolSnapshot): void;
  /** Files dropped or pasted anywhere on the page, already filtered by `manifest.accepts`. */
  onFiles?(files: File[]): void;
  /** Items sent from another tool ("Send to…"), filtered by `manifest.accepts`. */
  onReceive?(items: SendItem[]): void;
  /**
   * The tool has no main text field (it works on files and settings only): `getState().prompt` is always '', the
   * `tool-prompt` test id convention does not apply, and Prompts' "Save current" saves named settings presets.
   */
  promptless?: boolean;
  /** Fills the form with a ready-to-run example (`?sample=1`, onboarding's "Try a sample"). */
  sample?(): void | Promise<void>;
  /**
   * The cost of running the current input on `model`, in USD (usually `ctx.models.estimate(…)`), or null when it
   * cannot be estimated. The framework asks when the model changes and when the tool calls `ui.refreshEstimate()`,
   * shows the newest answer in the header and books it with `ctx.beginRun` when the spec has no `estimateUsd`.
   */
  estimate?(model: string): Promise<number | null>;
  /**
   * Paid extras the current input would incur besides the model (e.g. `pdfEngineAddon(engine, pages)` from
   * src/core/models/pdf-engines.ts). Keep them out of `estimate`: the framework adds them to the header badge and
   * passes them to `ctx.beginRun` (free-only refuses a paid one, budgets add them). Cheap and synchronous.
   */
  addons?(): readonly RunAddon[];
}

/** The tool's saved options: `manifest.defaults` merged with `settings.tools[id].options`. */
export interface ToolOptions<T extends Record<string, unknown> = Record<string, unknown>> {
  /** A fresh copy each call. */
  get(): T;
  /** Merges `patch` into the saved options and persists it. */
  set(patch: Partial<T>): void;
  /** Back to `manifest.defaults`. */
  reset(): void;
}

/**
 * `A` is what `trigger(arg)` hands to `run` (e.g. the item keys of a per-item Retry); a plain Run passes
 * nothing. The framework's Retry (after an error) replays the same argument.
 */
export interface RunnerOptions<A = unknown> {
  /** Button text, default "Run". */
  label?: string;
  /** Bootstrap Icons name, default `play-fill`. */
  icon?: string;
  /**
   * The work. `signal` aborts when the user presses Stop (pass it to `ctx.beginRun`, which links it to the run).
   * Throw to report failure; errors go through `presentError` with a Retry (see `safeAction` for a paid request that
   * may have gone through).
   */
  run: (signal: AbortSignal, arg?: A) => Promise<void>;
  /**
   * What the error toast's Retry replays, from the argument of the run that failed. Narrow it to the items still
   * without a result (`pendingOnly(isDone)`), so a Retry after a fatal error part-way never pays for finished
   * items again. Return null when nothing is left: Retry then does nothing and says so. Default: the same argument.
   */
  replayArg?: (arg: A | undefined) => A | undefined | null;
  /**
   * Offered in the error toast instead of Retry when a paid request may have gone through (`isOutcomeUnknown`):
   * a way to check without paying again, e.g. `{ label: 'Check status', onClick: refreshJobs }`. Default: a link
   * to OpenRouter's activity page. Retry is never offered then, unless `retryUnknownOutcome`.
   */
  safeAction?: ToastAction;
  /**
   * Keep the toast's Retry (still through `replayArg`) after an unknown outcome. Set it only when sending again
   * cannot pay twice, e.g. `run` first looks for the earlier request's result.
   */
  retryUnknownOutcome?: boolean;
  /** Text after the button (e.g. a reason it is disabled); also its description. */
  hint?: string;
  /** Where the bar goes; default the end of `ui.input`. */
  container?: HTMLElement;
}

/**
 * `Runner.trigger()`'s answer: settles when the run is over (errors are already reported, so it never rejects),
 * and says at once whether it started at all (false: busy or disabled, nothing happened).
 */
export type Triggered = Promise<void> & { readonly started: boolean };

/** What a runner's subscribers are told on every change. */
export interface RunnerState {
  readonly busy: boolean;
  /** Why Run cannot start (the framework's reason wins over the tool's), or null. */
  readonly disabledReason: string | null;
}

export interface Runner<A = unknown> {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly stopButton: HTMLButtonElement;
  readonly busy: boolean;
  /** Why Run cannot start right now, or null (busy is separate: see `busy`). */
  readonly disabledReason: string | null;
  /**
   * Same as pressing Run, with `arg` passed to `run` (and replayed by the error's Retry). `.started` is false when
   * it could not start (busy or disabled); the promise settles once the run is over.
   */
  trigger(arg?: A): Triggered;
  stop(): void;
  /** Disables Run with a visible reason; null re-enables it (the framework also disables it when no model resolves). */
  setDisabled(reason: string | null): void;
  /**
   * Calls `fn` now and on every change of `busy` or `disabledReason`; returns an unsubscribe function. Use it to
   * enable or disable a tool's own buttons that trigger this runner (per-item Retry).
   */
  subscribe(fn: (state: RunnerState) => void): () => void;
}

export interface ResultHandle {
  readonly result: SessionResult;
  /** A Download button that turns into "Downloaded" (still clickable) once saved. */
  button(label?: string): HTMLButtonElement;
  download(): void;
  remove(): void;
}

export interface AdvancedSection {
  /** The accordion body to fill. */
  readonly body: HTMLElement;
}

/** Members are function properties, so they can be passed around (`sendTo: ctx.ui.sendTo`). */
export interface ToolUi {
  /** Left zone (input). The runner bar is appended at its end. */
  readonly input: HTMLElement;
  /** Right zone (output). */
  readonly output: HTMLElement;
  /** Body of the Settings drawer (offcanvas). */
  readonly drawer: HTMLElement;
  /** An accordion section at the end of the drawer, for advanced options; returns its body. */
  advanced: (title: string) => HTMLElement;
  /** Creates the primary Run/Stop bar (the first runner also gets Ctrl/Cmd+Enter). */
  runner: <A = unknown>(options: RunnerOptions<A>) => Runner<A>;
  /** Recomputes the estimate through `ToolInstance.estimate` (call it when the input changes); resolves with it. */
  refreshEstimate: () => Promise<number | null>;
  /**
   * Sets the header's estimate badge directly: number, 0 (Free) or null (Unknown). Prefer `estimate` +
   * `refreshEstimate`; a value set here is what `beginRun` books until the next refresh.
   */
  setEstimate: (usd: number | null, note?: string) => void;
  /** A state change in the status line, announced politely ("Reading 3 pages…", "Done"). Empty string clears it. */
  status: (text: string) => void;
  /**
   * A ticking counter in the same line ("Composing… 12 s", "18 of 75 parts", "40%"): shown at once, announced at
   * most once every 10 s, so screen readers are not flooded. Use `status` for the start and the end of a phase.
   */
  progress: (text: string) => void;
  /**
   * Marks unsaved in-memory work that is not a downloadable result (a recording in progress, paid parts not
   * joined): leaving the page asks first, naming `description`. Call the returned function when the work is
   * saved or discarded (safe to call twice). Downloadable results use `addResult` instead.
   */
  holdWork: (description: string) => () => void;
  /** Registers a binary result with the leave guard and returns download helpers. */
  addResult: (input: { kind: ResultKind; name: string; blob: Blob }) => ResultHandle;
  /** Opens the "Send to…" chooser for these items (tools whose `accepts` match). */
  sendTo: (items: SendItem[]) => void;
  /** Opens the Prompts panel / Settings drawer (the header buttons do this too). */
  openPrompts: () => void;
  openDrawer: () => void;
}

export interface ToolContext extends CoreServices {
  readonly manifest: ToolManifest;
  /** Persistent JSON-safe state for this tool (IndexedDB `kv`): `core.toolState(manifest.id)`. */
  readonly state: ToolStateStore;
  readonly options: ToolOptions;
  readonly ui: ToolUi;
  /**
   * The model for a capability (default: the primary one). For the primary capability the cascade is run
   * override (`?model=`) → the header's choice (tool binding) → capability default → shipped default; any other
   * capability starts at its capability default (a text model pinned on Chat does not read images). Free-only
   * mode applies to both.
   */
  model: (capability?: Capability) => ResolvedModel;
  /** `?model=` from the URL ("re-run with another model"), or null. */
  readonly modelOverride: string | null;
  /**
   * `runs.begin` for this tool: fills `tool`, defaults `model` to `ctx.model().model`, `prompt`/`settings` to the
   * instance's `getState()`, `estimateUsd` to the framework's current estimate (recomputed first when stale),
   * `addons` to the instance's `addons()`, and aborts the run when `signal` (the runner's) aborts.
   *
   * It may refuse (no key, locked, free-only, budget, a declined confirmation) before anything is sent: call it
   * BEFORE changing any tool state (results, statuses, output), so a refused run leaves the page as it was.
   */
  beginRun: (
    spec: Omit<RunSpec, 'tool' | 'model'> & { model?: string; tool?: ToolId },
    signal?: AbortSignal,
  ) => Promise<RunHandle>;
}

export type ToolSetup = (ctx: ToolContext) => ToolInstance | Promise<ToolInstance>;
