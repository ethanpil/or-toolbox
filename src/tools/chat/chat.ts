/**
 * The Chat tool: threads of branching conversations with any text model.
 *
 * Layout (the three-zone tool layout): the composer and the thread list on the left (input), the conversation on
 * the right (output), sampling/reasoning/system prompt in the Settings drawer, fallbacks and the PDF engine under
 * Advanced. Every send, edit or regenerate is one run (`ctx.beginRun` with an estimate for exactly what is sent,
 * then `api.chatStream`); the reply records its model, tokens, cost and latency.
 *
 * Threads live in the tool's state (`thread:<id>`, `current`); attachment bytes only in memory (`session`).
 * `getState`/`applyState` cover the composer (text, model) and the parameters, not the thread: reopening a run
 * from History fills the composer.
 */
import type { ModelInfo, RunHandle, UsageTotals } from '../../core/types';
import { InvalidInputError, userMessage } from '../../core/errors';
import { isFiniteNumber, isString } from '../../core/util';
import { copyText } from '../../ui/clipboard';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { modelPicker } from '../../ui/components/model-picker';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { isStop, markPresented, needsAction, presentError } from '../../ui/feedback/errors';
import { modalOpen } from '../../ui/feedback/modal';
import { toast } from '../../ui/feedback/toast';
import {
  formatBytes,
  formatCount,
  formatRelativeTime,
  formatShortcut,
  formatUsd,
  plural,
} from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { SendItem, ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/types';
import { ACCEPT_ATTRIBUTE, MAX_ATTACHMENTS, readAttachment, textAttachment } from './attachments';
import { toJson, toMarkdown } from './export';
import { codeOf, renderReply, streamingView, type StreamingView } from './markdown-view';
import { buildRequest, type RequestOptions } from './request';
import {
  activePath,
  addNode,
  type AttachmentRef,
  type ChatNode,
  cloneThread,
  createThread,
  deleteBranch,
  isEmpty,
  leaf,
  matchesQuery,
  parseThread,
  pathTo,
  selectSibling,
  siblingInfo,
  type Thread,
  threadTotals,
} from './thread';
import { KIND_ICONS, messageView, type MessageActions, type MessageContext } from './view';

export const PDF_ENGINES = ['cloudflare-ai', 'mistral-ocr', 'native'] as const;
export type PdfEngine = (typeof PDF_ENGINES)[number];
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Parameters kept in the tool's options (the system prompt here is the default for new threads). */
export interface ChatParams {
  temperature: number | null;
  maxTokens: number | null;
  /** '' = the model's default. */
  reasoningEffort: string;
  fallbacks: string[];
  pdfEngine: PdfEngine;
  showReasoning: boolean;
  enterSends: boolean;
  system: string;
}

const STATE_THREAD = 'thread:';
const STATE_CURRENT = 'current';
const UI_THREADS_OPEN = 'chat.threadsOpen';

export const SYSTEM_PRESETS: readonly { label: string; text: string }[] = [
  {
    label: 'Concise',
    text: 'Answer briefly and precisely. Use bullet points when they help. Skip pleasantries.',
  },
  {
    label: 'Patient teacher',
    text: 'Explain step by step in plain language, define any jargon you use, and finish with a short example that checks understanding.',
  },
  {
    label: 'Senior engineer',
    text: 'You are a senior software engineer. Give working, idiomatic code with brief explanations, point out edge cases and trade-offs, and say when you are unsure.',
  },
  {
    label: 'Editor',
    text: "Improve the user's text for clarity, grammar and flow while keeping their voice and meaning. Return the revised text first, then a short list of the main changes.",
  },
  {
    label: 'Translator',
    text: "Translate the user's messages into English, or into the language they name, keeping tone, formatting and meaning. Output only the translation.",
  },
];

export const SAMPLE_PROMPT =
  'Explain how a rainbow forms in three short paragraphs, then give me one surprising fact about rainbows.';

const clampNumber = (value: unknown, min: number, max: number): number | null =>
  isFiniteNumber(value) && value >= min && value <= max ? value : null;

/** The parameters from saved options (anything invalid falls back to its default). */
export function paramsFrom(options: Record<string, unknown>): ChatParams {
  const fallbacks = options['fallbacks'];
  return {
    temperature: clampNumber(options['temperature'], 0, 2),
    maxTokens: clampNumber(options['maxTokens'], 1, 10_000_000),
    reasoningEffort:
      isString(options['reasoningEffort']) &&
      (REASONING_EFFORTS as readonly string[]).includes(options['reasoningEffort'])
        ? options['reasoningEffort']
        : '',
    fallbacks: Array.isArray(fallbacks) ? fallbacks.filter(isString).slice(0, 5) : [],
    pdfEngine: (PDF_ENGINES as readonly unknown[]).includes(options['pdfEngine'])
      ? (options['pdfEngine'] as PdfEngine)
      : 'cloudflare-ai',
    showReasoning: options['showReasoning'] !== false,
    enterSends: options['enterSends'] !== false,
    system: isString(options['system']) ? options['system'] : '',
  };
}

/** What a model allows for reasoning, from its catalog entry; null when it does not reason. */
export function reasoningChoices(info: ModelInfo | undefined): string[] | null {
  if (!info) return null;
  const raw = info.raw.reasoning;
  if (!raw && !info.supportedParameters.includes('reasoning')) return null;
  const supported = raw?.supported_efforts?.filter((effort) =>
    (REASONING_EFFORTS as readonly string[]).includes(effort),
  );
  const efforts =
    supported && supported.length > 0 ? supported : ['minimal', 'low', 'medium', 'high'];
  return raw?.mandatory ? efforts.filter((effort) => effort !== 'none') : efforts;
}

type Action =
  | { kind: 'send' }
  | { kind: 'edit'; id: string; text: string }
  | { kind: 'regenerate'; id: string; model?: string };

interface LiveReply {
  thread: Thread;
  node: ChatNode;
  view: StreamingView | null;
  reasoning: HTMLElement | null;
}

const debounce = (fn: () => void, ms: number): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
};

