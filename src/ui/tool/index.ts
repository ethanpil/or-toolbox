/**
 * `mountTool(manifest, setup)`: every tool page's entry point (src/tools/<id>/main.ts).
 *
 * ```ts
 * mountTool(getTool('ocr'), (ctx) => {
 *   const prompt = h('textarea', { class: 'form-control' });
 *   ctx.ui.input.append(prompt);
 *   ctx.ui.runner({ run: async (signal) => { … } });
 *   return { getState: () => ({ prompt: prompt.value, settings: {} }), applyState: (s) => { prompt.value = s.prompt; } };
 * });
 * ```
 *
 * The framework renders the page shell and the tool layout (header with model chip, key chip, cost estimate,
 * Prompts, Settings and History; input and output zones; the Settings drawer), builds the `ToolContext`, runs
 * `setup`, then: resumes persisted jobs (`jobs.resume()`, so `setup` must register job handlers first), applies
 * `?run=`, `?prompt=`, `?sample=1` and `?receive=` from the URL, wires page-wide drop/paste to `onFiles`, and
 * keeps the free-only notice and the Run button's availability in step with the settings.
 * docs/tool-authoring.md is the full guide.
 */
import type { Capability, CoreServices, ResolvedModel, ToolManifest } from '../../core/types';
import { getTool } from '../../tools/registry';
import { Offcanvas, showOffcanvas } from '../bootstrap';
import { costBadge } from '../components/cost-badge';
import { keyPicker } from '../components/key-picker';
import { modelPicker } from '../components/model-picker';
import { promptsPanel, type PromptsPanel } from '../components/prompts-panel';
import { h, replace } from '../dom';
import { announce } from '../feedback/announce';
import { presentError } from '../feedback/errors';
import { modalOpen, openModal } from '../feedback/modal';
import { toast } from '../feedback/toast';
import { formatModelPrice, formatRelativeTime, plural } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { setToolBinding } from '../settings-actions';
import { mountPage } from '../shell/index';
import { historyUrl, settingsUrl } from '../shell/links';
import { createToolContext, resolveFor } from './context';
import { confirmDiscard } from './discard';
import { badgeValue, createEstimateTracker } from './estimate';
import { createStatusLine } from './status-line';
import { uncoverBy } from './uncover';
import { installFileDrop } from './file-drop';
import { resultHandle } from './results';
import { createRunner, type RunnerInternals } from './runner';
import { acceptedItems, receiveItems, sendItems, sendTargets } from './send-to';
import type { SendItem, ToolContext, ToolInstance, ToolSetup, ToolUi } from './types';

export type * from './types';

export interface MountToolOptions {
  /** `'required'` for tools that need multi-threaded ffmpeg (Video studio). */
  isolation?: 'required';
}

/** URL parameters the framework consumes; removed from the address bar once applied (except `model`). */
const CONSUMED_PARAMS = ['run', 'prompt', 'sample', 'receive'];

export function mountTool(
  manifest: ToolManifest,
  setup: ToolSetup,
  options: MountToolOptions = {},
): void {
  mountPage(
    {
      title: manifest.name,
      nav: 'tools',
      tool: manifest.id,
      header: false,
      ...(options.isolation ? { isolation: options.isolation } : {}),
    },
    ({ core, main }) => buildTool(core, main, manifest, setup),
  );
}

