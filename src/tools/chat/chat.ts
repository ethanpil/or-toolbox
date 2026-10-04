/**
 * The Chat tool: threads of branching conversations with any text model.
 *
 * Layout (the three-zone tool layout): the composer and the thread list on the left (input), the conversation on
 * the right (output), sampling/reasoning/system prompt in the Settings drawer, fallbacks and the PDF engine under
 * Advanced. Every send, edit or regenerate is one run (`ctx.beginRun` with an estimate for exactly what is sent,
 * on the dearest of the model and its fallbacks, then `api.chatStream` drawn by `streamMarkdown`); the reply
 * records its model, tokens, cost and latency. The runner takes the action as its argument, so the error toast's
 * Retry repeats exactly that send, edit or regenerate. A PDF sent to the paid parser is a run add-on (`addons()`):
 * free-only mode and budgets see it. The parser's `annotations` come back with the stream; later turns send their
 * text instead of the file.
 *
 * Threads live in the tool's state (`thread:<id>`, `current`); attachment bytes only in memory (`session`), and
 * only while a message still refers to them. Each stored change bumps the thread's `rev`; the store announces it
 * on the bus (`tool-state-changed`), other tabs merge it in, and a tab that finds a newer `rev` than its own base
 * when writing merges first (thread.ts `mergeInto`) instead of writing over it. Looking around (‹ ›, opening a
 * thread) writes nothing.
 *
 * The conversation is a labelled region, not a live region: streamed text is never announced. "Reply started",
 * "Reply complete" and "Stopped" go through `ui.status`. Messages are redrawn one by one, only when what they show
 * changed (view.ts `messageSignature`).
 *
 * `getState`/`applyState` cover the composer (text, model) and the parameters, not the thread: reopening a run
 * from History fills the composer.
 */
