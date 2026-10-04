/**
 * Bot-to-bot chat: two models talk to each other while the user moderates, within hard limits.
 *
 * Layout (the three-zone tool layout): the setup on the left (Bot A and Bot B, each with a name, a model and an
 * optional persona; the opening prompt, who speaks first, the limits, and the framing each bot gets, read-only),
 * the conversation on the right (totals against each limit, the transcript, the moderator's composer), Max tokens
 * per turn in the Settings drawer. The run bar holds Start/Resume and Step, or Pause and Stop while it runs.
 *
 * **Runs.** Each Start, Resume or Step is one run (`models: [A, B]`, `groupId` = the conversation's id), booked
 * with min(cost cap minus spent, per-turn estimate × turns left): an upper bound budgets and the reservation can
 * use. The run checkpoints the transcript (Markdown) after every turn and finishes with it, so History shows the
 * conversation as its replay. Everything a run needs is checked before `beginRun` (opener, names, limits, the other
 * tab), and the conversation changes only once it resolves, so a refused run changes nothing. The bots' names,
 * personas and models are fixed for a run; the limits are read live (a limit raised while paused applies on
 * Resume). The loop and the stop conditions are in loop.ts.
 *
 * **Persistence.** The conversation (text only) is the tool state `conversation`; every change bumps its `rev`. It
 * survives a reload, coming back paused (a turn cut off by the reload keeps its text as stopped). A tab that is not
 * running follows a newer stored version; the tab that runs a conversation holds the Web Lock
 * `ortoolbox:bot-to-bot:<id>`, so no second tab can run it at the same time. A run in progress is guarded by the
 * shell's leave guard (`runs.active()`).
 *
 * The transcript is a labelled region, not a live region: turn starts, ends and stops go through `ui.status`.
 * Entries are redrawn only when their signature changes (view.ts); the run's state never rebuilds them.
 */