async function buildTool(
  core: CoreServices,
  main: HTMLElement,
  manifest: ToolManifest,
  setup: ToolSetup,
): Promise<void> {
  // A tool that chooses its models itself (`manifest.ownModels`) has no model chip and no substitution note for
  // the primary model; `?model=` still reaches it as `ctx.modelOverride`, and Run is still disabled when
  // free-only mode leaves it no model at all.
  const showModelChip = manifest.ownModels !== true;
  const params = new URLSearchParams(location.search);
  let modelOverride = params.get('model');
  const primary: Capability = manifest.capabilities[0]!;
  let instance: ToolInstance | null = null;
  const runners: RunnerInternals[] = [];

  // First thing: a file dropped anywhere must never navigate away, even before the tool is set up.
  installFileDrop({
    accept: manifest.accepts,
    toolName: manifest.name,
    handler: () => {
      const current = instance;
      return current?.onFiles ? (files) => current.onFiles?.(files) : null;
    },
  });

  // --- zones ------------------------------------------------------------------------------------------
  const inputId = uid('tool-input');
  const outputId = uid('tool-output');
  const input = h('div', { class: 'card-body vstack gap-3', 'data-testid': 'tool-input' });
  const output = h('div', { class: 'card-body', 'data-testid': 'tool-output' });
  const statusLine = createStatusLine();
  const notices = h('div', {
    class: 'vstack gap-2 mb-3 empty-hidden',
    'data-testid': 'tool-notices',
  });

  // --- drawer -----------------------------------------------------------------------------------------
  const drawerTitleId = uid('drawer-title');
  const drawerBody = h('div', { class: 'vstack gap-3', 'data-testid': 'tool-drawer' });
  const accordion = h('div', { class: 'accordion mt-3', hidden: true });
  const drawerId = uid('drawer');
  const drawerElement = h(
    'div',
    {
      id: drawerId,
      class: 'offcanvas offcanvas-end or-drawer',
      tabIndex: -1,
      'aria-labelledby': drawerTitleId,
      'data-testid': 'settings-drawer',
    },
    h(
      'div',
      { class: 'offcanvas-header border-bottom' },
      h(
        'div',
        null,
        h('h2', { class: 'offcanvas-title h5 mb-0', id: drawerTitleId }, 'Settings'),
        h('div', { class: 'small text-body-secondary' }, manifest.name),
      ),
      h('button', {
        type: 'button',
        class: 'btn-close',
        'data-bs-dismiss': 'offcanvas',
        'aria-label': 'Close',
      }),
    ),
    h('div', { class: 'offcanvas-body' }, drawerBody, accordion),
  );
  document.body.append(drawerElement);
  const drawer = new Offcanvas(drawerElement);

  // --- header -----------------------------------------------------------------------------------------
  const estimate = costBadge(null);
  const estimates = createEstimateTracker({
    compute: (model) => instance?.estimate?.(model) ?? null,
    model: () => resolveModel().model,
    show: (usd, note) => estimate.set(badgeValue(usd, instance?.addons?.() ?? []), note),
  });
  // One chip high from the start, so the chips arriving (or a model name resolving) does not push the page down.
  const chips = h('div', {
    class: 'd-flex flex-wrap align-items-center gap-2 mt-3 or-tool-chips',
    'data-testid': 'tool-chips',
  });
  let prompts: PromptsPanel | null = null;

  const promptsButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
      'data-testid': 'prompts-button',
      onclick: () => prompts?.open(),
    },
    icon('journal-text'),
    'Prompts',
  );
  const drawerButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
      'aria-controls': drawerId,
      'data-testid': 'drawer-button',
      onclick: () => showOffcanvas(drawer, drawerElement),
    },
    icon('sliders'),
    'Settings',
  );

  const header = h(
    'div',
    { class: 'or-page-header or-tool-header mb-4' },
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-start gap-3' },
      h('div', { class: 'or-icon-tile', 'aria-hidden': 'true' }, icon(manifest.icon)),
      h(
        'div',
        { class: 'or-header-text' },
        h('h1', { class: 'or-page-title mb-1', 'data-testid': 'page-title' }, manifest.name),
        h('p', { class: 'or-page-lead text-body-secondary mb-0' }, manifest.description),
      ),
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        promptsButton,
        drawerButton,
        h(
          'a',
          {
            class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
            href: historyUrl({ tool: manifest.id }),
            'aria-label': `${manifest.name} history`,
            'data-testid': 'history-link',
          },
          icon('clock-history'),
          h('span', { class: 'd-none d-sm-inline' }, 'History'),
        ),
      ),
    ),
    chips,
  );

  const zone = (
    id: string,
    title: string,
    body: HTMLElement,
    extra: HTMLElement | null,
    column: string,
  ): HTMLElement =>
    h(
      'section',
      { class: column, 'aria-labelledby': id },
      h(
        'div',
        { class: 'card or-zone h-100 shadow-sm' },
        h(
          'div',
          { class: 'card-header d-flex align-items-center gap-2' },
          h('h2', { id, class: 'or-zone-title mb-0' }, title),
          extra,
        ),
        body,
      ),
    );

  // The zones are filled by `setup`, which may wait (Chat reads IndexedDB first): until then they take their
  // place but stay invisible (`visibility: hidden` keeps the layout, so nothing shifts when they appear, and
  // nothing in them can take focus).
  const zones = h(
    'div',
    { class: 'row g-4 or-tool-zones or-tool-pending' },
    zone(inputId, 'Input', input, null, 'col-lg-5'),
    zone(outputId, 'Output', output, statusLine.element, 'col-lg-7'),
  );
  main.append(header, notices, zones);

  // --- model and key chips, free-only notice ----------------------------------------------------------
  const resolveModel = (capability: Capability = primary): ResolvedModel =>
    resolveFor(core, manifest, modelOverride, capability);

  const chooseModel = async (): Promise<void> => {
    const current = resolveModel();
    const chosen = await modelPicker(core, { capability: primary, selected: current.model });
    if (!chosen || !setToolBinding(core, manifest.id, { model: chosen })) return;
    if (modelOverride) {
      modelOverride = null;
      const url = new URL(location.href);
      url.searchParams.delete('model');
      history.replaceState(history.state, '', url);
    }
    renderChips();
    announce(`Model changed to ${chosen}.`);
  };

  let chipsGeneration = 0;
  /** The model the estimate was last asked for; a different one (chip, settings, free-only) asks again. */
  let estimatedFor: string | null | undefined;
  const renderChips = (): void => {
    const resolved = resolveModel();
    const mine = ++chipsGeneration;
    if (instance && resolved.model !== estimatedFor) {
      estimatedFor = resolved.model;
      void estimates.refresh();
    }
    const name = h(
      'span',
      { class: 'text-truncate', 'data-testid': 'model-chip-name' },
      resolved.model ?? 'No model available',
    );
    const price = h('span', { class: 'small text-body-secondary d-none d-sm-inline' });
    const modelChip = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2 or-chip',
        'aria-label': `Model: ${resolved.model ?? 'none'}. Change model`,
        'data-focus-key': 'model-chip',
        'data-testid': 'model-chip',
        onclick: () => void chooseModel().catch((error: unknown) => void presentError(error)),
      },
      icon('cpu'),
      name,
      resolved.model && core.models.isFree(resolved.model)
        ? h('span', { class: 'badge rounded-pill text-bg-success' }, 'Free')
        : price,
      modelOverride
        ? h(
            'span',
            {
              class: 'badge rounded-pill text-bg-warning',
              title: 'From the link you opened; choose a model to replace it',
            },
            'This visit',
          )
        : null,
    );
    if (showModelChip && resolved.model && !core.models.isFree(resolved.model)) {
      void core.models
        .get(resolved.model)
        .then((model) => {
          if (mine !== chipsGeneration || !model) return;
          name.textContent = model.name;
          price.textContent = formatModelPrice(model);
          modelChip.setAttribute('aria-label', `Model: ${model.name}. Change model`);
        })
        .catch(() => undefined);
    }
    const keys = core.keys.list();
    replace(
      chips,
      showModelChip ? modelChip : null,
      keys.length > 1
        ? keyPicker({
            keys,
            value: core.settings.get().tools[manifest.id]?.keyId,
            onChange: (keyId) => {
              setToolBinding(core, manifest.id, { keyId: keyId ?? null });
            },
          })
        : null,
      estimate.element,
    );
    renderNotices(resolved);
  };

  const renderNotices = (resolved: ResolvedModel): void => {
    const blocked = resolved.model === null;
    const list: HTMLElement[] = [];
    if (blocked) {
      list.push(
        h(
          'div',
          {
            class: 'alert alert-warning d-flex gap-3 align-items-start mb-0',
            'data-testid': 'free-only-notice',
          },
          icon('slash-circle', 'fs-4 lh-1'),
          h(
            'div',
            null,
            h('div', { class: 'fw-semibold' }, 'This tool cannot run in free-only mode'),
            h('div', null, resolved.note ?? 'No model is available for this tool.'),
            h(
              'a',
              { class: 'alert-link', href: settingsUrl('models') },
              'Turn off free-only mode in Settings',
            ),
          ),
        ),
      );
    } else if (resolved.note && showModelChip) {
      list.push(
        h(
          'div',
          {
            class: 'alert alert-info d-flex gap-2 align-items-center py-2 mb-0 small',
            'data-testid': 'model-note',
          },
          icon('info-circle'),
          resolved.note,
        ),
      );
    }
    notices.replaceChildren(...list);
    for (const runner of runners) {
      runner.setFrameworkReason(blocked ? 'No model is available in free-only mode.' : null);
    }
  };

  renderChips();
  core.settings.subscribe((next, prev) => {
    if (
      next.freeOnly !== prev.freeOnly ||
      next.tools[manifest.id]?.model !== prev.tools[manifest.id]?.model ||
      next.tools[manifest.id]?.keyId !== prev.tools[manifest.id]?.keyId ||
      next.defaultModels[primary] !== prev.defaultModels[primary] ||
      next.defaultKeyId !== prev.defaultKeyId
    ) {
      renderChips();
    }
  });
  core.keys.subscribe(renderChips);
  core.bus.on('models-refreshed', () => {
    renderChips();
    // New prices: the same model may cost something else now.
    if (instance) void estimates.refresh();
  });

  // --- ui ---------------------------------------------------------------------------------------------
  const ui: ToolUi = {
    input,
    output,
    drawer: drawerBody,
    advanced(title) {
      const bodyId = uid('advanced');
      const headerId = uid('advanced-header');
      const body = h('div', { class: 'accordion-body vstack gap-3' });
      accordion.hidden = false;
      accordion.append(
        h(
          'div',
          { class: 'accordion-item' },
          h(
            'h3',
            { class: 'accordion-header', id: headerId },
            h(
              'button',
              {
                type: 'button',
                class: 'accordion-button collapsed',
                'data-bs-toggle': 'collapse',
                'data-bs-target': `#${bodyId}`,
                'aria-expanded': 'false',
                'aria-controls': bodyId,
              },
              title,
            ),
          ),
          h(
            'div',
            { id: bodyId, class: 'accordion-collapse collapse', 'aria-labelledby': headerId },
            body,
          ),
        ),
      );
      return body;
    },
    runner(runnerOptions) {
      const runner = createRunner(runnerOptions, runners.length === 0);
      runners.push(runner);
      (runnerOptions.container ?? input).append(runner.element);
      if (runners.length === 1) reserveRunnerSpace(runner.element);
      runner.setFrameworkReason(
        resolveModel().model === null ? 'No model is available in free-only mode.' : null,
      );
      return runner;
    },
    refreshEstimate: () => estimates.refresh(),
    setEstimate(usd, note) {
      estimates.set(usd, note);
    },
    status: (text) => statusLine.status(text),
    progress: (text) => statusLine.progress(text),
    holdWork: (description) => core.results.hold(description),
    confirmDiscard,
    addResult(resultInput) {
      return resultHandle(core, core.results.add({ tool: manifest.id, ...resultInput }));
    },
    sendTo(items) {
      showSendTo(manifest, items);
    },
    openPrompts: () => prompts?.open(),
    openDrawer: () => showOffcanvas(drawer, drawerElement),
  };

  // --- context ----------------------------------------------------------------------------------------
  const ctx: ToolContext = createToolContext({
    core,
    manifest,
    ui,
    estimates,
    modelOverride: () => modelOverride,
    instance: () => instance,
  });

  // --- setup ------------------------------------------------------------------------------------------
  instance = await setup(ctx);
  zones.classList.remove('or-tool-pending');
  const ready = instance;
  estimatedFor = resolveModel().model;
  void estimates.refresh();
  prompts = promptsPanel(core, {
    tool: manifest.id,
    getState: () => ready.getState(),
    applyState: (state) => ready.applyState(state),
    promptless: ready.promptless === true,
  });
  core.jobs.resume();

  installShortcut(runners);

  await applyUrlState(core, manifest, ready, params);
}