import {
  ACCEPT_ATTRIBUTE,
  type AttachmentRef,
  checkText,
  keepParsed,
  MAX_ATTACHMENTS,
  readAttachment,
  SIZE_LIMITS,
  textAttachment,
} from '../../core/attachments/attachments';
import { missingInput, parserAddons as parserAddonsFor } from '../../core/attachments/request';
import { isFreeModelId } from '../../core/models/free';
import {
  isPdfEngineId,
  PDF_ENGINES,
  pdfEngine,
  type PdfEngineId,
} from '../../core/models/pdf-engines';
import type { ModelInfo, RunAddon, RunHandle, UsageTotals } from '../../core/types';
import { InvalidInputError, userMessage } from '../../core/errors';
import { debounce, isFiniteNumber, isString } from '../../core/util';
import { copyWithToast } from '../../ui/clipboard';
import { attachmentChip } from '../../ui/components/attachment-chip';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { modelPicker } from '../../ui/components/model-picker';
import { type MarkdownStream, streamMarkdown } from '../../ui/components/stream-markdown';
import { switchField } from '../../ui/components/switch-field';
import { focusedKey, focusKey, h, replace } from '../../ui/dom';
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
import { queryWords } from '../../ui/shell/palette-search';
import type { SendItem, ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/types';
import { toJson, toMarkdown } from './export';
import { addCodeCopyButtons, codeOf, renderReply } from './markdown-view';
import { type BuiltRequest, buildRequest, type RequestOptions, unparsedPdfs } from './request';
import {
  activePath,
  addNode,
  attachmentIds,
  baseOf,
  type ChatNode,
  createThread,
  deleteBranch,
  isEmpty,
  leaf,
  matchesQuery,
  mergeInto,
  parseThread,
  pathTo,
  type RemovedBranch,
  restoreBranch,
  selectSibling,
  siblingInfo,
  type Thread,
  type ThreadBase,
  threadTotals,
} from './thread';
import {
  applyRunState,
  composing,
  type MessageActions,
  type MessageContext,
  messageSignature,
  type MessageView,
  messageView,
  type RunState,
} from './view';

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Parameters kept in the tool's options (the system prompt here is the default for new threads). */
export interface ChatParams {
  temperature: number | null;
  maxTokens: number | null;
  /** '' = the model's default. */
  reasoningEffort: string;
  fallbacks: string[];
  pdfEngine: PdfEngineId;
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
    pdfEngine: isPdfEngineId(options['pdfEngine']) ? options['pdfEngine'] : 'cloudflare-ai',
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
  /** Draws the reply into its message while it arrives (replaced when the message is redrawn). */
  stream: MarkdownStream | null;
  reasoning: HTMLElement | null;
}

/** A message on screen and what it was drawn from. */
interface Drawn {
  view: MessageView;
  signature: string;
}

const MISSING_INPUT: Readonly<Record<'image' | 'audio' | 'file', (name: string) => string>> = {
  image: (name) => `${name} can't read images. Choose a model with image input for this message.`,
  audio: (name) => `${name} doesn't take audio. Choose a model with audio input for this message.`,
  file: (name) =>
    `${name} can't read PDF files itself. Choose another PDF reader under Fallbacks and PDFs in Settings, or a model with file input.`,
};

export async function setup(ctx: ToolContext): Promise<ToolInstance> {
  const { ui } = ctx;
  const params = paramsFrom(ctx.options.get());
  const threads = new Map<string, Thread>();
  /** What this tab last read or wrote of each stored thread (the base of a merge). */
  const bases = new Map<string, ThreadBase>();
  /** Threads another tab changed while this one was busy with them: read again once it is not. */
  const stale = new Set<string>();
  /** Data URLs of image, PDF and audio attachments, by attachment id: this session only. */
  const session = new Map<string, string>();
  let catalog = new Map<string, ModelInfo>();
  let pending: AttachmentRef[] = [];
  let editing: { id: string; text: string } | null = null;
  let live: LiveReply | null = null;
  /** The runner's state (`runner.subscribe`): what the message buttons may do. */
  let runState: RunState = { busy: false, blocked: false };
  /** Work waiting for the run to end (Undo pressed during a reply). */
  let afterRun: (() => void)[] = [];
  let words: string[] = [];

  // --- stored threads -----------------------------------------------------------------------------------
  let storedCurrent: string | undefined;
  try {
    for (const key of await ctx.state.keys()) {
      if (!key.startsWith(STATE_THREAD)) continue;
      const thread = parseThread(await ctx.state.get(key));
      if (thread && key === `${STATE_THREAD}${thread.id}`) {
        threads.set(thread.id, thread);
        bases.set(thread.id, baseOf(thread));
      }
    }
    storedCurrent = await ctx.state.get<string>(STATE_CURRENT);
  } catch (error) {
    void presentError(error);
  }
  // A link that brings something to work on (a run, a prompt, a sample, items) starts a new chat.
  const fromLink = ['run', 'prompt', 'sample', 'receive'].some((name) =>
    new URLSearchParams(location.search).has(name),
  );
  let current: Thread =
    (!fromLink && storedCurrent ? threads.get(storedCurrent) : undefined) ??
    createThread({ system: params.system });

  let writes: Promise<void> = Promise.resolve();
  const queueWrite = (write: () => Promise<void>): void => {
    writes = writes.then(write).catch((error: unknown) => void presentError(error));
  };

  /** Writes a thread, merging first when another tab stored a newer version since this tab's base. */
  async function write(thread: Thread): Promise<void> {
    const key = `${STATE_THREAD}${thread.id}`;
    const stored = parseThread(await ctx.state.get(key));
    const base = bases.get(thread.id);
    if (stored && base && stored.rev > base.rev) {
      mergeInto(thread, base, stored);
      if (thread === current) {
        renderAll();
        toast({
          variant: 'info',
          message: 'This chat also changed in another tab. Both changes are kept.',
          testId: 'chat-merged',
        });
      } else renderThreads();
    }
    thread.rev = Math.max(thread.rev, stored?.rev ?? 0) + 1;
    await ctx.state.set(key, thread);
    bases.set(thread.id, baseOf(thread));
  }

  /** Stores a thread after a change (drafts are stored once they have a message). */
  const persist = (thread: Thread): void => {
    if (isEmpty(thread) && !threads.has(thread.id)) return;
    const added = !threads.has(thread.id);
    threads.set(thread.id, thread);
    queueWrite(() => write(thread));
    // A chat started here is the one to come back to.
    if (added && thread === current) rememberCurrent();
  };

  /** Remembers the current thread for the next visit, when this tab chose it (never a stale one). */
  const rememberCurrent = (): void => {
    const id = current.id;
    if (!threads.has(id) || storedCurrent === id) return;
    storedCurrent = id;
    queueWrite(() => ctx.state.set(STATE_CURRENT, id));
  };

  /** Drops attachment bytes that no message (and no file waiting in the composer) refers to any more. */
  function releaseUnused(): void {
    const used = new Set(pending.map((ref) => ref.id));
    for (const thread of new Set([...threads.values(), current])) {
      for (const id of attachmentIds(thread)) used.add(id);
    }
    for (const id of session.keys()) if (!used.has(id)) session.delete(id);
  }

  /** The bytes of the attachments of `nodes` (kept by an Undo while the messages are gone). */
  function holdData(nodes: readonly ChatNode[]): Map<string, string> {
    const held = new Map<string, string>();
    for (const node of nodes) {
      for (const ref of node.attachments ?? []) {
        const data = session.get(ref.id);
        if (data !== undefined) held.set(ref.id, data);
      }
    }
    return held;
  }

  const busyWith = (id: string): boolean =>
    live?.thread.id === id || (current.id === id && editing !== null);

  /** Reads a thread another tab changed and takes its changes in (deferred while busy with it here). */
  function refresh(id: string): void {
    if (busyWith(id)) {
      stale.add(id);
      return;
    }
    stale.delete(id);
    queueWrite(async () => {
      const stored = parseThread(await ctx.state.get(`${STATE_THREAD}${id}`));
      const mine = threads.get(id) ?? (current.id === id ? current : undefined);
      const base = bases.get(id);
      if (!stored) {
        if (mine && base) dropThread(mine, 'This chat was deleted in another tab.');
        return;
      }
      if (base && stored.rev <= base.rev) return;
      if (busyWith(id)) {
        stale.add(id);
        return;
      }
      if (mine && base) mergeInto(mine, base, stored);
      const thread = mine ?? stored;
      threads.set(id, thread);
      bases.set(id, baseOf(thread));
      releaseUnused();
      if (thread === current) {
        renderAll();
        void ui.refreshEstimate();
      } else renderThreads();
    });
  }

  const refreshStale = (): void => {
    for (const id of [...stale]) refresh(id);
  };

  /** Forgets a thread deleted elsewhere; the current one gives way to the newest other thread. */
  function dropThread(thread: Thread, message: string): void {
    threads.delete(thread.id);
    bases.delete(thread.id);
    if (thread === current) {
      current =
        [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0] ??
        createThread({ system: params.system });
      editing = null;
      showThread();
      toast({ variant: 'info', message, testId: 'chat-deleted-elsewhere' });
    } else renderThreads();
    releaseUnused();
  }

  // Stored threads change here and in other tabs: read them again (our own writes compare equal and stop there).
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool === ctx.manifest.id && event.key.startsWith(STATE_THREAD)) {
      refresh(event.key.slice(STATE_THREAD.length));
    }
  });

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
      class: 'btn btn-sm btn-link or-chat-action',
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
  /** Chips of the files waiting in the composer, kept while they wait (a thumbnail is drawn once). */
  const pendingItems = new Map<string, HTMLElement>();
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
  const searchSoon = debounce(() => {
    words = queryWords(threadSearch.value);
    renderThreads();
  }, 150);
  const threadSearch = h('input', {
    type: 'search',
    class: 'form-control form-control-sm',
    placeholder: 'Search titles and messages',
    'aria-label': 'Search threads',
    'data-testid': 'thread-search',
    oninput: () => searchSoon(),
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
    class: 'btn btn-sm btn-link or-chat-action',
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
  const threadsHeading = h(
    'h3',
    { id: `${ids.threads}-title`, class: 'h6 mb-0', tabIndex: -1 },
    'Threads',
  );
  ui.input.append(
    h(
      'section',
      { class: 'or-chat-threads border-top pt-3', 'aria-labelledby': `${ids.threads}-title` },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        threadsHeading,
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
      class: 'btn btn-sm btn-link or-chat-action',
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
  // A labelled region, not a live region: streamed text must not be read out as it arrives.
  const log = h('div', {
    class: 'or-chat-log',
    role: 'region',
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
    engine: uid('pdf-engine'),
  };
  const saveOptions = (patch: Partial<ChatParams>): void => {
    try {
      ctx.options.set(patch);
    } catch (error) {
      void presentError(error);
    }
  };
  /** The thread whose system prompt was typed into and not stored yet. */
  let systemTyped: Thread | null = null;
  const flushSystem = (): void => {
    saveSystemSoon.cancel();
    const thread = systemTyped;
    systemTyped = null;
    if (!thread) return;
    saveOptions({ system: params.system });
    persist(thread);
  };
  const saveSystemSoon = debounce(flushSystem, 400);
  const systemArea = h('textarea', {
    id: drawerIds.system,
    class: 'form-control',
    rows: 5,
    placeholder: 'For example: You are a concise assistant for a busy engineer.',
    'data-testid': 'chat-system',
    oninput: () => {
      current.system = systemArea.value;
      params.system = systemArea.value;
      systemTyped = current;
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
  const showReasoning = switchField({
    label: 'Show reasoning when the model returns it',
    testId: 'chat-show-reasoning',
    checked: params.showReasoning,
    onChange: (on) => {
      params.showReasoning = on;
      saveOptions({ showReasoning: on });
      renderLog();
    },
  });
  const enterSends = switchField({
    label: 'Enter sends (Shift+Enter for a new line)',
    testId: 'chat-enter-sends',
    checked: params.enterSends,
    onChange: (on) => {
      params.enterSends = on;
      saveOptions({ enterSends: on });
      renderKeyHint();
      renderLog();
    },
  });
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
    showReasoning.element,
    enterSends.element,
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
      'aria-describedby': `${drawerIds.engine}-hint`,
      onchange: () => {
        params.pdfEngine = isPdfEngineId(engineSelect.value) ? engineSelect.value : 'cloudflare-ai';
        saveOptions({ pdfEngine: params.pdfEngine });
        renderEngineHint();
        renderWarnings();
        void ui.refreshEstimate();
      },
    },
    PDF_ENGINES.map((engine) => h('option', { value: engine.id }, engine.label)),
  );
  const engineHint = h('div', { id: `${drawerIds.engine}-hint`, class: 'form-text' });
  const renderEngineHint = (): void => {
    engineHint.textContent = `${pdfEngine(params.pdfEngine).hint} A PDF is read once; later messages send its text.`;
  };
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
        'When the model fails (rate limit, outage, context too long), OpenRouter tries these in order. The reply says which model answered, and the estimate assumes the dearest of them.',
      ),
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: drawerIds.engine }, 'PDF reader'),
      engineSelect,
      engineHint,
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
    renderEngineHint();
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
                  class: 'btn btn-sm btn-link or-chat-action',
                  'aria-label': `Remove fallback ${modelName(id)}`,
                  'data-focus-key': `fallback:${id}`,
                  onclick: () => {
                    params.fallbacks = params.fallbacks.filter((other) => other !== id);
                    saveOptions({ fallbacks: params.fallbacks });
                    renderFallbacks();
                    renderWarnings();
                    void ui.refreshEstimate();
                  },
                },
                icon('x-lg'),
              ),
            ),
          ),
    );
  };

  /** A composer chip for a file waiting to be sent; built once per file. */
  const pendingItem = (ref: AttachmentRef): HTMLElement => {
    const data = session.get(ref.id);
    return attachmentChip({
      ref,
      ...(data ? { data } : {}),
      testId: 'composer-attachment',
      remove: {
        focusKey: `unattach:${ref.id}`,
        testId: 'composer-attachment-remove',
        onClick: () => {
          pending = pending.filter((other) => other.id !== ref.id);
          releaseUnused();
          renderComposer();
          composer.focus();
          void ui.refreshEstimate();
        },
      },
    });
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
    const items = pending.map((ref) => {
      let item = pendingItems.get(ref.id);
      if (!item) pendingItems.set(ref.id, (item = pendingItem(ref)));
      return item;
    });
    for (const id of pendingItems.keys()) {
      if (!pending.some((ref) => ref.id === id)) pendingItems.delete(id);
    }
    const unchanged =
      items.length === pendingList.children.length &&
      items.every((item, index) => pendingList.children[index] === item);
    if (!unchanged) replace(pendingList, items);
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
    const key = ctx.keys.resolve('chat');
    const paidFallback = params.fallbacks.find((id) => !isFreeModelId(id));
    if (key?.noRetention && model && isFreeModelId(model) && paidFallback) {
      // The client asks for providers that keep no data, which no free model is.
      list.push(
        warning(
          'warning-retention',
          `Your key “${key.name}” is set to no data retention, so OpenRouter skips the free ${modelName(model)} and answers with ${modelName(paidFallback)}, which is paid.`,
        ),
      );
    }
    const missing = info
      ? missingInput(pending, info.inputModalities, params.pdfEngine, (id) => session.has(id))
      : null;
    if (missing === 'image') {
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
    } else if (missing) {
      list.push(
        warning(
          missing === 'audio' ? 'warning-audio' : 'warning-file',
          MISSING_INPUT[missing](modelName(model!)),
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
      if (runState.busy) return;
      editing = { id: node.id, text: node.content };
      renderLog();
      focusKey(log, `edit:${node.id}`);
    },
    cancelEdit: (node) => {
      editing = null;
      renderLog();
      focusKey(log, `edit-button:${node.parent ?? 'root'}`);
      refreshStale();
    },
    submitEdit: (node, text) => {
      if (!text.trim() && !node.attachments?.length) {
        ui.status('A message cannot be empty.');
        return;
      }
      editing = { id: node.id, text };
      void runner.trigger({ kind: 'edit', id: node.id, text: text.trim() });
    },
    // Ignored while the runner cannot start (busy, no model): `trigger` answers `.started === false`.
    regenerate: (node) => void runner.trigger({ kind: 'regenerate', id: node.id }),
    retryWith: (node) => {
      if (runState.busy || runState.blocked) return;
      void modelPicker(ctx, {
        capability: 'text',
        selected: node.model ?? effectiveModel(),
        title: 'Retry with another model',
      }).then((model) => {
        if (model) void runner.trigger({ kind: 'regenerate', id: node.id, model });
      });
    },
    remove: (node) => void removeBranch(node),
    sibling: (node, delta) => {
      if (runState.busy) return;
      // Looking at another version changes nothing worth storing (and nothing other tabs need).
      const next = selectSibling(current, node.id, delta);
      if (!next) return;
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

  /** Focus back on a control of the conversation: the same one, else another at the same place, else the log. */
  const refocus = (key: string): void => {
    const at = key.slice(key.indexOf(':') + 1);
    for (const candidate of [key, `regen:${at}`, `edit-button:${at}`, `copy:${at}`]) {
      if (focusKey(log, candidate)) return;
    }
    log.focus();
  };

  const drawn = new Map<string, Drawn>();
  let drawnThread: string | null = null;
  let emptyView: HTMLElement | null = null;

  /** Draws the active path, redrawing only messages whose signature changed. */
  const renderLog = (): void => {
    const lostKey = focusedKey(log);
    const path = activePath(current);
    const streamingHere = live?.thread === current ? live : null;
    log.setAttribute('aria-busy', String(streamingHere !== null));
    if (drawnThread !== current.id) {
      drawn.clear();
      log.replaceChildren();
      drawnThread = current.id;
    }
    if (path.length === 0) {
      drawn.clear();
      emptyView ??= emptyState({
        icon: 'chat-dots',
        title: 'Start a conversation',
        text: 'Write a message, attach files or drop them anywhere on the page. Replies stream in here.',
        compact: true,
        testId: 'chat-empty',
      });
      log.replaceChildren(emptyView);
      return;
    }
    emptyView?.remove();
    if (editing && !current.nodes[editing.id]) editing = null;
    const mctx: MessageContext = {
      thread: current,
      run: runState,
      streamingId: streamingHere?.node.id ?? null,
      editingId: editing?.id ?? null,
      showReasoning: params.showReasoning,
      enterSends: params.enterSends,
      data: (id) => session.get(id),
      modelName,
      isFree: (id) => ctx.models.isFree(id),
      actions: messageActions,
    };
    let previous: Element | null = null;
    let streamingDrawn = false;
    const shown = new Set<string>();
    for (const node of path) {
      const signature = messageSignature(node, mctx);
      let entry = drawn.get(node.id);
      if (entry?.signature !== signature) {
        const view = messageView(node, mctx);
        entry?.view.element.replaceWith(view.element);
        entry = { view, signature };
        drawn.set(node.id, entry);
        if (node.id === streamingHere?.node.id) streamingDrawn = true;
        if (editing?.id === node.id) wireEditor(view.element, editing);
      }
      const element = entry.view.element;
      const expected: Element | null = previous
        ? previous.nextElementSibling
        : log.firstElementChild;
      if (expected !== element) log.insertBefore(element, expected);
      previous = element;
      shown.add(node.id);
    }
    for (const [id, entry] of drawn) {
      if (shown.has(id)) continue;
      entry.view.element.remove();
      drawn.delete(id);
    }
    while (previous?.nextElementSibling) previous.nextElementSibling.remove();
    applyRunState(log, runState);
    if (streamingHere && (streamingDrawn || !streamingHere.stream)) {
      const entry = drawn.get(streamingHere.node.id);
      streamingHere.stream?.dispose();
      streamingHere.stream = entry ? replyStream(entry.view.body) : null;
      streamingHere.reasoning = entry?.view.reasoning ?? null;
      if (streamingHere.node.content) streamingHere.stream?.set(streamingHere.node.content);
    }
    if (lostKey && !log.contains(document.activeElement)) refocus(lostKey);
  };

  /** The shared streaming renderer for a reply that is arriving, with Copy buttons on its code blocks. */
  const replyStream = (body: HTMLElement): MarkdownStream =>
    streamMarkdown(body, {
      onRender: () => {
        addCodeCopyButtons(body);
        follow();
      },
    });

  /** The message editor keeps what was typed across redraws. */
  const wireEditor = (element: HTMLElement, state: { text: string }): void => {
    const area = element.querySelector('textarea');
    if (!area) return;
    area.value = state.text;
    area.addEventListener('input', () => {
      state.text = area.value;
    });
  };

  const renderThreads = (): void => {
    const list = [...threads.values()]
      .filter((thread) => matchesQuery(thread, words))
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
                  class: 'btn btn-sm btn-link or-chat-action',
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
                  class: 'btn btn-sm btn-link or-chat-action me-1',
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
  function setThreadModel(model: string | null): void {
    if (current.model === model) return;
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
    renderWarnings();
    void ui.refreshEstimate();
  }

  /** Adds an attachment to the composer, within the count and the per-message text limit. */
  function attach(ref: AttachmentRef, data?: string): void {
    if (pending.length >= MAX_ATTACHMENTS) {
      throw new InvalidInputError(`At most ${MAX_ATTACHMENTS} files go with one message.`);
    }
    if (ref.kind === 'text') checkText(pending, ref.name, ref.size);
    if (data) session.set(ref.id, data);
    pending = [...pending, ref];
  }

  async function addFiles(files: File[]): Promise<void> {
    const problems: string[] = [];
    let added = 0;
    for (const file of files) {
      try {
        if (pending.length >= MAX_ATTACHMENTS) {
          throw new InvalidInputError(`At most ${MAX_ATTACHMENTS} files go with one message.`);
        }
        const { ref, data } = await readAttachment(file);
        attach(ref, data);
        added++;
      } catch (error) {
        problems.push(userMessage(error));
      }
    }
    renderComposer();
    void ui.refreshEstimate();
    if (problems.length > 0)
      toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
    else if (added > 0) announce(`${plural(added, 'file')} attached.`);
  }

  function openThread(id: string): void {
    const thread = threads.get(id);
    if (!thread || thread === current) return;
    flushSystem();
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
    flushSystem();
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
    if (name === null || (name === thread.title && thread.named)) return;
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
    if (!ok || live?.thread === thread) return;
    if (systemTyped === thread) flushSystem();
    const held = holdData(Object.values(thread.nodes));
    threads.delete(thread.id);
    bases.delete(thread.id);
    queueWrite(() => ctx.state.delete(`${STATE_THREAD}${thread.id}`));
    if (current === thread) {
      const next = [...threads.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      current = next ?? createThread({ system: params.system });
      editing = null;
      rememberCurrent();
      showThread();
    } else renderThreads();
    releaseUnused();
    // The list's redraw moved focus to the nearest thread left (replace()); with none left, to the heading.
    if (!threadList.contains(document.activeElement)) threadsHeading.focus();
    toast({
      message: 'Thread deleted.',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (threads.has(thread.id)) return;
          for (const [id, data] of held) if (!session.has(id)) session.set(id, data);
          persist(thread);
          renderThreads();
          announce('Thread restored.');
        },
      },
    });
  }

  async function removeBranch(node: ChatNode): Promise<void> {
    if (runState.busy) return;
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
    if (!ok || runState.busy || !thread.nodes[node.id]) return;
    const removed = deleteBranch(thread, node.id);
    if (!removed) return;
    const held = holdData(removed.nodes);
    persist(thread);
    releaseUnused();
    renderAll();
    void ui.refreshEstimate();
    composer.focus();
    toast({
      message: plural(removed.nodes.length, 'message') + ' deleted.',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (runState.busy) {
            // Never change a thread under a reply that is arriving: put the messages back after it.
            afterRun.push(() => undoRemove(thread.id, removed, held));
            ui.status('The messages come back when the reply has finished.');
          } else undoRemove(thread.id, removed, held);
        },
      },
    });
  }

  /** Puts a deleted branch back into the thread as it is now (not a copy of the thread from before). */
  function undoRemove(threadId: string, removed: RemovedBranch, held: Map<string, string>): void {
    const thread = threads.get(threadId) ?? (current.id === threadId ? current : undefined);
    if (!thread) {
      toast({
        variant: 'warning',
        message: 'The messages cannot come back: their thread was deleted.',
      });
      return;
    }
    if (!restoreBranch(thread, removed)) {
      toast({
        variant: 'warning',
        message:
          'The messages cannot come back: the message they followed was deleted since, or they are back already.',
        testId: 'undo-refused',
      });
      return;
    }
    for (const [id, data] of held) if (!session.has(id)) session.set(id, data);
    persist(thread);
    if (thread === current) {
      renderAll();
      void ui.refreshEstimate();
    } else renderThreads();
    announce('Messages restored.');
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

  /** The cost of a request on the dearest of its models (a fallback may answer); null when the first is unknown. */
  async function estimateFor(built: BuiltRequest): Promise<number | null> {
    const models = [built.body.model, ...(built.body.models ?? [])];
    const costs = await Promise.all(
      models.map((model) =>
        ctx.models
          .estimate({
            kind: 'tokens',
            model,
            promptTokens: built.promptTokens,
            completionTokens: built.completionTokens,
          })
          .catch(() => null),
      ),
    );
    if (costs[0] === null || costs[0] === undefined) return null;
    return Math.max(...costs.filter((cost): cost is number => cost !== null));
  }

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
    const name = info?.name ?? model;
    // Before anything is booked: what the model cannot read, what the plan does not allow, what does not fit.
    const asked = path.at(-1);
    const missing =
      info && asked
        ? missingInput(asked.attachments ?? [], info.inputModalities, params.pdfEngine, (id) =>
            session.has(id),
          )
        : null;
    if (missing) throw new InvalidInputError(MISSING_INPUT[missing](name));
    const data = (id: string): string | undefined => session.get(id);
    const toParse = params.pdfEngine === 'native' ? [] : unparsedPdfs(path, data);
    const built = buildRequest(path, requestOptions(thread, model, info), data);
    if (built.tooLong) {
      throw new InvalidInputError(
        `This message is too long for ${name}: about ${formatCount(built.promptTokens)} tokens, and the model reads ${formatCount(info?.contextLength ?? 0)} with its answer. Shorten it, remove an attachment, or choose a model with a larger context window.`,
      );
    }

    try {
      const estimateUsd = await estimateFor(built);
      const prompt = newUser?.content ?? (answers ? (thread.nodes[answers]?.content ?? '') : '');
      // History keeps the user's message and the settings it ran with (the model actually asked).
      const run: RunHandle = await ctx.beginRun(
        {
          model,
          models: [model, ...(built.body.models ?? [])],
          estimateUsd,
          // What this request parses (an edit or regenerate may differ from the composer's `addons()`).
          addons: parserAddons(toParse),
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
      const mine: LiveReply = { thread, node: reply, stream: null, reasoning: null };
      live = mine;
      if (current === thread) {
        renderAll();
        follow(true);
        if (action.kind !== 'regenerate') composer.focus();
      } else renderThreads();
      ui.status(
        built.trimmed > 0
          ? `Reply started. Left out ${plural(built.trimmed, 'earlier message')} to fit ${name}'s context window.`
          : 'Reply started.',
      );

      try {
        const answer = await ctx.api.chatStream(built.body, {
          run,
          onEvent: (event) => {
            const shown = current === thread && live === mine;
            if (event.type === 'text') {
              reply.content += event.text;
              if (shown) mine.stream?.append(event.text);
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
        keepParsed(toParse, answer.annotations);
        reply.content = answer.text || reply.content;
        if (answer.reasoning) reply.reasoning = answer.reasoning;
        if (answer.model) reply.servedModel = answer.model;
        reply.status = 'done';
        const usage = usageOf(run.totals);
        if (usage) reply.usage = usage;
        ui.status(
          answer.finishReason === 'length'
            ? 'Reply complete. It hit the token limit: raise Max tokens in Settings for longer replies.'
            : 'Reply complete.',
        );
        await run.finish({ output: reply.content, meta: { threadId: thread.id } });
      } catch (error) {
        const usage = usageOf(run.totals);
        if (usage) reply.usage = usage;
        if (isStop(error)) {
          reply.status = 'stopped';
          ui.status(reply.content ? 'Stopped. The partial reply is kept.' : 'Stopped.');
          markPresented(error); // announced here; the runner adds nothing
        } else {
          reply.status = 'error';
          reply.error = userMessage(error);
          ui.status(`The reply failed: ${reply.error}`);
          if (needsAction(error)) {
            // A dialog or a setting helps here; once it has, try this reply again.
            // The runner's own Retry would repeat the send (a second message): retry this reply instead.
            void presentError(error, {
              retry: () => void runner.trigger({ kind: 'regenerate', id: reply.id }),
            });
          } else {
            markPresented(error); // shown inline on the reply, with Retry
          }
        }
        await run.fail(error);
        throw error;
      } finally {
        mine.stream?.dispose();
        if (live === mine) live = null;
        persist(thread);
        releaseUnused();
        // Render the final Markdown before the redraw, so the reply never flashes as plain text.
        if (reply.content) await renderReply(reply.id, reply.content).catch(() => undefined);
      }
    } finally {
      if (current === thread) {
        renderAll();
        follow();
      } else renderThreads();
      const waiting = afterRun;
      afterRun = [];
      for (const work of waiting) work();
      refreshStale();
    }
  }

  // The action is the runner's argument: a refused run's Retry (no key, budget, free-only…) repeats exactly it.
  // Ctrl/Cmd+Enter and the Send button pass none: a send.
  const runner = ui.runner<Action>({
    label: 'Send',
    icon: 'send',
    container: runnerHost,
    run: (signal, action) => perform(action ?? { kind: 'send' }, signal),
  });
  runner.subscribe(({ busy, disabledReason }) => {
    runState = { busy, blocked: disabledReason !== null };
    applyRunState(log, runState);
  });

  // --- keyboard -----------------------------------------------------------------------------------------
  composer.addEventListener('keydown', (event) => {
    if (composing(event)) return;
    if (
      event.key === 'Enter' &&
      params.enterSends &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      void runner.trigger({ kind: 'send' });
    } else if (
      event.key === 'ArrowUp' &&
      composer.value === '' &&
      pending.length === 0 &&
      !runState.busy
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
    if (event.key !== 'Escape' || composing(event) || !runner.busy || event.defaultPrevented) {
      return;
    }
    if (modalOpen() || document.querySelector('.offcanvas.show, .dropdown-menu.show')) return;
    // Fields other than the composer use Escape themselves (search clears, a select closes).
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target !== composer &&
      (target.isContentEditable || target.matches('input, select, textarea'))
    ) {
      return;
    }
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
  ctx.keys.subscribe(() => renderWarnings());
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
    const before = { model: current.model, system: current.system };
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
    if (current.model !== before.model || current.system !== before.system) persist(current);
    showThread();
  }

  renderThreadsOpen(threadsOpen());
  renderParams();
  renderAll();
  loadCatalog();

  /** The paid PDF parser for these PDFs, as run add-ons (none for the free engines). */
  const parserAddons = (pdfs: readonly AttachmentRef[]): RunAddon[] =>
    parserAddonsFor(params.pdfEngine, pdfs);

  return {
    getState: snapshot,
    // Sending the composer now: the PDFs it would parse (its own and earlier unread ones).
    addons: () => {
      if (params.pdfEngine === 'native') return [];
      const path = [...activePath(current), draftNode(null, '', pending)];
      return parserAddons(unparsedPdfs(path, (id) => session.get(id)));
    },
    applyState,
    // The cost of sending the composer now, on this chat's model (the header's unless the chat chose another),
    // or on the dearest fallback.
    estimate: async (headerModel) => {
      const model = current.model ?? headerModel;
      const parent = leaf(current)?.id ?? null;
      const built = buildRequest(
        [...activePath(current), draftNode(parent, composer.value, pending)],
        requestOptions(current, model, await modelInfo(model)),
        (id) => session.get(id),
      );
      return estimateFor(built);
    },
    onFiles: (files) => void addFiles(files),
    onReceive: (items: SendItem[]) => {
      const files: File[] = [];
      const problems: string[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          files.push(new File([item.blob], item.name, { type: item.blob.type }));
          continue;
        }
        try {
          if (item.name) attach(textAttachment(item.name, item.text, item.type));
          else {
            const size = new Blob([item.text]).size;
            if (size > SIZE_LIMITS.text) {
              throw new InvalidInputError(
                `The text sent here is ${formatBytes(size)}. A message takes at most ${formatBytes(SIZE_LIMITS.text)} of typed text; send it as a file instead.`,
              );
            }
            composer.value = [composer.value, item.text].filter(Boolean).join('\n\n');
          }
        } catch (error) {
          problems.push(userMessage(error));
        }
      }
      renderComposer();
      if (problems.length > 0) {
        toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
      }
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
