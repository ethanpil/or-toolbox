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
  RunHandle,
  RunSpec,
  SessionResult,
  ToolId,
  ToolManifest,
  ToolStateStore,
} from '../../core/types';

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
  /** Fills the form with a ready-to-run example (`?sample=1`, onboarding's "Try a sample"). */
  sample?(): void | Promise<void>;
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

export interface RunnerOptions {
  /** Button text, default "Run". */
  label?: string;
  /** Bootstrap Icons name, default `play-fill`. */
  icon?: string;
  /**
   * The work. `signal` aborts when the user presses Stop (pass it to `ctx.beginRun`, which links it to the run).
   * Throw to report failure; errors go through `presentError` with a Retry.
   */
  run: (signal: AbortSignal) => Promise<void>;
  /** Text after the button (e.g. a reason it is disabled); also its description. */
  hint?: string;
  /** Where the bar goes; default the end of `ui.input`. */
  container?: HTMLElement;
}

export interface Runner {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly stopButton: HTMLButtonElement;
  readonly busy: boolean;
  /** Same as pressing Run (ignored while busy or disabled). */
  trigger(): Promise<void>;
  stop(): void;
  /** Disables Run with a visible reason; null re-enables it (the framework also disables it when no model resolves). */
  setDisabled(reason: string | null): void;
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
  runner: (options: RunnerOptions) => Runner;
  /** The header's estimate badge: number, 0 (Free) or null (Unknown). */
  setEstimate: (usd: number | null, note?: string) => void;
  /** Short status text, announced politely (e.g. "Page 3 of 20"). Empty string clears it. */
  status: (text: string) => void;
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
   * The model for a capability (default: the primary one), through the cascade run override (`?model=`) → the
   * header's choice (tool binding) → capability default → shipped default, with free-only applied.
   */
  model: (capability?: Capability) => ResolvedModel;
  /** `?model=` from the URL ("re-run with another model"), or null. */
  readonly modelOverride: string | null;
  /**
   * `runs.begin` for this tool: fills `tool`, defaults `model` to `ctx.model().model`, `prompt`/`settings` to the
   * instance's `getState()`, and aborts the run when `signal` (the runner's) aborts.
   */
  beginRun: (
    spec: Omit<RunSpec, 'tool' | 'model'> & { model?: string; tool?: ToolId },
    signal?: AbortSignal,
  ) => Promise<RunHandle>;
}

export type ToolSetup = (ctx: ToolContext) => ToolInstance | Promise<ToolInstance>;