import { InvalidInputError, isAbortError, userMessage } from '../../core/errors';
import { webLocks } from '../../core/jobs/index';
import { excerpt } from '../../core/runs/index';
import type { ModelInfo, RunHandle, Usage } from '../../core/types';
import { debounce, isFiniteNumber, isPlainObject, isString, MINUTE_MS } from '../../core/util';
import { copyWithToast } from '../../ui/clipboard';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { modelPicker } from '../../ui/components/model-picker';
import { type MarkdownStream, streamMarkdown } from '../../ui/components/stream-markdown';
import { focusedKey, focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented, needsAction, presentError } from '../../ui/feedback/errors';
import { modalOpen } from '../../ui/feedback/modal';
import { toast } from '../../ui/feedback/toast';
import { formatMs, formatShortcut, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/types';
import {
  type BotRecord,
  type Conversation,
  createConversation,
  dropFailedEmpty,
  editEntry,
  endedBy,
  type Entry,
  isSpoken,
  newId,
  nextSpeaker,
  opener,
  parseConversation,
  type Speaker,
  SPEAKERS,
  type StopReason,
  touch,
  turnCount,
  type TurnUsage,
  undoEdit,
} from './conversation';
import { toJson, toMarkdown } from './export';
import { clock, END_TITLES, endText } from './format';
import {
  blockedBy,
  type Limits,
  type LoopEnd,
  type LoopMode,
  runLoop,
  type TurnResult,
} from './loop';
import { type BotProfile, buildTurn, type BuiltTurn, framing, type TurnOptions } from './request';
import {
  applyBusy,
  avatar,
  composing,
  type EntryContext,
  entrySignature,
  entryView,
  type EntryView,
  prerender,
} from './view';

const STATE_KEY = 'conversation';

export const DEFAULT_NAMES: Readonly<Record<Speaker, string>> = { a: 'Bot A', b: 'Bot B' };

/** The manifest's defaults (a unit test keeps them in step); used when a stored value is unusable. */
export const DEFAULT_LIMITS = {
  turnLimit: 20,
  timeLimitMinutes: 5,
  costCapUsd: 0.25,
  stopPhrase: '[END]',
  maxTokens: 1000,
} as const;

export const RANGES = {
  turnLimit: { min: 1, max: 200 },
  timeLimitMinutes: { min: 0.1, max: 120 },
  costCapUsd: { min: 0, max: 100 },
  maxTokens: { min: 16, max: 200_000 },
} as const;

export interface BotSettings {
  /** As typed; '' shows and sends the default name. */
  name: string;
  /** null: the tool's model (the header's). */
  model: string | null;
  persona: string;
}

export interface BotsParams {
  botA: BotSettings;
  botB: BotSettings;
  first: Speaker;
  turnLimit: number;
  timeLimitMinutes: number;
  costCapUsd: number;
  stopPhrase: string;
  /** null: the model's default. */
  maxTokens: number | null;
}

const BOT_KEY = { a: 'botA', b: 'botB' } as const;

const inRange = (value: unknown, min: number, max: number): number | null =>
  isFiniteNumber(value) && value >= min && value <= max ? value : null;

function botFrom(value: unknown, speaker: Speaker): BotSettings {
  const bot = isPlainObject(value) ? value : {};
  const model = bot['model'];
  return {
    name: isString(bot['name']) ? bot['name'].slice(0, 40) : DEFAULT_NAMES[speaker],
    model: isString(model) && model ? model : null,
    persona: isString(bot['persona']) ? bot['persona'] : '',
  };
}

/** The parameters from saved options or a snapshot's settings (anything unusable falls back to its default). */
export function paramsFrom(options: Record<string, unknown>): BotsParams {
  const turns = inRange(options['turnLimit'], RANGES.turnLimit.min, RANGES.turnLimit.max);
  const maxTokens = options['maxTokens'];
  return {
    botA: botFrom(options['botA'], 'a'),
    botB: botFrom(options['botB'], 'b'),
    first: options['first'] === 'b' ? 'b' : 'a',
    turnLimit: turns === null ? DEFAULT_LIMITS.turnLimit : Math.round(turns),
    timeLimitMinutes:
      inRange(
        options['timeLimitMinutes'],
        RANGES.timeLimitMinutes.min,
        RANGES.timeLimitMinutes.max,
      ) ?? DEFAULT_LIMITS.timeLimitMinutes,
    costCapUsd:
      inRange(options['costCapUsd'], RANGES.costCapUsd.min, RANGES.costCapUsd.max) ??
      DEFAULT_LIMITS.costCapUsd,
    stopPhrase: isString(options['stopPhrase'])
      ? options['stopPhrase'].slice(0, 60)
      : DEFAULT_LIMITS.stopPhrase,
    maxTokens:
      maxTokens === null
        ? null
        : (inRange(maxTokens, RANGES.maxTokens.min, RANGES.maxTokens.max) ??
          DEFAULT_LIMITS.maxTokens),
  };
}

/** The snapshot's settings for `params` (what Prompts saves, History keeps and `applyState` restores). */
export function settingsOf(params: BotsParams): Record<string, unknown> {
  return {
    botA: { ...params.botA },
    botB: { ...params.botB },
    first: params.first,
    turnLimit: params.turnLimit,
    timeLimitMinutes: params.timeLimitMinutes,
    costCapUsd: params.costCapUsd,
    stopPhrase: params.stopPhrase,
    maxTokens: params.maxTokens,
  };
}

/** Onboarding's sample: two free models, a fun opener. */
export const SAMPLE = {
  opener:
    'Together, invent a new holiday the whole world could celebrate. Agree on its name, its date and one tradition.',
  bots: {
    a: {
      name: 'Sage',
      persona:
        'You are a calm philosopher who builds on ideas with curiosity and asks one good question at a time. Keep each reply under 80 words.',
    },
    b: {
      name: 'Spark',
      persona:
        'You are an enthusiastic inventor who loves bold but practical ideas. Keep each reply under 80 words.',
    },
  },
  turnLimit: 8,
  /** Preferred free models (2026-10-02 catalog); others from the catalog stand in when these are gone. */
  models: ['qwen/qwen3.8-27b:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
} as const;

type Action = 'start' | 'resume' | 'step';

/** A run handle that also tells `tap` about every usage the API client reports (a turn's own usage). */
function tapUsage(run: RunHandle, tap: (usage: Usage) => void): RunHandle {
  return new Proxy(run, {
    get(target, key) {
      if (key === 'addUsage') {
        return (usage: Usage) => {
          tap(usage);
          target.addUsage(usage);
        };
      }
      return Reflect.get(target, key, target) as unknown;
    },
  });
}

/** A turn's usage from what the client reported; an unknown cost counts as the turn's estimate. */
export function turnUsage(
  usages: readonly Usage[],
  estimate: number | null,
): TurnUsage | undefined {
  if (usages.length === 0) return undefined;
  const unknown = usages.some((usage) => usage.costUnknown === true);
  const cost = usages.reduce((sum, usage) => sum + usage.costUsd, 0);
  return {
    promptTokens: usages.reduce((sum, usage) => sum + usage.promptTokens, 0),
    completionTokens: usages.reduce((sum, usage) => sum + usage.completionTokens, 0),
    costUsd: unknown ? Math.max(cost, estimate ?? 0) : cost,
    latencyMs: usages.reduce((sum, usage) => sum + usage.latencyMs, 0),
    ...(usages.some((usage) => usage.costEstimated) ? { costEstimated: true } : {}),
    ...(unknown ? { costUnknown: true } : {}),
  };
}

/** Holds the conversation's Web Lock until the returned release is called; null when another tab holds it. */
function lockConversation(id: string): Promise<(() => void) | null> {
  const locks = webLocks();
  if (!locks) return Promise.resolve(() => undefined);
  return new Promise((resolve) => {
    locks
      .request(`ortoolbox:bot-to-bot:${id}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>((release) => resolve(release));
      })
      .catch(() => resolve(() => undefined));
  });
}

export async function setup(ctx: ToolContext): Promise<ToolInstance> {
  const { ui } = ctx;
  let params = paramsFrom(ctx.options.get());
  let catalog = new Map<string, ModelInfo>();
  let conversation: Conversation | null = null;
  try {
    conversation = parseConversation(await ctx.state.get(STATE_KEY));
  } catch (error) {
    void presentError(error);
  }
  /** The turn that is streaming, and the renderer drawing it. */
  let live: { entry: Entry; stream: MarkdownStream | null } | null = null;
  let runState: { busy: boolean; blocked: string | null } = { busy: false, blocked: null };
  let pauseRequested = false;
  /** The clock while the loop runs: elapsed = base + (now - startedAt). */
  let clockState: { base: number; startedAt: number } | null = null;
  let editing: { id: string; text: string } | null = null;

  // --- small helpers ----------------------------------------------------------------------------------------
  const nameOf = (speaker: Speaker): string =>
    params[BOT_KEY[speaker]].name.trim() || DEFAULT_NAMES[speaker];
  const modelOf = (speaker: Speaker, header = ctx.model().model): string | null =>
    params[BOT_KEY[speaker]].model ?? header;
  const modelName = (id: string): string => catalog.get(id)?.name ?? id;
  const modelInfo = async (id: string): Promise<ModelInfo | undefined> =>
    catalog.get(id) ?? (await ctx.models.get(id).catch(() => undefined));
  const isFree = (id: string): boolean => ctx.models.isFree(id);
  const currentLimits = (): Limits => ({
    turns: params.turnLimit,
    timeMs: Math.round(params.timeLimitMinutes * MINUTE_MS),
    costUsd: params.costCapUsd,
    stopPhrase: params.stopPhrase,
  });
  const profiles = (): Record<Speaker, BotProfile> => ({
    a: { name: nameOf('a'), persona: params.botA.persona },
    b: { name: nameOf('b'), persona: params.botB.persona },
  });
  const botRecords = (models: Record<Speaker, string>): Record<Speaker, BotRecord> => ({
    a: { name: nameOf('a'), model: models.a, persona: params.botA.persona },
    b: { name: nameOf('b'), model: models.b, persona: params.botB.persona },
  });
  const elapsedOf = (conv: Conversation): number =>
    clockState && conv === conversation
      ? clockState.base + Date.now() - clockState.startedAt
      : conv.elapsedMs;
  const progressOf = (
    conv: Conversation,
  ): { turns: number; elapsedMs: number; spentUsd: number } => ({
    turns: turnCount(conv),
    elapsedMs: elapsedOf(conv),
    spentUsd: conv.spentUsd,
  });
  const exportContext = (): { limits: Limits; isFree: (id: string) => boolean } => ({
    limits: currentLimits(),
    isFree,
  });
  const transcript = (conv: Conversation): string => toMarkdown(conv, exportContext());

  const saveParams = (): void => {
    try {
      ctx.options.set(settingsOf(params));
    } catch (error) {
      void presentError(error);
    }
  };

  // --- persistence --------------------------------------------------------------------------------------------
  let writes: Promise<void> = Promise.resolve();
  /** Writes of this tab not stored yet: changes announced meanwhile are this tab's own. */
  let pendingWrites = 0;
  const queueWrite = (write: () => Promise<void>): void => {
    pendingWrites++;
    writes = writes
      .then(write)
      .catch((error: unknown) => void presentError(error))
      .finally(() => {
        pendingWrites--;
      });
  };
  /** Stores the conversation as it is now (a copy: a streaming turn keeps changing). */
  const persist = (): void => {
    const conv = conversation;
    if (!conv) return;
    conv.rev += 1;
    const copy = structuredClone(conv);
    queueWrite(() => ctx.state.set(STATE_KEY, copy));
  };

  // Another tab changed the stored conversation: follow it, unless this tab runs it (its writes win).
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool !== ctx.manifest.id || event.key !== STATE_KEY) return;
    if (runState.busy || pendingWrites > 0) return;
    void (async () => {
      const stored = parseConversation(await ctx.state.get(STATE_KEY));
      if (runState.busy || pendingWrites > 0) return;
      if (!stored) {
        if (!conversation) return;
        conversation = null;
      } else if (conversation && stored.id === conversation.id && stored.rev <= conversation.rev) {
        return;
      } else {
        conversation = stored;
      }
      editing = null;
      renderAll();
      void ui.refreshEstimate();
    })().catch(() => undefined);
  });

  // --- setup form (input zone) --------------------------------------------------------------------------------
  interface BotFields {
    heading: HTMLElement;
    avatarHost: HTMLElement;
    name: HTMLInputElement;
    persona: HTMLTextAreaElement;
    modelButton: HTMLButtonElement;
    modelReset: HTMLButtonElement;
    warnings: HTMLElement;
  }
  const estimateSoon = debounce(() => void ui.refreshEstimate(), 300);
  const setupChanged = (): void => {
    renderSetup();
    renderStats();
    estimateSoon();
  };

  const PERSONA_HINTS: Record<Speaker, string> = {
    a: 'For example: You are a curious scientist who asks sharp questions.',
    b: 'For example: You are a witty poet who answers in vivid images.',
  };
  const botFields = (speaker: Speaker): { element: HTMLElement; fields: BotFields } => {
    const slot = DEFAULT_NAMES[speaker];
    const key = BOT_KEY[speaker];
    const ids = {
      heading: uid(`bot-${speaker}-title`),
      name: uid(`bot-${speaker}-name`),
      persona: uid(`bot-${speaker}-persona`),
      model: uid(`bot-${speaker}-model`),
    };
    const name = h('input', {
      id: ids.name,
      type: 'text',
      class: 'form-control',
      maxLength: 40,
      autocomplete: 'off',
      spellcheck: false,
      placeholder: slot,
      'data-testid': `bot-${speaker}-name`,
      oninput: () => {
        params[key].name = name.value;
        setupChanged();
      },
      onchange: () => saveParams(),
    });
    const persona = h('textarea', {
      id: ids.persona,
      class: 'form-control',
      rows: 2,
      placeholder: PERSONA_HINTS[speaker],
      'data-testid': `bot-${speaker}-persona`,
      oninput: () => {
        params[key].persona = persona.value;
        setupChanged();
      },
      onchange: () => saveParams(),
    });
    const modelButton = h('button', {
      type: 'button',
      class:
        'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 or-chip text-truncate mw-100',
      'data-testid': `bot-${speaker}-model`,
      onclick: () => void chooseModel(speaker),
    });
    const modelReset = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-link or-bot-action',
        'aria-label': `Use the default model for ${slot}`,
        title: 'Use the default model',
        'data-testid': `bot-${speaker}-model-reset`,
        onclick: () => setModel(speaker, null),
      },
      icon('x-lg'),
    );
    const heading = h('h3', {
      id: ids.heading,
      class: 'h6 mb-0 text-truncate',
      'data-testid': `bot-${speaker}-title`,
    });
    const avatarHost = h('span', { class: 'd-inline-flex' });
    const warnings = h('div', { class: 'empty-hidden', 'data-testid': `bot-${speaker}-warnings` });
    const element = h(
      'section',
      {
        class: ['or-bot-setup', `or-bot-setup-${speaker}`],
        'aria-labelledby': ids.heading,
        'data-testid': `bot-${speaker}-setup`,
      },
      h('div', { class: 'd-flex align-items-center gap-2 mb-2 min-w-0' }, avatarHost, heading),
      h(
        'div',
        { class: 'row g-2' },
        h(
          'div',
          { class: 'col-sm-5' },
          h(
            'label',
            { class: 'form-label small mb-1', htmlFor: ids.name },
            'Name',
            h('span', { class: 'visually-hidden' }, ` of ${slot}`),
          ),
          name,
        ),
        h(
          'div',
          { class: 'col-sm-7 min-w-0' },
          h('span', { id: ids.model, class: 'form-label small mb-1 d-block' }, 'Model'),
          h('div', { class: 'd-flex align-items-center min-w-0' }, modelButton, modelReset),
        ),
      ),
      h(
        'div',
        { class: 'mt-2' },
        h(
          'label',
          { class: 'form-label small mb-1', htmlFor: ids.persona },
          'Persona',
          h('span', { class: 'visually-hidden' }, ` of ${slot}`),
          h('span', { class: 'text-body-secondary' }, ' (optional)'),
        ),
        persona,
      ),
      warnings,
    );
    return {
      element,
      fields: { heading, avatarHost, name, persona, modelButton, modelReset, warnings },
    };
  };
  const botA = botFields('a');
  const botB = botFields('b');
  const fields: Record<Speaker, BotFields> = { a: botA.fields, b: botB.fields };

  const openerId = uid('opener');
  const openerHint = uid('opener-hint');
  const openerField = h('textarea', {
    id: openerId,
    class: 'form-control',
    rows: 3,
    placeholder:
      'What should they talk about? For example: Debate whether a hot dog is a sandwich.',
    'aria-describedby': openerHint,
    'data-testid': 'tool-prompt',
    oninput: () => estimateSoon(),
  });

  const firstName = uid('first');
  const firstInputs = {} as Record<Speaker, HTMLInputElement>;
  const firstLabels = {} as Record<Speaker, HTMLLabelElement>;
  const firstOption = (speaker: Speaker): HTMLElement[] => {
    const id = uid(`first-${speaker}`);
    const input = h('input', {
      id,
      type: 'radio',
      class: 'btn-check',
      name: firstName,
      value: speaker,
      autocomplete: 'off',
      'data-testid': `bots-first-${speaker}`,
      onchange: () => {
        if (!input.checked) return;
        params.first = speaker;
        saveParams();
        setupChanged();
      },
    });
    const label = h('label', {
      class: 'btn btn-sm btn-outline-secondary text-truncate or-bot-first',
      htmlFor: id,
      'data-testid': `bots-first-${speaker}-label`,
    });
    firstInputs[speaker] = input;
    firstLabels[speaker] = label;
    return [input, label];
  };

  const numberField = (
    label: string,
    testId: string,
    range: { min: number; max: number },
    step: string,
  ): { input: HTMLInputElement; id: string; label: string } => {
    const id = uid(testId);
    return {
      id,
      label,
      input: h('input', {
        id,
        type: 'number',
        class: 'form-control',
        min: String(range.min),
        max: String(range.max),
        step,
        inputMode: 'decimal',
        required: true,
        'data-testid': testId,
      }),
    };
  };
  const turnsField = numberField('Turns', 'bots-turn-limit', RANGES.turnLimit, '1');
  const timeField = numberField('Minutes', 'bots-time-limit', RANGES.timeLimitMinutes, '0.1');
  const costField = numberField('Cost cap', 'bots-cost-cap', RANGES.costCapUsd, '0.01');
  const phraseId = uid('stop-phrase');
  const phraseInput = h('input', {
    id: phraseId,
    type: 'text',
    class: 'form-control',
    maxLength: 60,
    autocomplete: 'off',
    spellcheck: false,
    placeholder: 'None',
    'data-testid': 'bots-stop-phrase',
    oninput: () => {
      params.stopPhrase = phraseInput.value;
      setupChanged();
    },
    onchange: () => saveParams(),
  });

  /** Reads a number field, clamped (written back when it changed); null when empty or not a number. */
  const readNumber = (
    input: HTMLInputElement,
    range: { min: number; max: number },
    integer: boolean,
  ): number | null => {
    if (input.value.trim() === '') return null;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return null;
    const clamped = Math.min(range.max, Math.max(range.min, integer ? Math.round(value) : value));
    if (clamped !== value) input.value = String(clamped);
    return clamped;
  };
  const limitChanged =
    (
      input: HTMLInputElement,
      range: { min: number; max: number },
      integer: boolean,
      apply: (value: number) => void,
      current: () => number,
    ) =>
    (): void => {
      const value = readNumber(input, range, integer);
      if (value === null) input.value = String(current());
      else apply(value);
      saveParams();
      setupChanged();
    };
  turnsField.input.addEventListener(
    'change',
    limitChanged(
      turnsField.input,
      RANGES.turnLimit,
      true,
      (v) => (params.turnLimit = v),
      () => params.turnLimit,
    ),
  );
  timeField.input.addEventListener(
    'change',
    limitChanged(
      timeField.input,
      RANGES.timeLimitMinutes,
      false,
      (v) => (params.timeLimitMinutes = v),
      () => params.timeLimitMinutes,
    ),
  );
  costField.input.addEventListener(
    'change',
    limitChanged(
      costField.input,
      RANGES.costCapUsd,
      false,
      (v) => (params.costCapUsd = v),
      () => params.costCapUsd,
    ),
  );

  const limitColumn = (
    field: { input: HTMLInputElement; id: string; label: string },
    prefix?: string,
  ): HTMLElement =>
    h(
      'div',
      { class: 'col-6' },
      h('label', { class: 'form-label small mb-1', htmlFor: field.id }, field.label),
      prefix
        ? h(
            'div',
            { class: 'input-group' },
            h('span', { class: 'input-group-text' }, prefix),
            field.input,
          )
        : field.input,
    );

  // The framing each bot gets, read-only.
  const framingTexts = {} as Record<Speaker, HTMLElement>;
  const framingNames = {} as Record<Speaker, HTMLElement>;
  const framingAvatars = {} as Record<Speaker, HTMLElement>;
  const framingBlock = (speaker: Speaker): HTMLElement => {
    framingNames[speaker] = h('span', { class: 'text-truncate' });
    framingAvatars[speaker] = h('span', { class: 'd-inline-flex' });
    framingTexts[speaker] = h('p', {
      class: 'or-plain-text small mb-0 or-bot-framing',
      'data-testid': `bots-framing-${speaker}`,
    });
    return h(
      'div',
      null,
      h(
        'h4',
        { class: 'h6 small fw-semibold mb-1 d-flex align-items-center gap-2 min-w-0' },
        framingAvatars[speaker],
        framingNames[speaker],
      ),
      framingTexts[speaker],
    );
  };
  const framingId = uid('framing');
  const framingHeader = uid('framing-header');
  const framingSection = h(
    'div',
    { class: 'accordion', 'data-testid': 'bots-framing' },
    h(
      'div',
      { class: 'accordion-item' },
      h(
        'h3',
        { class: 'accordion-header', id: framingHeader },
        h(
          'button',
          {
            type: 'button',
            class: 'accordion-button collapsed',
            'data-bs-toggle': 'collapse',
            'data-bs-target': `#${framingId}`,
            'aria-expanded': 'false',
            'aria-controls': framingId,
            'data-testid': 'bots-framing-toggle',
          },
          'What each bot is told',
        ),
      ),
      h(
        'div',
        { id: framingId, class: 'accordion-collapse collapse', 'aria-labelledby': framingHeader },
        h(
          'div',
          { class: 'accordion-body vstack gap-3' },
          framingBlock('a'),
          framingBlock('b'),
          h(
            'p',
            { class: 'small text-body-secondary mb-0' },
            'Sent as the system message before every turn. Each bot sees its own turns as its replies and the other bot’s as the user’s; the opening prompt and moderator messages are marked [Moderator].',
          ),
        ),
      ),
    ),
  );

  ui.input.append(
    h('div', { class: 'd-flex flex-column gap-3' }, botA.element, botB.element),
    h(
      'div',
      { class: 'd-flex flex-column' },
      h('label', { class: 'form-label fw-semibold', htmlFor: openerId }, 'Opening prompt'),
      openerField,
      h(
        'div',
        { id: openerHint, class: 'form-text' },
        'Both bots see it as the moderator’s first message. It starts a new conversation.',
      ),
    ),
    h(
      'fieldset',
      { class: 'd-flex flex-column' },
      h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Who speaks first'),
      h('div', { class: 'btn-group or-bot-first-group' }, firstOption('a'), firstOption('b')),
    ),
    h(
      'fieldset',
      { class: 'd-flex flex-column' },
      h('legend', { class: 'form-label fw-semibold fs-6 mb-1' }, 'Limits'),
      h(
        'div',
        { class: 'row g-2' },
        limitColumn(turnsField),
        limitColumn(timeField),
        limitColumn(costField, '$'),
        h(
          'div',
          { class: 'col-6' },
          h('label', { class: 'form-label small mb-1', htmlFor: phraseId }, 'Stop phrase'),
          phraseInput,
        ),
      ),
      h(
        'div',
        { class: 'form-text' },
        'The first limit reached ends the conversation. They count across pauses; raise one to go on.',
      ),
    ),
    framingSection,
  );

  // --- drawer -----------------------------------------------------------------------------------------------
  const maxTokensId = uid('max-tokens');
  const maxTokensInput = h('input', {
    id: maxTokensId,
    type: 'number',
    class: 'form-control',
    min: String(RANGES.maxTokens.min),
    max: String(RANGES.maxTokens.max),
    step: '1',
    placeholder: 'Model default',
    inputMode: 'numeric',
    'aria-describedby': `${maxTokensId}-hint`,
    'data-testid': 'bots-max-tokens',
    onchange: () => {
      params.maxTokens = readNumber(maxTokensInput, RANGES.maxTokens, true);
      saveParams();
      setupChanged();
    },
  });
  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: maxTokensId }, 'Max tokens per turn'),
      maxTokensInput,
      h(
        'div',
        { id: `${maxTokensId}-hint`, class: 'form-text' },
        'Each reply stops at this length (within the model’s own cap). Estimates assume every turn uses all of it. Empty: the model’s default.',
      ),
    ),
  );

  // --- conversation (output zone) ----------------------------------------------------------------------------
  const stateBadge = h('span', { class: 'badge rounded-pill', 'data-testid': 'bots-state' });
  const copyButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'data-testid': 'bots-copy',
      onclick: () => {
        if (conversation) void copyWithToast(transcript(conversation), 'Transcript copied.');
      },
    },
    icon('clipboard'),
    'Copy',
  );
  const fileName = (): string => `${nameOf('a')} and ${nameOf('b')}`;
  const exporter = exportMenu({
    label: 'Export',
    filename: fileName,
    testId: 'bots-export',
    disabled: true,
    formats: [
      {
        label: 'Markdown',
        extension: 'md',
        icon: 'markdown',
        build: () =>
          new Blob([conversation ? transcript(conversation) : ''], { type: 'text/markdown' }),
      },
      {
        label: 'JSON',
        extension: 'json',
        icon: 'filetype-json',
        build: () =>
          new Blob(
            [
              conversation
                ? `${JSON.stringify(toJson(conversation, exportContext()), null, 2)}\n`
                : '',
            ],
            { type: 'application/json' },
          ),
      },
    ],
  });
  let exportOff = true;
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'data-testid': 'bots-new',
      onclick: () => {
        if (clearButton.getAttribute('aria-disabled') !== 'true') clearConversation();
      },
    },
    icon('plus-lg'),
    'New conversation',
  );

  interface Tile {
    value: HTMLElement;
    meter: HTMLElement;
    bar: HTMLElement;
  }
  const tile = (label: string, testId: string): { element: HTMLElement; tile: Tile } => {
    const value = h('div', { class: 'or-bot-stat-value', 'data-testid': testId });
    const bar = h('div', { class: 'progress-bar' });
    const meter = h(
      'div',
      {
        class: 'progress or-bot-meter',
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
      },
      bar,
    );
    return {
      element: h(
        'div',
        { class: 'or-bot-stat' },
        h('div', { class: 'or-bot-stat-label', 'aria-hidden': 'true' }, label),
        value,
        meter,
      ),
      tile: { value, meter, bar },
    };
  };
  const turnsTile = tile('Turns', 'bots-turns');
  const timeTile = tile('Time', 'bots-time');
  const costTile = tile('Cost', 'bots-cost');

  // A labelled region, not a live region: streamed text must not be read out as it arrives.
  const log = h('div', {
    class: 'or-bot-log',
    role: 'region',
    'aria-label': 'Conversation',
    tabIndex: 0,
    'data-testid': 'bots-log',
  });
  const emptyView = emptyState({
    icon: 'robot',
    title: 'Two bots, one conversation',
    text: 'Set up both bots and an opening prompt, then press Start. You can pause, step one turn, add a moderator message or edit any turn as they talk.',
    compact: true,
    testId: 'bots-empty',
  });

  const modId = uid('moderator');
  const modHint = uid('moderator-hint');
  const modInput = h('textarea', {
    id: modId,
    class: 'form-control',
    rows: 2,
    placeholder: 'Steer the conversation. Both bots see it from their next turn.',
    'aria-describedby': modHint,
    'data-testid': 'moderator-input',
  });
  const modSend = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-primary d-inline-flex align-items-center gap-2',
      'data-testid': 'moderator-send',
      onclick: () => inject(),
    },
    icon('megaphone'),
    'Send',
  );
  modInput.addEventListener('keydown', (event) => {
    if (composing(event) || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    // Enter (and Ctrl/Cmd+Enter, never the page's Run shortcut here) sends.
    event.preventDefault();
    event.stopPropagation();
    inject();
  });

  ui.output.append(
    h(
      'div',
      { class: 'd-flex flex-wrap align-items-center gap-2 mb-3' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2 me-auto' },
        h('h3', { class: 'h5 mb-0' }, 'Conversation'),
        stateBadge,
      ),
      h('div', { class: 'd-flex flex-wrap gap-2' }, copyButton, exporter, clearButton),
    ),
    h(
      'div',
      { class: 'or-bot-stats mb-3', 'data-testid': 'bots-stats' },
      turnsTile.element,
      timeTile.element,
      costTile.element,
    ),
    log,
    h(
      'div',
      { class: 'or-bot-moderator mt-3' },
      h(
        'label',
        { class: 'form-label fw-semibold', htmlFor: modId },
        icon('megaphone', 'me-1'),
        'Moderator message',
      ),
      h('div', { class: 'd-flex align-items-end gap-2' }, modInput, modSend),
      h(
        'div',
        { id: modHint, class: 'form-text' },
        'Enter sends, Shift+Enter adds a line. You can send one while they talk.',
      ),
    ),
  );

  // --- run bar: Start/Resume and Step, or Pause and Stop --------------------------------------------------------
  const primaryLabel = h('span', null, 'Start');
  const primaryButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary d-inline-flex align-items-center gap-2 px-4',
      'aria-disabled': 'false',
      'data-testid': 'bots-primary',
      onclick: () => press(undefined),
    },
    icon('play-fill'),
    primaryLabel,
    h('kbd', { class: 'or-kbd or-kbd-on-primary d-none d-md-inline' }, formatShortcut('↵')),
  );
  const stepButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-primary d-inline-flex align-items-center gap-2',
      'aria-disabled': 'false',
      title: 'Run exactly one turn, then hold',
      'data-testid': 'bots-step',
      onclick: () => press('step'),
    },
    icon('skip-end-fill'),
    'Step',
  );
  const pauseLabel = h('span', null, 'Pause');
  const pauseButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary d-inline-flex align-items-center gap-2',
      hidden: true,
      'data-testid': 'bots-pause',
      onclick: () => requestPause(),
    },
    icon('pause-fill'),
    pauseLabel,
  );

  // Ctrl/Cmd+Enter (no argument) is the primary action: Start, or Resume once there is a conversation.
  const runner = ui.runner<Action>({
    label: 'Start',
    icon: 'play-fill',
    run: (signal, action) => perform(action, signal),
  });
  runner.button.hidden = true;
  runner.element.prepend(primaryButton, stepButton, pauseButton);
  /** The bar's control that last had focus, so focus can move on when it hides. */
  let barFocus: HTMLElement | null = null;
  runner.element.addEventListener('focusin', (event) => {
    barFocus = event.target instanceof HTMLElement ? event.target : null;
  });
  runner.element.addEventListener('focusout', (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && runner.element.contains(next)) return;
    // Focus left the bar: forget it, unless it left because its control hid (fixBarFocus moves it on).
    const left = event.target;
    if (!(left instanceof HTMLElement) || left.closest('[hidden]') === null) barFocus = null;
  });
  /** A focused bar control that hid (Start → Pause, Stop → Resume) hands focus to the one that took its place. */
  const fixBarFocus = (): void => {
    const active = document.activeElement;
    const lost =
      !active ||
      active === document.body ||
      (active instanceof HTMLElement && active.closest('[hidden]') !== null);
    if (!lost || !barFocus || !runner.element.contains(barFocus)) return;
    const target = runState.busy
      ? pauseButton.hidden
        ? runner.stopButton
        : pauseButton
      : primaryButton;
    target.focus();
    barFocus = target;
  };

  function press(action: Action | undefined): void {
    if (runState.busy) return;
    if (runState.blocked) {
      ui.status(runState.blocked);
      return;
    }
    void runner.trigger(action);
  }

  function requestPause(): void {
    if (!runState.busy || pauseRequested) return;
    pauseRequested = true;
    renderControls();
    ui.status('Pausing after this turn…');
  }

  // Escape stops a conversation that is running (not while a field, a menu or a dialog uses the key).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || composing(event) || !runner.busy || event.defaultPrevented)
      return;
    if (modalOpen() || document.querySelector('.offcanvas.show, .dropdown-menu.show')) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches('input, select, textarea'))
    ) {
      return;
    }
    event.preventDefault();
    runner.stop();
  });

  // --- rendering ----------------------------------------------------------------------------------------------
  /** The form's fields from `params` (not on every render: the user may be typing). */
  const renderParams = (): void => {
    for (const speaker of SPEAKERS) {
      const bot = params[BOT_KEY[speaker]];
      fields[speaker].name.value = bot.name;
      fields[speaker].persona.value = bot.persona;
      firstInputs[speaker].checked = params.first === speaker;
    }
    turnsField.input.value = String(params.turnLimit);
    timeField.input.value = String(params.timeLimitMinutes);
    costField.input.value = String(params.costCapUsd);
    phraseInput.value = params.stopPhrase;
    maxTokensInput.value = params.maxTokens === null ? '' : String(params.maxTokens);
  };

  const renderSetup = (): void => {
    const header = ctx.model().model;
    const freeOnly = ctx.settings.get().freeOnly;
    const bots = profiles();
    for (const speaker of SPEAKERS) {
      const name = nameOf(speaker);
      const own = params[BOT_KEY[speaker]].model;
      const model = own ?? header;
      const parts = fields[speaker];
      parts.heading.textContent = name;
      parts.avatarHost.replaceChildren(avatar(speaker, name));
      replace(
        parts.modelButton,
        icon('cpu'),
        h('span', { class: 'text-truncate' }, model ? modelName(model) : 'No model'),
        own === null ? h('span', { class: 'small' }, '(default)') : null,
      );
      parts.modelButton.setAttribute(
        'aria-label',
        `Model for ${DEFAULT_NAMES[speaker]}: ${model ? modelName(model) : 'none'}${own === null ? ' (the default)' : ''}. Change`,
      );
      parts.modelReset.hidden = own === null;
      parts.warnings.replaceChildren(
        ...(model && freeOnly && !isFree(model)
          ? [
              h(
                'div',
                {
                  class: 'alert alert-warning d-flex gap-2 align-items-center py-2 mt-2 mb-0 small',
                  'data-testid': 'warning-free-only',
                },
                icon('exclamation-triangle'),
                `Free-only mode is on, and ${modelName(model)} is not free.`,
              ),
            ]
          : []),
      );
      firstLabels[speaker].textContent = name;
      framingNames[speaker].textContent = name;
      framingAvatars[speaker].replaceChildren(avatar(speaker, name, 'sm'));
      framingTexts[speaker].textContent = framing(speaker, bots, params.stopPhrase);
    }
  };

  const setTile = (item: Tile, text: string, ratio: number, valueText: string): void => {
    const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    item.value.textContent = text;
    item.bar.style.width = `${percent}%`;
    item.bar.classList.toggle('bg-warning', percent >= 80 && percent < 100);
    item.bar.classList.toggle('bg-danger', percent >= 100);
    item.meter.setAttribute('aria-valuenow', String(percent));
    item.meter.setAttribute('aria-valuetext', valueText);
  };

  const renderStats = (): void => {
    const limits = currentLimits();
    const turns = conversation ? turnCount(conversation) : 0;
    const elapsed = conversation ? elapsedOf(conversation) : 0;
    const spent = conversation?.spentUsd ?? 0;
    const approx = conversation?.spentApprox ? '≈ ' : '';
    setTile(
      turnsTile.tile,
      `${turns} / ${limits.turns}`,
      turns / limits.turns,
      `${turns} of ${plural(limits.turns, 'turn')}`,
    );
    setTile(
      timeTile.tile,
      `${clock(elapsed)} / ${clock(limits.timeMs)}`,
      elapsed / limits.timeMs,
      `${formatMs(elapsed)} of ${formatMs(limits.timeMs)}`,
    );
    setTile(
      costTile.tile,
      `${approx}${formatUsd(spent)} / ${formatUsd(limits.costUsd)}`,
      limits.costUsd > 0 ? spent / limits.costUsd : spent > 0 ? 1 : 0,
      `${approx}${formatUsd(spent)} of ${formatUsd(limits.costUsd)}`,
    );
  };

  const setOff = (button: HTMLElement, off: boolean, reason: string | null = null): void => {
    button.setAttribute('aria-disabled', String(off));
    button.classList.toggle('disabled', off);
    if (reason) button.title = reason;
    else button.removeAttribute('title');
  };

  const renderControls = (): void => {
    const { busy, blocked } = runState;
    primaryLabel.textContent = conversation ? 'Resume' : 'Start';
    primaryButton.hidden = busy;
    stepButton.hidden = busy;
    pauseButton.hidden = !busy;
    setOff(primaryButton, blocked !== null, blocked);
    setOff(stepButton, blocked !== null, blocked ?? 'Run exactly one turn, then hold');
    setOff(pauseButton, pauseRequested);
    pauseLabel.textContent = pauseRequested ? 'Pausing…' : 'Pause';
    setOff(clearButton, busy || !conversation);
    copyButton.disabled = !conversation;
    if (exportOff !== !conversation) {
      exportOff = !conversation;
      exporter.update({ disabled: exportOff });
    }
    modInput.disabled = !conversation;
    modSend.disabled = !conversation;
    const ended = conversation ? endedBy(conversation) : null;
    const [text, tone] = !conversation
      ? ['Not started', 'secondary']
      : busy
        ? ['Running', 'primary']
        : ended
          ? [`Ended · ${END_TITLES[ended]}`, 'secondary']
          : ['Paused', 'warning'];
    stateBadge.textContent = text;
    stateBadge.className = `badge rounded-pill text-bg-${tone}`;
    fixBarFocus();
  };

  /** Keeps the newest text in view while it arrives, unless the reader scrolled up. */
  const follow = (force = false): void => {
    if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) {
      log.scrollTop = log.scrollHeight;
    }
  };

  const entryActions = {
    copy: (entry: Entry) => void copyWithToast(entry.content, 'Message copied.'),
    edit: (entry: Entry) => {
      if (runState.busy) return;
      editing = { id: entry.id, text: entry.content };
      renderLog();
      focusKey(log, `edit:${entry.id}`);
    },
    cancel: (entry: Entry) => {
      editing = null;
      renderLog();
      focusKey(log, `edit-button:${entry.id}`);
    },
    save: (entry: Entry, text: string) => saveEdit(entry, text),
  };

  const entryContext = (): EntryContext => ({
    streamingId: live?.entry.id ?? null,
    editingId: editing?.id ?? null,
    busy: runState.busy,
    after: (id) => {
      const entries = conversation?.entries ?? [];
      const index = entries.findIndex((entry) => entry.id === id);
      return index < 0 ? 0 : entries.length - index - 1;
    },
    modelName,
    isFree,
    actions: entryActions,
  });

  const drawn = new Map<string, { view: EntryView; signature: string }>();
  let drawnFor: string | null = null;

  /** Focus back on a control of an entry: the same one, else another of that entry, else the transcript. */
  const refocus = (key: string): void => {
    const id = key.slice(key.indexOf(':') + 1);
    for (const candidate of [key, `edit-button:${id}`, `copy:${id}`]) {
      if (focusKey(log, candidate)) return;
    }
    log.focus();
  };

  /** Draws the transcript, redrawing only entries whose signature changed. */
  function renderLog(): void {
    const lostKey = focusedKey(log);
    log.setAttribute('aria-busy', String(live !== null));
    if (!conversation) {
      drawn.clear();
      drawnFor = null;
      log.replaceChildren(emptyView);
      return;
    }
    if (drawnFor !== conversation.id) {
      drawn.clear();
      log.replaceChildren();
      drawnFor = conversation.id;
    }
    emptyView.remove();
    if (editing && !conversation.entries.some((entry) => entry.id === editing?.id)) editing = null;
    const ectx = entryContext();
    let previous: Element | null = null;
    let streamingRedrawn = false;
    const shown = new Set<string>();
    for (const entry of conversation.entries) {
      const signature = entrySignature(entry, ectx);
      let item = drawn.get(entry.id);
      if (item?.signature !== signature) {
        const view = entryView(entry, ectx);
        item?.view.element.replaceWith(view.element);
        item = { view, signature };
        drawn.set(entry.id, item);
        if (entry.id === live?.entry.id) streamingRedrawn = true;
        if (editing?.id === entry.id) wireEditor(view.element, editing);
      }
      const expected: Element | null = previous
        ? previous.nextElementSibling
        : log.firstElementChild;
      if (expected !== item.view.element) log.insertBefore(item.view.element, expected);
      previous = item.view.element;
      shown.add(entry.id);
    }
    for (const [id, item] of drawn) {
      if (shown.has(id)) continue;
      item.view.element.remove();
      drawn.delete(id);
    }
    while (previous?.nextElementSibling) previous.nextElementSibling.remove();
    applyBusy(log, runState.busy);
    if (live && (streamingRedrawn || !live.stream)) {
      const body = drawn.get(live.entry.id)?.view.body ?? null;
      live.stream?.dispose();
      live.stream = body ? streamMarkdown(body, { onRender: () => follow() }) : null;
      if (live.entry.content) live.stream?.set(live.entry.content);
    }
    if (lostKey && !log.contains(document.activeElement)) refocus(lostKey);
  }

  /** The editor keeps what was typed across redraws. */
  const wireEditor = (element: HTMLElement, state: { text: string }): void => {
    const area = element.querySelector('textarea');
    if (!area) return;
    area.value = state.text;
    area.addEventListener('input', () => {
      state.text = area.value;
    });
  };

  function renderAll(): void {
    renderSetup();
    renderStats();
    renderControls();
    renderLog();
  }

  // --- moderation -------------------------------------------------------------------------------------------
  async function chooseModel(speaker: Speaker): Promise<void> {
    const chosen = await modelPicker(ctx, {
      capability: 'text',
      selected: modelOf(speaker),
      title: `Model for ${nameOf(speaker)}`,
    });
    if (chosen) setModel(speaker, chosen);
  }

  function setModel(speaker: Speaker, model: string | null): void {
    const bot = params[BOT_KEY[speaker]];
    if (bot.model === model) return;
    bot.model = model;
    saveParams();
    setupChanged();
    if (model === null) fields[speaker].modelButton.focus();
    const shown = modelOf(speaker);
    announce(`${nameOf(speaker)} now uses ${shown ? modelName(shown) : 'no model'}.`);
  }

  function inject(): void {
    if (!conversation) return;
    const text = modInput.value.trim();
    if (!text) {
      ui.status('Write a message for the bots first.');
      modInput.focus();
      return;
    }
    conversation.entries.push({
      id: newId(),
      kind: 'moderator',
      content: text,
      createdAt: Date.now(),
    });
    touch(conversation);
    persist();
    modInput.value = '';
    renderLog();
    renderControls();
    follow(true);
    void ui.refreshEstimate();
    announce(
      runState.busy
        ? 'Moderator message added. The next bot to speak sees it.'
        : 'Moderator message added.',
    );
  }

  function saveEdit(entry: Entry, text: string): void {
    if (runState.busy || !conversation) return;
    const conv = conversation;
    const written = text.trim();
    if (!written) {
      ui.status('A message cannot be empty.');
      return;
    }
    const undo = editEntry(conv, entry.id, written);
    editing = null;
    if (!undo) {
      renderLog();
      return;
    }
    touch(conv);
    persist();
    renderAll();
    focusKey(log, `edit-button:${entry.id}`);
    void ui.refreshEstimate();
    if (undo.removed.length === 0) {
      announce('Message edited. Resume carries on from here.');
      return;
    }
    toast({
      message: `Message edited; ${plural(undo.removed.length, 'message')} after it removed.`,
      testId: 'bots-edit-toast',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (runState.busy || conversation !== conv || !undoEdit(conv, undo)) {
            toast({
              variant: 'warning',
              message: 'The messages cannot come back: the conversation went on since.',
              testId: 'undo-refused',
            });
            return;
          }
          touch(conv);
          persist();
          renderAll();
          void ui.refreshEstimate();
          announce('Edit undone.');
        },
      },
    });
  }

  function clearConversation(): void {
    if (runState.busy || !conversation) return;
    const removed = conversation;
    conversation = null;
    editing = null;
    queueWrite(() => ctx.state.delete(STATE_KEY));
    renderAll();
    void ui.refreshEstimate();
    primaryButton.focus();
    toast({
      message: 'Conversation cleared. Start begins a new one.',
      testId: 'bots-cleared-toast',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (conversation) {
            toast({
              variant: 'warning',
              message: 'The conversation cannot come back: a new one was started since.',
              testId: 'undo-refused',
            });
            return;
          }
          conversation = removed;
          persist();
          renderAll();
          void ui.refreshEstimate();
          announce('Conversation restored.');
        },
      },
    });
  }

  // --- estimates ---------------------------------------------------------------------------------------------
  const turnOptions = (
    model: string,
    info: ModelInfo | undefined,
    bots: Record<Speaker, BotProfile>,
  ): TurnOptions => ({
    model,
    bots,
    stopPhrase: params.stopPhrase,
    maxTokens: params.maxTokens,
    contextLength: info?.contextLength ?? null,
    maxCompletionTokens: info?.maxCompletionTokens ?? null,
  });

  const costOf = (model: string, promptTokens: number, completionTokens: number) =>
    ctx.models
      .estimate({ kind: 'tokens', model, promptTokens, completionTokens })
      .catch(() => null);

  /**
   * The cost of `speaker`'s next turn, assuming `ahead` turns to go: the prompt grows by up to one full reply per
   * turn, so the last of them is the dearest (within the context window). Null when the price is unknown.
   */
  async function turnEstimate(
    conv: Pick<Conversation, 'entries'>,
    speaker: Speaker,
    model: string,
    bots: Record<Speaker, BotProfile>,
    ahead = 1,
  ): Promise<number | null> {
    const info = await modelInfo(model);
    const built = buildTurn(conv, speaker, turnOptions(model, info, bots));
    const window = info?.contextLength && info.contextLength > 0 ? info.contextLength : Infinity;
    const grown = built.promptTokens + Math.max(0, ahead - 1) * built.completionTokens;
    return costOf(
      model,
      Math.min(grown, Math.max(window, built.promptTokens)),
      built.completionTokens,
    );
  }

  /** What a Start/Resume (or a Step) may cost at most: min(cap left, per-turn estimate × turns left). */
  async function runEstimate(
    conv: Conversation,
    models: Record<Speaker, string>,
    bots: Record<Speaker, BotProfile>,
    mode: LoopMode,
  ): Promise<number> {
    const limits = currentLimits();
    const progress = progressOf(conv);
    const left = mode === 'step' ? 1 : Math.max(0, limits.turns - progress.turns);
    const capLeft = Math.max(0, limits.costUsd - progress.spentUsd);
    if (left === 0) return 0;
    const speakers = left === 1 ? [nextSpeaker(conv)] : SPEAKERS;
    const each = await Promise.all(
      speakers.map((speaker) => turnEstimate(conv, speaker, models[speaker], bots, left)),
    );
    if (each.some((cost) => cost === null)) return capLeft;
    return Math.min(capLeft, Math.max(...(each as number[])) * left);
  }

  // --- runs --------------------------------------------------------------------------------------------------
  /** Why the conversation cannot go on now, said where the user can act on it. */
  function refuse(
    reason: Exclude<StopReason, 'phrase' | 'stopped'>,
    conv: Conversation,
    nextEstimate: number | null,
  ): void {
    const limits = currentLimits();
    const progress = progressOf(conv);
    const raise = 'Raise it under Limits to go on.';
    if (reason === 'turns') {
      ui.status(`The turn limit is reached (${progress.turns} of ${limits.turns}). ${raise}`);
      turnsField.input.focus();
    } else if (reason === 'time') {
      ui.status(`The time limit is used up (${formatMs(limits.timeMs)}). ${raise}`);
      timeField.input.focus();
    } else {
      ui.status(
        progress.spentUsd > 0 && progress.spentUsd >= limits.costUsd
          ? `The cost cap is reached (${formatUsd(progress.spentUsd)} of ${formatUsd(limits.costUsd)}). ${raise}`
          : `The next turn (≈ ${formatUsd(nextEstimate ?? 0)}) could pass the cost cap (${formatUsd(progress.spentUsd)} spent of ${formatUsd(limits.costUsd)}). ${raise}`,
      );
      costField.input.focus();
    }
  }

  async function perform(requested: Action | undefined, signal: AbortSignal): Promise<void> {
    const mode: LoopMode = requested === 'step' ? 'step' : 'continue';
    const creating = conversation === null;
    if (creating && !openerField.value.trim()) {
      ui.status('Write an opening prompt first.');
      openerField.focus();
      return;
    }
    if (nameOf('a').toLowerCase() === nameOf('b').toLowerCase()) {
      ui.status('Give the two bots different names.');
      fields.b.name.focus();
      return;
    }
    const resolved = ctx.model();
    const a = modelOf('a', resolved.model);
    const b = modelOf('b', resolved.model);
    if (!a || !b) {
      throw new InvalidInputError(resolved.note ?? 'No model is available for the bots.');
    }
    const models: Record<Speaker, string> = { a, b };
    const bots = botRecords(models);
    const draft =
      conversation ??
      createConversation({ opener: openerField.value.trim(), first: params.first, bots });
    // Who speaks first follows the form until somebody has spoken.
    const first = turnCount(draft) === 0 ? params.first : draft.first;
    const plan: Conversation = { ...draft, first };
    const speaker = nextSpeaker(plan);
    const nextEstimate = await turnEstimate(plan, speaker, models[speaker], bots);
    const blocked = blockedBy(progressOf(draft), currentLimits(), nextEstimate);
    if (blocked) {
      refuse(blocked, draft, nextEstimate);
      return;
    }
    const release = await lockConversation(draft.id);
    if (!release) {
      throw new InvalidInputError(
        'This conversation is running in another tab. Pause or stop it there first.',
      );
    }
    try {
      const estimateUsd = await runEstimate(plan, models, bots, mode);
      const openingText = opener(draft);
      const run = await ctx.beginRun(
        {
          model: a,
          models: a === b ? [a] : [a, b],
          estimateUsd,
          prompt: openingText,
          groupId: draft.id,
          ...(creating
            ? {}
            : { title: `${mode === 'step' ? 'Step' : 'Resumed'}: ${excerpt(openingText)}` }),
        },
        signal,
      );
      // The run is on: only now does the conversation change.
      if (creating) conversation = draft;
      const conv = draft;
      conv.first = first;
      conv.bots = bots;
      dropFailedEmpty(conv);
      editing = null;
      touch(conv);
      persist();
      renderAll();
      follow(true);
      await converse(run, conv, models, bots, mode, signal);
    } finally {
      release();
    }
  }

  async function converse(
    run: RunHandle,
    conv: Conversation,
    models: Record<Speaker, string>,
    bots: Record<Speaker, BotRecord>,
    mode: LoopMode,
    signal: AbortSignal,
  ): Promise<void> {
    // A Pause pressed before the loop began (during a budget confirmation, say) holds after the first turn.
    clockState = { base: conv.elapsedMs, startedAt: Date.now() };
    const ticker = setInterval(renderStats, 1000);
    const output = (): string => transcript(conv);
    void run.checkpoint({ output }).catch(() => undefined);
    let end: LoopEnd | null = null;
    let failure: { error: unknown } | null = null;
    /** The turn that failed and shows its error inline. */
    let failedTurn = null as Entry | null;
    let lastSpeaker = null as string | null;

    const takeTurn = async (
      turnSignal: AbortSignal,
      timeUp: () => boolean,
    ): Promise<TurnResult> => {
      const speaker = nextSpeaker(conv);
      const model = models[speaker];
      const bot = bots[speaker];
      const info = await modelInfo(model);
      const built: BuiltTurn = buildTurn(conv, speaker, turnOptions(model, info, bots));
      if (built.tooLong) {
        throw new InvalidInputError(
          `The conversation no longer fits ${modelName(model)}'s context window, even with older messages left out. Shorten the last message or choose a model with a larger window.`,
        );
      }
      const estimate = await costOf(model, built.promptTokens, built.completionTokens);
      const entry: Entry = {
        id: newId(),
        kind: 'bot',
        speaker,
        name: bot.name,
        model,
        content: '',
        status: 'streaming',
        createdAt: Date.now(),
        ...(built.trimmed > 0 ? { trimmed: built.trimmed } : {}),
      };
      conv.entries.push(entry);
      live = { entry, stream: null };
      touch(conv);
      persist();
      renderLog();
      renderControls();
      follow(true);
      ui.status(
        `${lastSpeaker ? `${lastSpeaker} finished. ` : ''}${bot.name} is speaking (turn ${turnCount(conv) + 1} of ${currentLimits().turns})…`,
      );

      const usages: Usage[] = [];
      let result: TurnResult;
      try {
        const answer = await ctx.api.chatStream(built.body, {
          run: tapUsage(run, (usage) => usages.push(usage)),
          signal: turnSignal,
          onEvent: (event) => {
            if (event.type !== 'text' || !event.text) return;
            const first = !entry.content;
            entry.content += event.text;
            if (live?.entry !== entry) return;
            if (first) renderLog();
            else live.stream?.append(event.text);
          },
        });
        entry.content = answer.text || entry.content;
        entry.status = 'done';
        result = { status: 'done', content: entry.content };
      } catch (error) {
        if (isAbortError(error) && timeUp() && !run.signal.aborted) {
          entry.status = 'cut';
          result = { status: 'cut', content: entry.content };
        } else if (isStop(error)) {
          entry.status = 'stopped';
          throw error;
        } else {
          entry.status = 'error';
          entry.error = userMessage(error);
          failedTurn = entry;
          throw error;
        }
      } finally {
        const usage = turnUsage(usages, estimate);
        if (usage) {
          entry.usage = usage;
          conv.spentUsd += usage.costUsd;
          if (usage.costEstimated || usage.costUnknown) conv.spentApprox = true;
        }
        conv.elapsedMs = elapsedOf(conv);
        // A turn that said nothing is not kept (a failure is, to show why).
        if (!entry.content.trim() && entry.status !== 'error') {
          conv.entries = conv.entries.filter((item) => item !== entry);
        }
        if (entry.content) await prerender(entry.id, entry.content).catch(() => undefined);
        live?.stream?.dispose();
        live = null;
        touch(conv);
        persist();
        renderLog();
        renderStats();
        void run.checkpoint({ output }).catch(() => undefined);
      }
      lastSpeaker = bot.name;
      return result;
    };

    try {
      end = await runLoop(
        {
          limits: currentLimits,
          progress: () => progressOf(conv),
          estimateNext: () => {
            const speaker = nextSpeaker(conv);
            return turnEstimate(conv, speaker, models[speaker], bots);
          },
          takeTurn,
          pauseRequested: () => pauseRequested,
        },
        mode,
        signal,
      );
    } catch (error) {
      failure = { error };
    } finally {
      conv.elapsedMs = elapsedOf(conv);
      clockState = null;
      clearInterval(ticker);
      pauseRequested = false;
    }

    // Stop (the user's) ends the conversation; an abort from elsewhere (the page closing) only holds it.
    const reason: StopReason | null =
      failure !== null && isStop(failure.error) && signal.aborted
        ? 'stopped'
        : (end?.reason ?? null);
    const ending = reason
      ? endText(reason, {
          limits: currentLimits(),
          spentUsd: conv.spentUsd,
          speakerName: conv.entries.filter(isSpoken).at(-1)?.name,
        })
      : '';
    if (reason) {
      conv.entries.push({
        id: newId(),
        kind: 'end',
        reason,
        content: ending,
        createdAt: Date.now(),
      });
    }
    touch(conv);
    persist();
    renderAll();
    follow();
    void ui.refreshEstimate();

    if (failure !== null) {
      if (isStop(failure.error)) {
        const partial = conv.entries.filter(isSpoken).at(-1);
        ui.status(
          partial?.status === 'stopped' ? 'Stopped. The partial turn is kept.' : 'Stopped.',
        );
        markPresented(failure.error); // announced here; the runner adds nothing
      } else if (failedTurn) {
        ui.status(
          `${failedTurn.name ?? 'The bot'}'s turn failed: ${failedTurn.error ?? userMessage(failure.error)}`,
        );
        // Shown on the turn; errors that need a dialog (a locked key…) still go to the runner, whose Retry resumes.
        if (!needsAction(failure.error)) markPresented(failure.error);
      } else {
        ui.status(`The conversation is on hold: ${userMessage(failure.error)}`);
      }
      await run.fail(failure.error);
      throw failure.error;
    }
    if (reason) ui.status(`Ended. ${ending}`);
    else if (mode === 'step') {
      ui.status(`${lastSpeaker ?? 'The bot'} spoke. Resume or Step to go on.`);
    } else ui.status(`Paused after ${lastSpeaker ?? 'the last'}’s turn.`);
    await run.finish({
      output: output(),
      meta: {
        conversationId: conv.id,
        turns: turnCount(conv),
        ...(reason ? { ended: reason } : {}),
      },
    });
  }

  // --- live updates -------------------------------------------------------------------------------------------
  const loadCatalog = (): void => {
    ctx.models
      .list()
      .then((list) => {
        catalog = new Map(list.map((model) => [model.id, model]));
        renderSetup();
        renderLog();
        void ui.refreshEstimate();
      })
      .catch(() => undefined);
  };
  ctx.settings.subscribe((next, prev) => {
    if (
      next.freeOnly !== prev.freeOnly ||
      next.tools[ctx.manifest.id]?.model !== prev.tools[ctx.manifest.id]?.model ||
      next.defaultModels.text !== prev.defaultModels.text
    ) {
      renderSetup();
    }
  });
  ctx.bus.on('models-refreshed', loadCatalog);

  // --- state ----------------------------------------------------------------------------------------------------
  const snapshot = (): ToolSnapshot => ({
    prompt: openerField.value,
    settings: settingsOf(params),
  });

  function applyState({ prompt, settings }: ToolSnapshot): void {
    openerField.value = prompt;
    const next = paramsFrom({ ...settingsOf(params), ...settings });
    // A `?model=` visit (History's "Re-run with another model") gives Bot A the visit's model.
    if (ctx.modelOverride !== null) next.botA.model = null;
    params = next;
    saveParams();
    renderParams();
    renderAll();
    void ui.refreshEstimate();
  }

  // A link that brings its own setup (a run, a prompt, a sample) fills the opener itself.
  const fromLink = ['run', 'prompt', 'sample', 'receive'].some((name) =>
    new URLSearchParams(location.search).has(name),
  );
  if (conversation && !fromLink) openerField.value = opener(conversation);

  renderParams();
  renderAll();
  loadCatalog();
  runner.subscribe(({ busy, disabledReason }) => {
    runState = { busy, blocked: disabledReason };
    // A Pause asked for during a run that ended (or never began) does not carry over to the next one.
    if (!busy) pauseRequested = false;
    renderControls();
    applyBusy(log, busy);
  });

  return {
    getState: snapshot,
    applyState,
    estimate: async (headerModel) => {
      const models: Record<Speaker, string> = {
        a: params.botA.model ?? headerModel,
        b: params.botB.model ?? headerModel,
      };
      const bots = profiles();
      const conv =
        conversation ??
        createConversation({
          opener: openerField.value,
          first: params.first,
          bots: botRecords(models),
        });
      return runEstimate(conv, models, bots, 'continue');
    },
    sample: async () => {
      const free = await ctx.models
        .forCapability('text')
        .then((list) => list.filter((model) => model.isFree).map((model) => model.id))
        .catch(() => [] as string[]);
      const preferred: string[] = SAMPLE.models.filter((id) => free.includes(id));
      const picks = [...preferred, ...free.filter((id) => !preferred.includes(id))];
      const a = picks[0] ?? SAMPLE.models[0];
      const b = picks[1] ?? (free.length > 0 ? a : SAMPLE.models[1]);
      applyState({
        prompt: SAMPLE.opener,
        settings: {
          ...settingsOf(params),
          botA: { name: SAMPLE.bots.a.name, model: a, persona: SAMPLE.bots.a.persona },
          botB: { name: SAMPLE.bots.b.name, model: b, persona: SAMPLE.bots.b.persona },
          first: 'a',
          turnLimit: SAMPLE.turnLimit,
        },
      });
      openerField.focus();
    },
  };
}