export async function setup(ctx: ToolContext): Promise<ToolInstance> {
  const { ui } = ctx;
  const params = paramsFrom(ctx.options.get());
  const threads = new Map<string, Thread>();
  /** Data URLs of image, PDF and audio attachments, by attachment id: this session only. */
  const session = new Map<string, string>();
  let catalog = new Map<string, ModelInfo>();
  let pending: AttachmentRef[] = [];
  let editing: { id: string; text: string } | null = null;
  let live: LiveReply | null = null;
  /** A send, edit or regenerate is in progress (from its start until its reply ended). */
  let active = false;
  let query = '';

  // --- stored threads -----------------------------------------------------------------------------------
  let currentId: string | undefined;
  try {
    for (const key of await ctx.state.keys()) {
      if (!key.startsWith(STATE_THREAD)) continue;
      const thread = parseThread(await ctx.state.get(key));
      if (thread && key === `${STATE_THREAD}${thread.id}`) threads.set(thread.id, thread);
    }
    currentId = await ctx.state.get<string>(STATE_CURRENT);
  } catch (error) {
    void presentError(error);
  }
  // A link that brings something to work on (a run, a prompt, a sample, items) starts a new chat.
  const fromLink = ['run', 'prompt', 'sample', 'receive'].some((name) =>
    new URLSearchParams(location.search).has(name),
  );
  let current: Thread =
    (!fromLink && currentId ? threads.get(currentId) : undefined) ??
    createThread({ system: params.system });

  let writes: Promise<void> = Promise.resolve();
  const queueWrite = (write: () => Promise<void>): void => {
    writes = writes.then(write).catch((error: unknown) => void presentError(error));
  };
  /** Stores a thread (drafts are stored once they have a message). */
  const persist = (thread: Thread): void => {
    if (isEmpty(thread) && !threads.has(thread.id)) return;
    threads.set(thread.id, thread);
    queueWrite(() => ctx.state.set(`${STATE_THREAD}${thread.id}`, thread));
  };
  const rememberCurrent = (): void => {
    if (threads.has(current.id)) queueWrite(() => ctx.state.set(STATE_CURRENT, current.id));
  };

  // --- models -------------------------------------------------------------------------------------------
  const defaultModel = (): string | null => ctx.model().model;
  const effectiveModel = (): string | null => current.model ?? defaultModel();
  const modelName = (id: string): string => catalog.get(id)?.name ?? id;
  const modelInfo = async (id: string): Promise<ModelInfo | undefined> =>
    catalog.get(id) ?? (await ctx.models.get(id).catch(() => undefined));
  const loadCatalog = (): void => {
    ctx.models
      .list()
      .then((list) => {
        catalog = new Map(list.map((model) => [model.id, model]));
        renderAll();
        void ui.refreshEstimate();
      })
      .catch(() => undefined);
  };

  // --- composer (input zone) ----------------------------------------------------------------------------
  const ids = { composer: uid('composer'), hint: uid('composer-hint'), threads: uid('threads') };
  const composer = h('textarea', {
    id: ids.composer,
    class: 'form-control or-chat-input',
    rows: 4,
    placeholder: 'Ask anything, or drop files here',
    'aria-describedby': ids.hint,
    'data-testid': 'tool-prompt',
  });
  const keyHint = h('p', { id: ids.hint, class: 'form-text mt-0', 'data-testid': 'composer-hint' });
  const modelButton = h('button', {
    type: 'button',
    class:
      'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 or-chip text-truncate',
    'data-testid': 'composer-model',
    onclick: () => void chooseComposerModel(),
  });
  const modelReset = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-link px-1',
      'aria-label': 'Use the default model',
      title: 'Use the default model',
      'data-testid': 'composer-model-reset',
      onclick: () => setThreadModel(null),
    },
    icon('x-lg'),
  );
  const pendingList = h('ul', {
    class: 'list-unstyled d-flex flex-wrap gap-2 mb-0 empty-hidden',
    'aria-label': 'Files to send',
    'data-testid': 'composer-attachments',
  });
  const warnings = h('div', {
    class: 'vstack gap-2 empty-hidden',
    'data-testid': 'composer-warnings',
  });
  const fileInput = h('input', {
    type: 'file',
    hidden: true,
    multiple: true,
    accept: ACCEPT_ATTRIBUTE,
    tabIndex: -1,
    'data-testid': 'composer-file',
    onchange: () => {
      void addFiles([...(fileInput.files ?? [])]);
      fileInput.value = '';
    },
  });
  const attachButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
      'data-testid': 'composer-attach',
      onclick: () => fileInput.click(),
    },
    icon('paperclip'),
    'Attach',
  );
  const runnerHost = h('div', { class: 'ms-auto' });

  ui.input.append(
    h(
      'div',
      { class: 'or-chat-composer d-flex flex-column gap-2' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 min-w-0' },
        h('label', { class: 'form-label fw-semibold mb-0', htmlFor: ids.composer }, 'Message'),
        h('div', { class: 'ms-auto d-flex align-items-center min-w-0' }, modelButton, modelReset),
      ),
      composer,
      keyHint,
      pendingList,
      warnings,
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        attachButton,
        fileInput,
        runnerHost,
      ),
    ),
  );

  // --- thread list (input zone, below the composer) -----------------------------------------------------
  const threadCount = h('span', {
    class: 'badge rounded-pill text-bg-secondary',
    'data-testid': 'thread-count',
  });
  const threadSearch = h('input', {
    type: 'search',
    class: 'form-control form-control-sm',
    placeholder: 'Search titles and messages',
    'aria-label': 'Search threads',
    'data-testid': 'thread-search',
    oninput: () => {
      query = threadSearch.value;
      renderThreads();
    },
  });
  const threadList = h('ul', {
    class: 'list-group or-thread-list',
    'aria-label': 'Threads',
    'data-testid': 'thread-list',
  });
  const threadsBody = h(
    'div',
    { id: ids.threads, class: 'vstack gap-2 mt-2' },
    threadSearch,
    threadList,
  );
  const threadsOpen = (): boolean => {
    const saved = ctx.settings.get().ui[UI_THREADS_OPEN];
    return typeof saved === 'boolean'
      ? saved
      : window.matchMedia?.('(min-width: 992px)').matches !== false;
  };
  const threadsToggle = h('button', {
    type: 'button',
    class: 'btn btn-sm btn-link px-1',
    'aria-controls': ids.threads,
    'data-testid': 'threads-toggle',
    onclick: () => {
      const open = threadsBody.hidden !== false;
      try {
        ctx.settings.update((draft) => {
          draft.ui[UI_THREADS_OPEN] = open;
        });
      } catch {
        // Only the remembered state is lost.
      }
      renderThreadsOpen(open);
    },
  });
  const renderThreadsOpen = (open: boolean): void => {
    threadsBody.hidden = !open;
    threadsToggle.setAttribute('aria-expanded', String(open));
    threadsToggle.replaceChildren(
      icon(open ? 'chevron-up' : 'chevron-down'),
      h('span', { class: 'visually-hidden' }, open ? 'Hide threads' : 'Show threads'),
    );
    threadsToggle.title = open ? 'Hide threads' : 'Show threads';
  };
  ui.input.append(
    h(
      'section',
      { class: 'or-chat-threads border-top pt-3', 'aria-labelledby': `${ids.threads}-title` },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        h('h3', { id: `${ids.threads}-title`, class: 'h6 mb-0' }, 'Threads'),
        threadCount,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1 ms-auto',
            'data-testid': 'chat-new',
            onclick: () => newThread(),
          },
          icon('plus-lg'),
          'New chat',
        ),
        threadsToggle,
      ),
      threadsBody,
    ),
  );

  // --- conversation (output zone) -----------------------------------------------------------------------
  const titleEl = h('h3', { class: 'h5 mb-0 text-truncate', 'data-testid': 'chat-title' });
  const totalsEl = h('div', { class: 'small text-body-secondary', 'data-testid': 'chat-totals' });
  const renameButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-link px-1',
      'aria-label': 'Rename this thread',
      title: 'Rename this thread',
      'data-testid': 'chat-rename',
      onclick: () => void renameThread(current),
    },
    icon('pencil'),
  );
  const copyAllButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'data-testid': 'chat-copy',
      onclick: () => void copyWithToast(toMarkdown(current), 'Conversation copied.'),
    },
    icon('clipboard'),
    'Copy',
  );
  const exportHost = h('span', { class: 'd-inline-block' });
  const log = h('div', {
    class: 'or-chat-log',
    role: 'log',
    'aria-live': 'polite',
    'aria-label': 'Conversation',
    tabIndex: 0,
    'data-testid': 'chat-log',
  });
  log.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest('[data-copy-code]');
    if (button) void copyWithToast(codeOf(button), 'Code copied.');
  });
  ui.output.append(
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-start gap-2 mb-3' },
      h(
        'div',
        { class: 'min-w-0 flex-grow-1' },
        h('div', { class: 'd-flex align-items-center gap-1 min-w-0' }, titleEl, renameButton),
        totalsEl,
      ),
      h('div', { class: 'd-flex flex-wrap gap-2' }, copyAllButton, exportHost),
    ),
    log,
  );

  // --- settings drawer ----------------------------------------------------------------------------------
  const drawerIds = {
    system: uid('system'),
    preset: uid('preset'),
    temperature: uid('temperature'),
    maxTokens: uid('max-tokens'),
    effort: uid('effort'),
    reasoning: uid('show-reasoning'),
    enter: uid('enter-sends'),
    engine: uid('pdf-engine'),
  };
  const saveOptions = (patch: Partial<ChatParams>): void => {
    try {
      ctx.options.set(patch);
    } catch (error) {
      void presentError(error);
    }
  };
  const saveSystemSoon = debounce(() => {
    saveOptions({ system: params.system });
    persist(current);
  }, 400);
  const systemArea = h('textarea', {
    id: drawerIds.system,
    class: 'form-control',
    rows: 5,
    placeholder: 'For example: You are a concise assistant for a busy engineer.',
    'data-testid': 'chat-system',
    oninput: () => {
      current.system = systemArea.value;
      params.system = systemArea.value;
      saveSystemSoon();
      void ui.refreshEstimate();
    },
  });
  const presetSelect = h(
    'select',
    {
      id: drawerIds.preset,
      class: 'form-select form-select-sm',
      'data-testid': 'chat-system-preset',
      onchange: () => {
        const preset = SYSTEM_PRESETS[Number(presetSelect.value)];
        presetSelect.value = '';
        if (!preset) return;
        systemArea.value = preset.text;
        systemArea.dispatchEvent(new Event('input'));
        announce(`System prompt set to ${preset.label}.`);
      },
    },
    h('option', { value: '' }, 'Insert a preset…'),
    SYSTEM_PRESETS.map((preset, index) => h('option', { value: String(index) }, preset.label)),
  );
  const numberInput = (
    id: string,
    min: string,
    max: string,
    step: string,
    testId: string,
  ): HTMLInputElement =>
    h('input', {
      id,
      type: 'number',
      class: 'form-control',
      min,
      max,
      step,
      placeholder: 'Model default',
      inputMode: 'decimal',
      'data-testid': testId,
    });
  const temperatureInput = numberInput(drawerIds.temperature, '0', '2', '0.1', 'chat-temperature');
  const maxTokensInput = numberInput(drawerIds.maxTokens, '1', '10000000', '1', 'chat-max-tokens');
  const readNumber = (
    input: HTMLInputElement,
    min: number,
    max: number,
    integer: boolean,
  ): number | null => {
    if (input.value.trim() === '') return null;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return null;
    const clamped = Math.min(max, Math.max(min, integer ? Math.round(value) : value));
    if (clamped !== value) input.value = String(clamped);
    return clamped;
  };
  temperatureInput.addEventListener('change', () => {
    params.temperature = readNumber(temperatureInput, 0, 2, false);
    saveOptions({ temperature: params.temperature });
  });
  maxTokensInput.addEventListener('change', () => {
    params.maxTokens = readNumber(maxTokensInput, 1, 10_000_000, true);
    saveOptions({ maxTokens: params.maxTokens });
    void ui.refreshEstimate();
  });
  const effortSelect = h('select', {
    id: drawerIds.effort,
    class: 'form-select',
    'data-testid': 'chat-reasoning-effort',
    onchange: () => {
      params.reasoningEffort = effortSelect.value;
      saveOptions({ reasoningEffort: params.reasoningEffort });
    },
  });
  const effortField = h(
    'div',
    { 'data-testid': 'chat-reasoning-field' },
    h('label', { class: 'form-label', htmlFor: drawerIds.effort }, 'Reasoning effort'),
    effortSelect,
    h(
      'div',
      { class: 'form-text' },
      'More effort can give better answers to hard questions, at the cost of time and tokens.',
    ),
  );
  const switchField = (
    id: string,
    label: string,
    testId: string,
    onchange: (on: boolean) => void,
  ): { input: HTMLInputElement; field: HTMLElement } => {
    const input = h('input', {
      id,
      type: 'checkbox',
      class: 'form-check-input',
      role: 'switch',
      'data-testid': testId,
      onchange: () => onchange(input.checked),
    });
    const field = h(
      'div',
      { class: 'form-check form-switch' },
      input,
      h('label', { class: 'form-check-label', htmlFor: id }, label),
    );
    return { input, field };
  };
  const showReasoning = switchField(
    drawerIds.reasoning,
    'Show reasoning when the model returns it',
    'chat-show-reasoning',
    (on) => {
      params.showReasoning = on;
      saveOptions({ showReasoning: on });
      renderLog();
    },
  );
  const enterSends = switchField(
    drawerIds.enter,
    'Enter sends (Shift+Enter for a new line)',
    'chat-enter-sends',
    (on) => {
      params.enterSends = on;
      saveOptions({ enterSends: on });
      renderKeyHint();
    },
  );
  ui.drawer.append(
    h(
      'div',
      null,
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 mb-2' },
        h('label', { class: 'form-label mb-0', htmlFor: drawerIds.system }, 'System prompt'),
        h(
          'label',
          { class: 'visually-hidden', htmlFor: drawerIds.preset },
          'System prompt presets',
        ),
        h('div', { class: 'ms-auto' }, presetSelect),
      ),
      systemArea,
      h(
        'div',
        { class: 'form-text' },
        'For this thread. New chats start with the last one you wrote.',
      ),
    ),
    h(
      'div',
      { class: 'row g-3' },
      h(
        'div',
        { class: 'col-6' },
        h('label', { class: 'form-label', htmlFor: drawerIds.temperature }, 'Temperature'),
        temperatureInput,
      ),
      h(
        'div',
        { class: 'col-6' },
        h('label', { class: 'form-label', htmlFor: drawerIds.maxTokens }, 'Max tokens'),
        maxTokensInput,
      ),
    ),
    effortField,
    showReasoning.field,
    enterSends.field,
  );

  const fallbackList = h('ul', {
    class: 'list-group',
    'aria-label': 'Fallback models',
    'data-testid': 'chat-fallbacks',
  });
  const engineSelect = h(
    'select',
    {
      id: drawerIds.engine,
      class: 'form-select',
      'data-testid': 'chat-pdf-engine',
      onchange: () => {
        params.pdfEngine = engineSelect.value as PdfEngine;
        saveOptions({ pdfEngine: params.pdfEngine });
      },
    },
    h('option', { value: 'cloudflare-ai' }, 'Cloudflare AI (free)'),
    h('option', { value: 'mistral-ocr' }, 'Mistral OCR (paid, best for scans)'),
    h('option', { value: 'native' }, "The model's own file input"),
  );
  const advanced = ui.advanced('Fallbacks and PDFs');
  advanced.append(
    h(
      'div',
      null,
      h('div', { class: 'form-label' }, 'Fallback models'),
      fallbackList,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-primary mt-2 d-inline-flex align-items-center gap-1',
          'data-testid': 'chat-fallback-add',
          onclick: () => void addFallback(),
        },
        icon('plus-lg'),
        'Add a fallback model',
      ),
      h(
        'div',
        { class: 'form-text' },
        'When the model fails (rate limit, outage, context too long), OpenRouter tries these in order. The reply says which model answered.',
      ),
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: drawerIds.engine }, 'PDF reader'),
      engineSelect,
      h(
        'div',
        { class: 'form-text' },
        'Cloudflare AI is free. Mistral OCR reads scans best and is billed per 1,000 pages. The model’s own file input is billed as input tokens and works only on models that read files.',
      ),
    ),
  );

  // --- rendering ----------------------------------------------------------------------------------------
  const renderKeyHint = (): void => {
    keyHint.textContent = params.enterSends
      ? `Enter sends, Shift+Enter adds a line. ↑ edits your last message, Esc stops a reply.`
      : `${formatShortcut('Enter')} sends. ↑ edits your last message, Esc stops a reply.`;
  };

  /** The drawer's fields from the parameters and this thread's system prompt (not on every render: typing). */
  const renderParams = (): void => {
    systemArea.value = current.system;
    temperatureInput.value = params.temperature === null ? '' : String(params.temperature);
    maxTokensInput.value = params.maxTokens === null ? '' : String(params.maxTokens);
    showReasoning.input.checked = params.showReasoning;
    enterSends.input.checked = params.enterSends;
    engineSelect.value = params.pdfEngine;
    renderKeyHint();
  };

  const renderEffort = (): void => {
    const model = effectiveModel();
    const choices = reasoningChoices(model ? catalog.get(model) : undefined);
    effortField.hidden = choices === null;
    const values = choices ?? [];
    // Keep a saved effort visible even when this model does not list it, so the form shows what is stored.
    if (params.reasoningEffort && !values.includes(params.reasoningEffort))
      values.push(params.reasoningEffort);
    replace(
      effortSelect,
      h('option', { value: '' }, 'Model default'),
      values.map((effort) =>
        h(
          'option',
          { value: effort },
          effort === 'none' ? 'None (no reasoning)' : effort[0]!.toUpperCase() + effort.slice(1),
        ),
      ),
    );
    effortSelect.value = params.reasoningEffort;
  };

  const renderFallbacks = (): void => {
    replace(
      fallbackList,
      params.fallbacks.length === 0
        ? h(
            'li',
            { class: 'list-group-item small text-body-secondary' },
            'None. Only the chosen model is tried.',
          )
        : params.fallbacks.map((id, index) =>
            h(
              'li',
              { class: 'list-group-item d-flex align-items-center gap-2 py-1' },
              h(
                'span',
                { class: 'text-truncate flex-grow-1 small' },
                `${index + 1}. ${modelName(id)}`,
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-link px-1',
                  'aria-label': `Remove fallback ${modelName(id)}`,
                  'data-focus-key': `fallback:${id}`,
                  onclick: () => {
                    params.fallbacks = params.fallbacks.filter((other) => other !== id);
                    saveOptions({ fallbacks: params.fallbacks });
                    renderFallbacks();
                  },
                },
                icon('x-lg'),
              ),
            ),
          ),
    );
  };

  const renderComposer = (): void => {
    const model = effectiveModel();
    replace(
      modelButton,
      icon('cpu'),
      h('span', { class: 'text-truncate' }, model ? modelName(model) : 'No model'),
      current.model === null ? h('span', { class: 'small' }, '(default)') : null,
    );
    modelButton.setAttribute(
      'aria-label',
      `Model for this chat: ${model ? modelName(model) : 'none'}${current.model === null ? ' (the default)' : ''}. Change`,
    );
    modelReset.hidden = current.model === null;
    replace(
      pendingList,
      pending.map((ref) =>
        h(
          'li',
          { class: 'or-chat-attachment', 'data-testid': 'composer-attachment' },
          ref.kind === 'image' && session.get(ref.id)
            ? h('img', { class: 'or-chat-thumb', src: session.get(ref.id)!, alt: '' })
            : icon(KIND_ICONS[ref.kind]),
          h(
            'span',
            { class: 'min-w-0' },
            h('span', { class: 'd-block text-truncate' }, ref.name),
            h('span', { class: 'd-block small text-body-secondary' }, formatBytes(ref.size)),
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-link px-1',
              'aria-label': `Remove ${ref.name}`,
              'data-focus-key': `unattach:${ref.id}`,
              'data-testid': 'composer-attachment-remove',
              onclick: () => {
                pending = pending.filter((other) => other.id !== ref.id);
                session.delete(ref.id);
                renderComposer();
                composer.focus();
                void ui.refreshEstimate();
              },
            },
            icon('x-lg'),
          ),
        ),
      ),
    );
    renderWarnings();
  };

  const warning = (testId: string, text: string, action?: HTMLElement): HTMLElement =>
    h(
      'div',
      {
        class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 py-2 mb-0 small',
        'data-testid': testId,
      },
      icon('exclamation-triangle'),
      h('span', { class: 'flex-grow-1' }, text),
      action ?? null,
    );

  const renderWarnings = (): void => {
    const model = effectiveModel();
    const info = model ? catalog.get(model) : undefined;
    const list: HTMLElement[] = [];
    if (model && ctx.settings.get().freeOnly && !ctx.models.isFree(model)) {
      list.push(
        warning(
          'warning-free-only',
          `Free-only mode is on, and ${modelName(model)} is not free.`,
          current.model !== null
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-secondary',
                  onclick: () => setThreadModel(null),
                },
                'Use the default',
              )
            : undefined,
        ),
      );
    }
    if (
      info &&
      pending.some((ref) => ref.kind === 'image') &&
      !info.inputModalities.includes('image')
    ) {
      const vision = ctx.model('vision').model;
      list.push(
        warning(
          'warning-vision',
          `${modelName(model!)} can't read images.`,
          vision && vision !== model
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-secondary',
                  'data-testid': 'use-vision-model',
                  onclick: () => setThreadModel(vision),
                },
                `Use ${modelName(vision)}`,
              )
            : undefined,
        ),
      );
    }
    if (
      info &&
      pending.some((ref) => ref.kind === 'audio') &&
      !info.inputModalities.includes('audio')
    ) {
      list.push(
        warning(
          'warning-audio',
          `${modelName(model!)} doesn't take audio. Choose a model with audio input to send it.`,
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary',
              onclick: () => void chooseComposerModel(),
            },
            'Choose a model',
          ),
        ),
      );
    }
    warnings.replaceChildren(...list);
  };

  const renderHeader = (): void => {
    titleEl.textContent = current.title;
    const totals = threadTotals(current);
    totalsEl.textContent =
      totals.replies === 0
        ? isEmpty(current)
          ? ''
          : 'No replies yet'
        : [
            plural(totals.replies, 'reply', 'replies'),
            `${formatCount(totals.promptTokens)} in · ${formatCount(totals.completionTokens)} out`,
            `${totals.approximate ? '≈ ' : ''}${formatUsd(totals.costUsd)} in total`,
          ].join(' · ');
    const empty = isEmpty(current);
    renameButton.disabled = empty;
    copyAllButton.disabled = empty;
    exportHost.replaceChildren(
      exportMenu({
        label: 'Export',
        filename: () => current.title,
        disabled: empty,
        testId: 'chat-export',
        formats: [
          {
            label: 'Markdown',
            extension: 'md',
            icon: 'markdown',
            build: () => new Blob([toMarkdown(current)], { type: 'text/markdown' }),
          },
          {
            label: 'JSON',
            extension: 'json',
            icon: 'filetype-json',
            build: () =>
              new Blob([`${JSON.stringify(toJson(current), null, 2)}\n`], {
                type: 'application/json',
              }),
          },
        ],
      }),
    );
  };

  const messageActions: MessageActions = {
    copy: (node) => void copyWithToast(node.content, 'Message copied.'),
    edit: (node) => {
      editing = { id: node.id, text: node.content };
      renderLog();
      log.querySelector<HTMLTextAreaElement>('[data-testid="edit-input"]')?.focus();
    },
    cancelEdit: (node) => {
      editing = null;
      renderLog();
      log.querySelector<HTMLElement>(`[data-focus-key="edit-button:${node.id}"]`)?.focus();
    },
    submitEdit: (node, text) => {
      if (!text.trim() && !node.attachments?.length) {
        ui.status('A message cannot be empty.');
        return;
      }
      editing = { id: node.id, text };
      void trigger({ kind: 'edit', id: node.id, text: text.trim() });
    },
    regenerate: (node) => void trigger({ kind: 'regenerate', id: node.id }),
    retryWith: (node) => {
      void modelPicker(ctx, {
        capability: 'text',
        selected: node.model ?? effectiveModel(),
        title: 'Retry with another model',
      }).then((model) => {
        if (model) void trigger({ kind: 'regenerate', id: node.id, model });
      });
    },
    remove: (node) => void removeBranch(node),
    sibling: (node, delta) => {
      const next = selectSibling(current, node.id, delta);
      if (!next) return;
      persist(current);
      renderLog();
      renderHeader();
      const { index, count } = siblingInfo(current, next);
      announce(`Version ${index + 1} of ${count}.`);
      void ui.refreshEstimate();
    },
  };

  /** Keeps the newest text in view while streaming, unless the reader scrolled up. */
  const follow = (force = false): void => {
    if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) {
      log.scrollTop = log.scrollHeight;
    }
  };

  const renderLog = (): void => {
    const path = activePath(current);
    const streamingHere = live?.thread === current ? live : null;
    log.setAttribute('aria-busy', String(streamingHere !== null));
    if (path.length === 0) {
      replace(
        log,
        emptyState({
          icon: 'chat-dots',
          title: 'Start a conversation',
          text: 'Write a message, attach files or drop them anywhere on the page. Replies stream in here.',
          compact: true,
          testId: 'chat-empty',
        }),
      );
      return;
    }
    if (editing && !current.nodes[editing.id]) editing = null;
    const mctx: MessageContext = {
      thread: current,
      busy: active,
      streamingId: streamingHere?.node.id ?? null,
      editingId: editing?.id ?? null,
      showReasoning: params.showReasoning,
      enterSends: params.enterSends,
      data: (id) => session.get(id),
      modelName,
      isFree: (id) => ctx.models.isFree(id),
      actions: messageActions,
    };
    const views = path.map((node) => ({ node, view: messageView(node, mctx) }));
    replace(
      log,
      views.map(({ view }) => view.element),
    );
    if (editing) {
      const area = log.querySelector<HTMLTextAreaElement>('[data-testid="edit-input"]');
      if (area) {
        area.value = editing.text;
        const state = editing;
        area.addEventListener('input', () => {
          state.text = area.value;
        });
      }
    }
    if (streamingHere) {
      const shown = views.find(({ node }) => node.id === streamingHere.node.id);
      streamingHere.view?.close();
      streamingHere.view = shown ? streamingView(shown.view.body) : null;
      streamingHere.reasoning = shown?.view.reasoning ?? null;
      streamingHere.view?.update(streamingHere.node.content);
    }
  };

  const renderThreads = (): void => {
    const list = [...threads.values()]
      .filter((thread) => matchesQuery(thread, query))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    threadCount.textContent = String(threads.size);
    threadCount.setAttribute('aria-label', plural(threads.size, 'thread'));
    replace(
      threadList,
      list.length === 0
        ? h(
            'li',
            { class: 'list-group-item small text-body-secondary', 'data-testid': 'thread-empty' },
            threads.size === 0 ? 'Your chats appear here.' : 'No thread matches.',
          )
        : list.map((thread) => {
            const selected = thread.id === current.id;
            return h(
              'li',
              {
                class: [
                  'list-group-item d-flex align-items-center gap-1 p-0',
                  selected && 'or-selected',
                ],
                'data-testid': 'thread-item',
              },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn or-thread-option text-start flex-grow-1 min-w-0 px-3 py-2',
                  'aria-current': selected ? 'true' : null,
                  'data-focus-key': `open:${thread.id}`,
                  'data-testid': 'thread-open',
                  onclick: () => openThread(thread.id),
                },
                h(
                  'span',
                  { class: 'd-block text-truncate fw-semibold', 'data-testid': 'thread-title' },
                  thread.title,
                ),
                h(
                  'span',
                  { class: 'd-block small text-body-secondary' },
                  live?.thread === thread ? 'Replying…' : formatRelativeTime(thread.updatedAt),
                ),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-link px-1',
                  'aria-label': `Rename “${thread.title}”`,
                  title: 'Rename',
                  'data-focus-key': `rename:${thread.id}`,
                  'data-testid': 'thread-rename',
                  onclick: () => void renameThread(thread),
                },
                icon('pencil'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-link px-1 me-1',
                  'aria-label': `Delete “${thread.title}”`,
                  title: 'Delete',
                  'data-focus-key': `delete-thread:${thread.id}`,
                  'data-testid': 'thread-delete',
                  onclick: () => void deleteThread(thread),
                },
                icon('trash'),
              ),
            );
          }),
    );
  };

  function renderAll(): void {
    renderComposer();
    renderEffort();
    renderFallbacks();
    renderHeader();
    renderLog();
    renderThreads();
  }

  /** After the current thread changed (opened, new, restored): its system prompt too. */
  function showThread(): void {
    renderParams();
    renderAll();
    void ui.refreshEstimate();
  }

  // --- helpers ------------------------------------------------------------------------------------------
  async function copyWithToast(text: string, done: string): Promise<void> {
    const ok = await copyText(text);
    toast(
      ok
        ? { message: done, variant: 'success' }
        : { message: 'Copying was blocked by the browser.', variant: 'warning' },
    );
  }

  function setThreadModel(model: string | null): void {
    current.model = model;
    persist(current);
    renderComposer();
    renderEffort();
    void ui.refreshEstimate();
    const shown = effectiveModel();
    announce(`This chat now uses ${shown ? modelName(shown) : 'no model'}.`);
  }

  async function chooseComposerModel(): Promise<void> {
    const chosen = await modelPicker(ctx, {
      capability: 'text',
      selected: effectiveModel(),
      title: 'Model for this chat',
    });
    if (chosen) setThreadModel(chosen);
  }

  async function addFallback(): Promise<void> {
    const chosen = await modelPicker(ctx, { capability: 'text', title: 'Add a fallback model' });
    if (!chosen || params.fallbacks.includes(chosen)) return;
    params.fallbacks = [...params.fallbacks, chosen].slice(0, 5);
    saveOptions({ fallbacks: params.fallbacks });
    renderFallbacks();
  }

  async function addFiles(files: File[]): Promise<void> {
    const problems: string[] = [];
    for (const file of files) {
      if (pending.length >= MAX_ATTACHMENTS) {
        problems.push(`At most ${MAX_ATTACHMENTS} files go with one message.`);
        break;
      }
      try {
        const { ref, data } = await readAttachment(file);
        if (data) session.set(ref.id, data);
        pending = [...pending, ref];
      } catch (error) {
        problems.push(userMessage(error));
      }
    }
    renderComposer();
    void ui.refreshEstimate();
    if (problems.length > 0)
      toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
    else if (files.length > 0) announce(`${plural(files.length, 'file')} attached.`);
  }

  function openThread(id: string): void {
    const thread = threads.get(id);
    if (!thread || thread === current) return;
    current = thread;
    editing = null;
    rememberCurrent();
    showThread();
  }

  function newThread(): void {
    if (isEmpty(current) && !threads.has(current.id)) {
      composer.focus();
      return;
    }
    current = createThread({ system: params.system });
    editing = null;
    showThread();
    composer.focus();
    announce('New chat.');
  }

  async function renameThread(thread: Thread): Promise<void> {
    const name = await promptDialog({
      title: 'Rename thread',
      label: 'Name',
      value: thread.title,
      maxLength: 120,
      icon: 'pencil',
    });
    if (name === null) return;
    thread.title = name;
    thread.named = true;
    persist(thread);
    renderHeader();
    renderThreads();
  }

  async function deleteThread(thread: Thread): Promise<void> {
    if (live?.thread === thread) {
      toast({ variant: 'warning', message: 'Stop the reply first, then delete the thread.' });
      return;
    }
    const ok = await confirmDialog({
      title: 'Delete this thread?',
      message: `“${thread.title}” and all its messages and branches will be deleted.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    threads.delete(thread.id);
    queueWrite(() => ctx.state.delete(`${STATE_THREAD}${thread.id}`));
    if (current === thread) {
      const next = [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      current = next ?? createThread({ system: params.system });
      editing = null;
      rememberCurrent();
      showThread();
    } else renderThreads();
    toast({
      message: 'Thread deleted.',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          persist(thread);
          renderThreads();
          announce('Thread restored.');
        },
      },
    });
  }

  async function removeBranch(node: ChatNode): Promise<void> {
    const thread = current;
    const count = (() => {
      let total = 0;
      const stack = [node.id];
      while (stack.length > 0) {
        const next = thread.nodes[stack.pop()!];
        if (!next) continue;
        total++;
        stack.push(...next.children);
      }
      return total;
    })();
    const ok = await confirmDialog({
      title: 'Delete from here?',
      message:
        count > 1
          ? `This message and the ${plural(count - 1, 'message')} after it (on every branch below it) will be deleted.`
          : 'This message will be deleted.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok || active) return;
    const before = cloneThread(thread);
    deleteBranch(thread, node.id);
    persist(thread);
    renderAll();
    void ui.refreshEstimate();
    composer.focus();
    toast({
      message: plural(count, 'message') + ' deleted.',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (active) return;
          threads.set(before.id, before);
          if (current.id === before.id) current = before;
          persist(before);
          renderAll();
          announce('Messages restored.');
        },
      },
    });
  }

  // --- runs ---------------------------------------------------------------------------------------------
  const requestOptions = (
    thread: Thread,
    model: string,
    info: ModelInfo | undefined,
  ): RequestOptions => {
    return {
      model,
      fallbacks: params.fallbacks.filter((id) => id !== model),
      system: thread.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      reasoningEffort: (() => {
        const choices = reasoningChoices(info);
        return choices?.includes(params.reasoningEffort) ? params.reasoningEffort : '';
      })(),
      pdfEngine: params.pdfEngine,
      contextLength: info?.contextLength ?? null,
      maxCompletionTokens: info?.maxCompletionTokens ?? null,
      inputModalities: info?.inputModalities ?? null,
    };
  };

  /** The user message a draft would add, for building requests before it exists. */
  const draftNode = (
    parent: string | null,
    content: string,
    attachments: AttachmentRef[],
  ): ChatNode => ({
    id: 'draft',
    parent,
    children: [],
    selected: null,
    role: 'user',
    content,
    createdAt: Date.now(),
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  const usageOf = (totals: UsageTotals): ChatNode['usage'] =>
    totals.requests === 0
      ? undefined
      : {
          promptTokens: totals.promptTokens,
          completionTokens: totals.completionTokens,
          costUsd: totals.costUsd,
          latencyMs: totals.latencyMsTotal,
          ...(totals.costEstimated ? { costEstimated: true } : {}),
          ...(totals.costUnknown ? { costUnknown: true } : {}),
        };

  async function perform(action: Action, signal: AbortSignal): Promise<void> {
    const thread = current;
    let path: ChatNode[];
    let newUser: { parent: string | null; content: string; attachments: AttachmentRef[] } | null =
      null;
    let answers: string | null = null;
    let replaces: string | null = null;
    let model: string | null;

    if (action.kind === 'send') {
      const text = composer.value.trim();
      if (!text && pending.length === 0) {
        ui.status('Write a message or attach a file first.');
        composer.focus();
        return;
      }
      const parent = leaf(thread)?.id ?? null;
      newUser = { parent, content: text, attachments: pending };
      path = [...activePath(thread), draftNode(parent, text, pending)];
      model = effectiveModel();
    } else if (action.kind === 'edit') {
      const original = thread.nodes[action.id];
      if (original?.role !== 'user') return;
      const attachments = original.attachments ?? [];
      newUser = { parent: original.parent, content: action.text, attachments };
      path = [
        ...(original.parent === null ? [] : pathTo(thread, original.parent)),
        draftNode(original.parent, action.text, attachments),
      ];
      model = effectiveModel();
    } else {
      const reply = thread.nodes[action.id];
      if (reply?.role !== 'assistant' || reply.parent === null) return;
      answers = reply.parent;
      if (reply.status === 'error' && !reply.content) replaces = reply.id;
      path = pathTo(thread, reply.parent);
      model = action.model ?? reply.model ?? effectiveModel();
    }
    if (!model) throw new InvalidInputError('No model is available for this chat.');

    const info = await modelInfo(model);
    const asked = path.at(-1);
    if (
      info &&
      !info.inputModalities.includes('audio') &&
      asked?.attachments?.some((ref) => ref.kind === 'audio' && session.has(ref.id))
    ) {
      throw new InvalidInputError(
        `${info.name} doesn't take audio. Choose a model with audio input for this message.`,
      );
    }

    active = true;
    renderLog();
    try {
      const built = buildRequest(path, requestOptions(thread, model, info), (id) =>
        session.get(id),
      );
      const estimateUsd = await ctx.models.estimate({
        kind: 'tokens',
        model,
        promptTokens: built.promptTokens,
        completionTokens: built.completionTokens,
      });
      const prompt = newUser?.content ?? (answers ? (thread.nodes[answers]?.content ?? '') : '');
      // History keeps the user's message and the settings it ran with (the model actually asked).
      const run: RunHandle = await ctx.beginRun(
        {
          model,
          models: [model, ...(built.body.models ?? [])],
          estimateUsd,
          prompt,
          settings: { ...snapshot().settings, model },
        },
        signal,
      );

      // The run may go ahead: commit the messages.
      let userId = answers;
      if (newUser) {
        userId = addNode(thread, newUser.parent, {
          role: 'user',
          content: newUser.content,
          ...(newUser.attachments.length > 0 ? { attachments: newUser.attachments } : {}),
        }).id;
      }
      if (action.kind === 'send') {
        composer.value = '';
        pending = [];
        renderComposer();
        void ui.refreshEstimate();
      }
      if (action.kind === 'edit') editing = null;
      if (replaces) deleteBranch(thread, replaces);
      const reply = addNode(thread, userId, {
        role: 'assistant',
        content: '',
        model,
        status: 'streaming',
        ...(built.trimmed > 0 ? { trimmed: built.trimmed } : {}),
      });
      persist(thread);
      if (current === thread) rememberCurrent();
      const mine: LiveReply = { thread, node: reply, view: null, reasoning: null };
      live = mine;
      if (current === thread) {
        renderAll();
        follow(true);
        if (action.kind !== 'regenerate') composer.focus();
      }
      ui.status(
        built.trimmed > 0
          ? `Left out ${plural(built.trimmed, 'earlier message')} to fit ${modelName(model)}'s context window.`
          : '',
      );

      try {
        const result = await ctx.api.chatStream(built.body, {
          run,
          onEvent: (event) => {
            const shown = current === thread && live === mine;
            if (event.type === 'text') {
              reply.content += event.text;
              if (shown) {
                mine.view?.update(reply.content);
                follow();
              }
            } else if (event.type === 'reasoning') {
              const first = !reply.reasoning;
              reply.reasoning = (reply.reasoning ?? '') + event.text;
              if (shown && first) renderLog();
              else if (shown && mine.reasoning) mine.reasoning.textContent = reply.reasoning;
            } else if (event.type === 'meta' && event.model) {
              reply.servedModel = event.model;
            }
          },
        });
        reply.content = result.text || reply.content;
        if (result.reasoning) reply.reasoning = result.reasoning;
        if (result.model) reply.servedModel = result.model;
        reply.status = 'done';
        const usage = usageOf(run.totals);
        if (usage) reply.usage = usage;
        if (result.finishReason === 'length') {
          ui.status(
            'The reply hit the token limit. Raise Max tokens in Settings to get longer replies.',
          );
        }
        await run.finish({ output: reply.content, meta: { threadId: thread.id } });
      } catch (error) {
        const usage = usageOf(run.totals);
        if (usage) reply.usage = usage;
        if (isStop(error)) {
          reply.status = 'stopped';
          ui.status(reply.content ? 'Stopped. The partial reply is kept.' : 'Stopped.');
        } else {
          reply.status = 'error';
          reply.error = userMessage(error);
          if (needsAction(error)) {
            // A dialog or a setting helps here; once it has, try this reply again.
            void presentError(error, {
              retry: () => void trigger({ kind: 'regenerate', id: reply.id }),
            });
          } else {
            markPresented(error); // shown inline on the reply, with Retry
          }
        }
        await run.fail(error);
        throw error;
      } finally {
        mine.view?.close();
        if (live === mine) live = null;
        persist(thread);
        // Render the final Markdown before the redraw, so the reply never flashes as plain text.
        if (reply.content) await renderReply(reply.id, reply.content).catch(() => undefined);
      }
    } finally {
      active = false;
      if (current === thread) {
        renderAll();
        follow();
      } else renderThreads();
    }
  }

  let queued: Action | null = null;
  const runner = ui.runner({
    label: 'Send',
    icon: 'send',
    container: runnerHost,
    run: (signal) => {
      const action: Action = queued ?? { kind: 'send' };
      queued = null;
      return perform(action, signal).catch((error: unknown) => {
        // Errors before the run began (no key, budget, free-only…) retry this same action.
        if (!isStop(error)) void presentError(error, { retry: () => void trigger(action) });
        throw error;
      });
    },
  });
  function trigger(action: Action): Promise<void> {
    queued = action;
    const done = runner.trigger();
    queued = null;
    return done;
  }

  // --- keyboard -----------------------------------------------------------------------------------------
  composer.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (
      event.key === 'Enter' &&
      params.enterSends &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      void trigger({ kind: 'send' });
    } else if (
      event.key === 'ArrowUp' &&
      composer.value === '' &&
      pending.length === 0 &&
      !active
    ) {
      const last = [...activePath(current)].reverse().find((node) => node.role === 'user');
      if (last) {
        event.preventDefault();
        messageActions.edit(last);
      }
    }
  });
  composer.addEventListener(
    'input',
    debounce(() => void ui.refreshEstimate(), 300),
  );
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !runner.busy || event.defaultPrevented || modalOpen()) return;
    if (document.querySelector('.offcanvas.show, .dropdown-menu.show')) return;
    event.preventDefault();
    runner.stop();
  });

  // --- live updates -------------------------------------------------------------------------------------
  ctx.settings.subscribe((next, prev) => {
    if (
      next.freeOnly !== prev.freeOnly ||
      next.tools.chat?.model !== prev.tools.chat?.model ||
      next.defaultModels.text !== prev.defaultModels.text
    ) {
      renderComposer();
      renderEffort();
    }
  });
  ctx.bus.on('models-refreshed', loadCatalog);

  // --- state ----------------------------------------------------------------------------------------------
  function snapshot(): ToolSnapshot {
    return {
      prompt: composer.value,
      settings: {
        model: current.model,
        system: current.system,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        reasoningEffort: params.reasoningEffort,
        fallbacks: [...params.fallbacks],
        pdfEngine: params.pdfEngine,
      },
    };
  }

  function applyState({ prompt, settings }: ToolSnapshot): void {
    composer.value = prompt;
    const model = settings['model'];
    // A `?model=` visit (History's "Re-run with another model") asks for its own model: keep the header's.
    if (ctx.modelOverride === null && (model === null || (isString(model) && model))) {
      current.model = model;
    }
    if (isString(settings['system'])) {
      current.system = settings['system'];
      params.system = settings['system'];
    }
    if (settings['temperature'] === null || clampNumber(settings['temperature'], 0, 2) !== null) {
      params.temperature = settings['temperature'] as number | null;
    }
    if (
      settings['maxTokens'] === null ||
      clampNumber(settings['maxTokens'], 1, 10_000_000) !== null
    ) {
      params.maxTokens = settings['maxTokens'] as number | null;
    }
    const restored = paramsFrom(settings);
    if (isString(settings['reasoningEffort'])) params.reasoningEffort = restored.reasoningEffort;
    if (Array.isArray(settings['fallbacks'])) params.fallbacks = restored.fallbacks;
    if (isString(settings['pdfEngine'])) params.pdfEngine = restored.pdfEngine;
    saveOptions({
      system: params.system,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      reasoningEffort: params.reasoningEffort,
      fallbacks: params.fallbacks,
      pdfEngine: params.pdfEngine,
    });
    persist(current);
    showThread();
  }

  renderThreadsOpen(threadsOpen());
  renderParams();
  renderAll();
  loadCatalog();

  return {
    getState: snapshot,
    applyState,
    // The cost of sending the composer now, on this chat's model (the header's unless the chat chose another).
    estimate: async (headerModel) => {
      const model = current.model ?? headerModel;
      const parent = leaf(current)?.id ?? null;
      const built = buildRequest(
        [...activePath(current), draftNode(parent, composer.value, pending)],
        requestOptions(current, model, await modelInfo(model)),
        (id) => session.get(id),
      );
      return ctx.models.estimate({
        kind: 'tokens',
        model,
        promptTokens: built.promptTokens,
        completionTokens: built.completionTokens,
      });
    },
    onFiles: (files) => void addFiles(files),
    onReceive: (items: SendItem[]) => {
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file')
          files.push(new File([item.blob], item.name, { type: item.blob.type }));
        else if (item.name) pending = [...pending, textAttachment(item.name, item.text, item.type)];
        else composer.value = [composer.value, item.text].filter(Boolean).join('\n\n');
      }
      renderComposer();
      void addFiles(files);
      composer.focus();
    },
    sample: () => {
      composer.value = SAMPLE_PROMPT;
      composer.focus();
      void ui.refreshEstimate();
    },
  };
}
