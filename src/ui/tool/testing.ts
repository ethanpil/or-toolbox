/**
 * Test support for tools: a `ToolContext` without the page around it, over the fake core of
 * src/core/testing (real settings, runs, history, prompts, results… on fake IndexedDB; a one-key keys fake) and a
 * real models service fed from a stub catalog. Import only from `*.test.ts`, which must start with
 * `import 'fake-indexeddb/auto'`, and call `isolateChannels()` and `resetDb()` (src/core/testing/state-fakes) in
 * `beforeEach` like the core tests do.
 *
 * ```ts
 * const t = createToolTestContext(getTool('ocr'), { api: { chat: () => Promise.resolve(response) } });
 * const tool = await t.mount(setup);
 * const state = { prompt: 'Extract the totals', settings: { mode: 'math' } };
 * tool.applyState(state);
 * expect(tool.getState()).toEqual(state); // the round trip Prompts and History rely on
 * t.cleanup();
 * ```
 *
 * The context is built by the same `createToolContext` as the real page, so `beginRun`, `model()`, estimates
 * and options behave the same; the header, drawer and URL handling are not there.
 */
import type { RawModel } from '../../core/api/types';
import { createModelsService } from '../../core/models/models';
import { createTestCore, type KeyState } from '../../core/testing/state-fakes';
import type { ApiClient, CoreServices, ToolManifest } from '../../core/types';
import { h } from '../dom';
import { createToolContext } from './context';
import { badgeValue, createEstimateTracker } from './estimate';
import { resultHandle } from './results';
import { createRunner, type RunnerInternals } from './runner';
import type { SendItem, ToolContext, ToolInstance, ToolSetup, ToolUi } from './types';

export interface ToolTestOptions {
  /** Catalog entries the models service serves (`models.list/get/estimate`). Default: none. */
  catalog?: RawModel[];
  /** Replaces API client calls, e.g. `{ chatStream: … }`. Unlisted calls throw. */
  api?: Partial<ApiClient>;
  /** `?model=` for this visit. */
  modelOverride?: string | null;
  /** Start without any key (runs then fail with `no-key`). */
  noKey?: boolean;
}

export interface ToolTestContext {
  readonly ctx: ToolContext;
  readonly core: CoreServices;
  readonly keyState: KeyState;
  /** The zones `ctx.ui` exposes, attached to `document.body`. */
  readonly zones: { input: HTMLElement; output: HTMLElement; drawer: HTMLElement };
  /** Runners created through `ctx.ui.runner`, in order. */
  readonly runners: RunnerInternals[];
  /** Everything passed to `ctx.ui.sendTo`. */
  readonly sent: SendItem[][];
  /** The last value shown in the estimate badge, and the last status text. */
  estimate(): number | null | undefined;
  status(): string;
  /** Runs `setup(ctx)` and remembers the instance (beginRun and estimates read it). */
  mount(setup: ToolSetup): Promise<ToolInstance>;
  /** Removes the zones from the page. */
  cleanup(): void;
}

export function createToolTestContext(
  manifest: ToolManifest,
  options: ToolTestOptions = {},
): ToolTestContext {
  const { core, keyState } = createTestCore(options.noKey ? { keys: [] } : {});
  const unmocked = (name: string) => () => {
    throw new Error(`createToolTestContext: api.${name} was called but not provided`);
  };
  core.api = {
    chat: unmocked('chat'),
    chatStream: unmocked('chatStream'),
    images: unmocked('images'),
    speech: unmocked('speech'),
    transcribe: unmocked('transcribe'),
    decide: unmocked('decide'),
    videos: {
      submit: unmocked('videos.submit'),
      status: unmocked('videos.status'),
      content: unmocked('videos.content'),
    },
    catalog: {
      models: () => Promise.resolve(options.catalog ?? []),
      modelEndpoints: () => Promise.resolve([]),
      imageModels: () => Promise.resolve([]),
      videoModels: () => Promise.resolve([]),
    },
    account: {
      key: unmocked('account.key'),
      credits: unmocked('account.credits'),
      exchangeAuthCode: unmocked('account.exchangeAuthCode'),
    },
    ...options.api,
  };
  core.models = createModelsService(core);

  const input = h('div', { 'data-testid': 'tool-input' });
  const output = h('div', { 'data-testid': 'tool-output' });
  const drawer = h('div', { 'data-testid': 'tool-drawer' });
  const root = h('div', null, input, output, drawer);
  document.body.append(root);

  let instance: ToolInstance | null = null;
  let shownEstimate: number | null | undefined;
  let statusText = '';
  const runners: RunnerInternals[] = [];
  const sent: SendItem[][] = [];
  const modelOverride = options.modelOverride ?? null;

  const estimates = createEstimateTracker({
    compute: (model) => instance?.estimate?.(model) ?? null,
    model: () => ctx.model().model,
    show: (usd) => {
      shownEstimate = badgeValue(usd, instance?.addons?.() ?? []);
    },
  });

  const ui: ToolUi = {
    input,
    output,
    drawer,
    advanced: () => {
      const body = h('div');
      drawer.append(body);
      return body;
    },
    runner: (runnerOptions) => {
      const runner = createRunner(runnerOptions, runners.length === 0);
      runners.push(runner);
      (runnerOptions.container ?? input).append(runner.element);
      return runner;
    },
    refreshEstimate: () => estimates.refresh(),
    setEstimate: (usd, note) => estimates.set(usd, note),
    status: (text) => {
      statusText = text;
    },
    addResult: (result) => resultHandle(core, core.results.add({ tool: manifest.id, ...result })),
    sendTo: (items) => {
      sent.push(items);
    },
    openPrompts: () => undefined,
    openDrawer: () => undefined,
  };

  const ctx = createToolContext({
    core,
    manifest,
    ui,
    estimates,
    modelOverride: () => modelOverride,
    instance: () => instance,
  });

  return {
    ctx,
    core,
    keyState,
    zones: { input, output, drawer },
    runners,
    sent,
    estimate: () => shownEstimate,
    status: () => statusText,
    async mount(setup) {
      instance = await setup(ctx);
      await estimates.refresh();
      return instance;
    },
    cleanup() {
      root.remove();
    },
  };
}