/**
 * The primary Run bar is sticky at the bottom of the window and must never hide the control that has focus
 * (WCAG 2.4.11); nor must the sticky navbar at the top (Shift+Tab). The bar's height goes to `--or-runner-height`
 * on <html>, where `scroll-padding-bottom` (src/styles/_tool.scss) keeps scrollIntoView and clicks above it (and
 * the toasts above it on phones). Chromium ignores scroll padding when Tab moves focus, so a focused control a bar
 * still covers is scrolled clear (`uncoverBy`): only when the bar is really over it, not beside it (on wide
 * screens the bar sits in the left column), and never for controls in a dialog or drawer, which scroll themselves.
 */
function reserveRunnerSpace(bar: HTMLElement): void {
  const root = document.documentElement;
  const sync = (): void => {
    root.style.setProperty(
      '--or-runner-height',
      `${Math.ceil(bar.getBoundingClientRect().height)}px`,
    );
  };
  sync();
  if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(bar);
  const uncover = (target: HTMLElement): void => {
    if (document.activeElement !== target || !bar.isConnected) return;
    const control = target.getBoundingClientRect();
    const navbar = document.querySelector('.or-navbar');
    const top = navbar ? uncoverBy(control, navbar.getBoundingClientRect(), 'top', innerHeight) : 0;
    const by = top || uncoverBy(control, bar.getBoundingClientRect(), 'bottom', innerHeight);
    if (by !== 0) window.scrollBy({ top: by, behavior: 'instant' });
  };
  // A focus scroll is smooth (Bootstrap's `scroll-behavior: smooth` unless motion is reduced): one frame after
  // focusin the control may still be on its way up from below the bar, so it is checked again once scrolling
  // settles (`scrollend`, or a timeout where the event is missing or no scroll happens).
  let cancelSettle: (() => void) | null = null;
  const whenSettled = (check: () => void): void => {
    cancelSettle?.();
    const run = (): void => {
      cancelSettle?.();
      check();
    };
    const timer = window.setTimeout(run, 700);
    window.addEventListener('scrollend', run);
    cancelSettle = () => {
      window.clearTimeout(timer);
      window.removeEventListener('scrollend', run);
      cancelSettle = null;
    };
  };
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || bar.contains(target)) return;
    // A dialog or a drawer sits above both bars and scrolls itself.
    if (target.closest('.modal, .offcanvas')) return;
    // Only focus a keyboard moved. A press on blank space focuses <main> (tabindex -1) and the scroll below would
    // cancel a drag that began there (a Decision level's handle), or jolt the page under a click.
    if (!keyboardFocused(target)) return;
    // The browser's own focus scroll comes after focusin: check once it has happened, and again when it ends.
    requestAnimationFrame(() => uncover(target));
    whenSettled(() => uncover(target));
  });
}

