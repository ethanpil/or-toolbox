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
 * await t.cleanup();                         // in afterEach: stops runs, waits for writes, leaves the bus
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
import { confirmDiscard } from './discard';
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
  /**
   * Waits, without stopping anything, until no run is going and the tool's tool-state reads and writes have landed
   * (a write queue's next write included). For a test that checks what was stored, or opens a second "tab".
   */
  settle(): Promise<void>;
  /**
   * Ends the test's tool: stops every runner, then `settle()`, then removes every bus listener added through this context
   * and the runners' Escape handlers, then removes the zones. Await it in `afterEach`, before the next test resets
   * the database, so nothing of this test lands in the next one.
   */
  cleanup(): Promise<void>;
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

  // What `cleanup` waits for and undoes: tool-state calls still in flight, and every bus listener added from here.
  const inFlight = new Set<Promise<unknown>>();
  const track = (value: unknown): unknown => {
    if (value instanceof Promise) {
      inFlight.add(value);
      value.then(
        () => inFlight.delete(value),
        () => inFlight.delete(value),
      );
    }
    return value;
  };
  const rawToolState = core.toolState.bind(core);
  core.toolState = (tool) =>
    new Proxy(rawToolState(tool), {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function'
          ? (...args: unknown[]) =>
              track((value as (...a: unknown[]) => unknown).apply(target, args))
          : value;
      },
    });
  const listeners: (() => void)[] = [];
  const rawOn = core.bus.on.bind(core.bus);
  core.bus.on = (type, fn) => {
    const off = rawOn(type, fn);
    listeners.push(off);
    return off;
  };

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
    progress: (text) => {
      statusText = text;
    },
    holdWork: (description) => core.results.hold(description),
    confirmDiscard,
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

  /**
   * Settled once no runner was busy and no tool-state call was in flight for two checks in a row (a write queue
   * starts its next write a moment after the one before ends); 5 s at most.
   */
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 5000;
    for (let quiet = 0; quiet < 2 && Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
        quiet = 0;
      } else if (runners.some((runner) => runner.busy)) quiet = 0;
      else quiet++;
    }
  };

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
    settle,
    async cleanup() {
      for (const runner of runners) runner.stop();
      await settle();
      for (const off of listeners.splice(0)) off();
      for (const runner of runners) runner.dispose();
      root.remove();
    },
  };
}