/** True when the browser would draw a focus ring: keyboard focus, or a text field however it got focus. */
function keyboardFocused(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true; // an engine without :focus-visible: keep the check
  }
}

/** Ctrl/Cmd+Enter runs the first (primary) runner, unless a dialog is open. */
function installShortcut(runners: readonly RunnerInternals[]): void {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (modalOpen()) return;
    const runner = runners[0];
    if (!runner) return;
    event.preventDefault();
    void runner.trigger();
  });
}

async function applyUrlState(
  core: CoreServices,
  manifest: ToolManifest,
  instance: ToolInstance,
  params: URLSearchParams,
): Promise<void> {
  const runId = params.get('run');
  const promptId = params.get('prompt');
  const receiveId = params.get('receive');
  const sample = params.get('sample') === '1';

  if (CONSUMED_PARAMS.some((name) => params.has(name))) {
    const url = new URL(location.href);
    for (const name of CONSUMED_PARAMS) url.searchParams.delete(name);
    history.replaceState(history.state, '', url);
  }

  try {
    if (runId) {
      const record = await core.history.get(runId);
      if (record && record.tool === manifest.id) {
        instance.applyState({ prompt: record.prompt ?? '', settings: record.settings ?? {} });
        toast({
          message: `Opened the run from ${formatRelativeTime(record.startedAt)}.`,
          variant: 'success',
        });
      } else {
        toast({ message: 'That run is no longer in History.', variant: 'warning' });
      }
    } else if (promptId) {
      const entries = [
        ...(await core.prompts.list(manifest.id, 'saved')),
        ...(await core.prompts.list(manifest.id, 'recent')),
      ];
      const entry = entries.find((candidate) => candidate.id === promptId);
      if (entry) {
        instance.applyState({ prompt: entry.text, settings: entry.settings });
        void core.prompts.touch(entry.id).catch(() => undefined);
      } else {
        toast({ message: 'That prompt was deleted.', variant: 'warning' });
      }
    } else if (sample) {
      if (instance.sample) await instance.sample();
      else toast({ message: `${manifest.name} has no sample yet.` });
    }
  } catch (error) {
    void presentError(error);
  }

  if (receiveId) {
    try {
      const items = acceptedItems(manifest, await receiveItems(receiveId));
      if (items.length === 0)
        toast({ message: `${manifest.name} cannot use what was sent.`, variant: 'warning' });
      else if (instance.onReceive) {
        instance.onReceive(items);
        toast({ message: `Received ${plural(items.length, 'item')}.`, variant: 'success' });
      } else toast({ message: `${manifest.name} cannot receive items yet.`, variant: 'warning' });
    } catch (error) {
      void presentError(error);
    }
  }
}

/** The "Send to…" chooser. */
function showSendTo(manifest: ToolManifest, items: SendItem[]): void {
  const targets = sendTargets(items, manifest.id);
  const modal = openModal({
    title: 'Send to…',
    icon: 'send',
    body:
      targets.length === 0
        ? h(
            'p',
            { class: 'mb-0 text-body-secondary' },
            'No other tool takes this kind of result yet.',
          )
        : [
            h(
              'p',
              { class: 'text-body-secondary' },
              'Opens the tool in a new tab with this result. Nothing is stored.',
            ),
            h(
              'div',
              { class: 'list-group' },
              targets.map((target) => {
                const accepted = acceptedItems(target, items);
                return h(
                  'button',
                  {
                    type: 'button',
                    class:
                      'list-group-item list-group-item-action d-flex align-items-center gap-3 py-3',
                    'data-testid': `send-to-${target.id}`,
                    onclick: () => {
                      modal.hide();
                      sendItems(target.id, accepted)
                        .then((count) =>
                          toast({
                            message: `Sent ${plural(count, 'item')} to ${getTool(target.id).name}.`,
                            variant: 'success',
                          }),
                        )
                        .catch((error: unknown) => void presentError(error));
                    },
                  },
                  h(
                    'span',
                    { class: 'or-icon-tile or-icon-tile-sm', 'aria-hidden': 'true' },
                    icon(target.icon),
                  ),
                  h(
                    'span',
                    { class: 'min-w-0' },
                    h('span', { class: 'd-block fw-semibold' }, target.name),
                    h('span', { class: 'd-block small text-body-secondary' }, target.description),
                    accepted.length < items.length
                      ? h(
                          'span',
                          { class: 'd-block small text-warning-emphasis' },
                          `Takes ${accepted.length} of ${items.length} items`,
                        )
                      : null,
                  ),
                );
              }),
            ),
          ],
    footer: h(
      'button',
      { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
      'Cancel',
    ),
    testId: 'send-to-dialog',
  });
}
