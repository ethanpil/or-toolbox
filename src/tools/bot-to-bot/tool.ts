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
 * **Persistence.** The conversation (text only) is the tool state `conversation`; every write bumps its `rev` and
 * gives it a new `writeId`. It survives a reload, coming back paused (a turn cut off by the reload keeps its text as
 * stopped). One Web Lock for the whole tool (`ortoolbox:bot-to-bot`) is held by the tab that runs the conversation
 * and, briefly, by a tab that changes it (a moderator message, an edit, New conversation, Undo): while another tab
 * holds it, this one refuses to change or run the conversation and says so. After taking the lock a run reads the
 * stored version again and adopts a newer one. A tab that is idle with no write pending shows whatever is stored
 * (an announcement that arrives during its own write is caught up afterwards). A data reset drops the conversation
 * and nothing written before it is written again. A run in progress is guarded by the leave guard.
 *
 * Loading a setup (History's Re-run, a saved prompt, the sample) never saves it as the user's options, and one
 * with another opening prompt sets the current conversation aside (with Undo): the opener starts a conversation.
 *
 * The transcript is a labelled region, not a live region: turn starts, ends and stops go through `ui.status`.
 * Entries are redrawn only when their signature changes (view.ts); the run's state never rebuilds them.
 */
import { toJsonBlob } from '../../core/export/table';
import { errorCode, InvalidInputError, isAbortError, userMessage } from '../../core/errors';
import { excerpt } from '../../core/runs/index';
import type { ModelInfo, RunHandle, Usage } from '../../core/types';
import {
  debounce,
  holdLock,
  isFiniteNumber,
  isPlainObject,
  isString,
  MINUTE_MS,
} from '../../core/util';
import { copyWithToast } from '../../ui/clipboard';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { createMarkdownCache } from '../../ui/components/markdown-cache';
import { modelPicker } from '../../ui/components/model-picker';
import { type MarkdownStream, streamMarkdown } from '../../ui/components/stream-markdown';
import { focusedKey, focusKey, h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import {
  failureText,
  isStop,
  markPresented,
  needsAction,
  presentError,
} from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatDuration, formatMs, formatUsd, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { composing } from '../../ui/shell/shortcuts';
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
  type EditUndo,
} from './conversation';
import { toJson, toMarkdown } from './export';
import { END_TITLES, endText } from './format';
import {
  blockedBy,
  capReached,
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
  type EntryContext,
  entrySignature,
  entryView,
  type EntryView,
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
  /** null: the tool's default text model (`ctx.model()`: a `?model=` visit, the tool binding, the text default). */
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

/** The runner's argument: Step runs one turn; no argument is Start or Resume. */
type Action = 'step';

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

/** One lock for the whole tool: there is one stored conversation, whatever its id. */
const LOCK_NAME = 'ortoolbox:bot-to-bot';
const OTHER_TAB = 'The conversation is running in another tab. Pause or stop it there first.';

/** The tool's Web Lock if no other tab holds it (the release), else null. Probed, never waited for. */
const lockConversation = (): Promise<(() => void) | null> =>
  holdLock(LOCK_NAME, { ifAvailable: true });

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
  /** Rendered turns, so a redraw parses nothing again (a turn still arriving streams instead). */
  const markdown = createMarkdownCache();
  /** The turn that is streaming, and the renderer drawing it. */
  let live: { entry: Entry; stream: MarkdownStream | null } | null = null;
  let runState: { busy: boolean } = { busy: false };
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

  /**
   * Saves what the user changed as the tool's options: only the given fields. A loaded setup (a sample, a link,
   * History, a saved prompt) is never saved by itself: `applyState` changes the form for this visit only.
   */
  const saveParams = (...keys: (keyof BotsParams)[]): void => {
    const all = settingsOf(params);
    try {
      ctx.options.set(Object.fromEntries(keys.map((key) => [key, all[key]])));
    } catch (error) {
      void presentError(error);
    }
  };

  // --- persistence --------------------------------------------------------------------------------------------
  let writes: Promise<void> = Promise.resolve();
  /** Writes of this tab not stored yet: an announcement meanwhile is caught up once they are (`followStale`). */
  let pendingWrites = 0;
  /** A data reset bumps it: nothing queued or read before a reset is written or shown after it. */
  let epoch = 0;
  /** Another tab announced a change this tab could not look at yet (busy, or writing): look once it can. */
  let followStale = false;
  const queueWrite = (write: () => Promise<void>): void => {
    const mine = epoch;
    pendingWrites++;
    writes = writes
      .then(() => (mine === epoch ? write() : undefined))
      .catch((error: unknown) => {
        // A write from before a data reset that the store refused: exactly what should happen, nothing to say.
        if (mine !== epoch && errorCode(error) === 'state-reset') return;
        void presentError(error);
      })
      .finally(() => {
        pendingWrites--;
        if (pendingWrites === 0 && followStale) void followStore();
      });
  };
  /** Stores the conversation as it is now (a copy: a streaming turn keeps changing), as a new version. */
  const persist = (): void => {
    const conv = conversation;
    if (!conv) return;
    conv.rev += 1;
    conv.writeId = newId();
    const copy = structuredClone(conv);
    queueWrite(() => ctx.state.set(STATE_KEY, copy));
  };

  /** The same stored version: both absent, or the same conversation, rev and write. */
  const sameVersion = (a: Conversation | null, b: Conversation | null): boolean =>
    a === null || b === null
      ? a === b
      : a.id === b.id && a.rev === b.rev && a.writeId === b.writeId;

  const readStored = async (): Promise<Conversation | null> =>
    parseConversation(await ctx.state.get(STATE_KEY));

  /** Shows a version another tab stored (the editor stays open while its entry is still there). */
  const adopt = (stored: Conversation | null): void => {
    conversation = stored;
    renderAll();
    void ui.refreshEstimate();
  };

  /** An idle tab with nothing pending shows what is stored; a busy or writing one looks again when it can. */
  async function followStore(): Promise<void> {
    if (runState.busy || pendingWrites > 0) {
      followStale = true;
      return;
    }
    followStale = false;
    const mine = epoch;
    const stored = await readStored();
    if (mine !== epoch) return;
    if (runState.busy || pendingWrites > 0) {
      followStale = true;
      return;
    }
    if (!sameVersion(stored, conversation)) adopt(stored);
  }

  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool !== ctx.manifest.id || event.key !== STATE_KEY) return;
    followStore().catch(() => undefined);
  });

  /**
   * Changes the conversation (a moderator message, an edit, New conversation, an Undo) only while no other tab
   * runs it: under the tool's lock, held until the change is stored. The tab that runs it already holds the lock.
   * False (and said) when another tab holds it.
   */
  async function whileUnlocked(change: () => void): Promise<boolean> {
    if (runState.busy) {
      change();
      return true;
    }
    const release = await lockConversation();
    if (!release) {
      toast({ variant: 'warning', message: OTHER_TAB, testId: 'bots-other-tab' });
      return false;
    }
    try {
      change();
      await writes;
    } finally {
      release();
    }
    return true;
  }

  // A data reset (Settings → Data, any tab) wipes the stored conversation: drop this tab's copy and stop a run in
  // progress (the core discards it too). Writes queued before it are dropped (`epoch`); the store refuses any
  // write of the old conversation that reaches storage after the wipe (StateResetError, checked in the write's
  // own transaction). Reading the key again re-arms it, so the next conversation is stored without a "reload the
  // page".
  ctx.bus.on('data-reset', () => {
    epoch++;
    conversation = null;
    editing = null;
    followStale = false;
    params = paramsFrom(ctx.options.get());
    runner.stop();
    renderParams();
    renderAll();
    void followStore();
  });

  /** Fields whose change re-arms the time limit of a turn in flight. */
  const limitListeners = new Set<() => void>();
  const limitsChanged = (): void => {
    for (const fn of [...limitListeners]) fn();
  };

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
      onchange: () => saveParams(key),
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
      onchange: () => saveParams(key),
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
        class: 'btn btn-sm btn-link or-icon-action',
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
  /** Says what the field does now: it starts a conversation; an open one keeps its own opener. */
  const openerHintEl = h('div', {
    id: openerHint,
    class: 'form-text',
    'data-testid': 'bots-opener-hint',
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
        saveParams('first');
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
    onchange: () => saveParams('stopPhrase'),
  });

  /** A number field bound to one parameter (`null` allowed only where the parameter takes it: Max tokens). */
  interface NumberBinding {
    input: HTMLInputElement;
    key: 'turnLimit' | 'timeLimitMinutes' | 'costCapUsd' | 'maxTokens';
    range: { min: number; max: number };
    integer: boolean;
  }
  /**
   * Takes a number field's value into `params`, clamped and written back; an unusable one is replaced by the value
   * in force. Done on `change` and again at the start of every run: Ctrl/Cmd+Enter starts one without a blur, so a
   * value typed and not yet committed must still count. (Not on every keystroke: typing "25" over "20" would
   * briefly set a running conversation's limit to 2.) True when the value changed.
   */
  const commitNumber = (binding: NumberBinding): boolean => {
    const { input, key, range, integer } = binding;
    const before = params[key];
    const text = input.value.trim();
    if (text === '' && key === 'maxTokens') {
      params.maxTokens = null;
    } else {
      const value = Number(text);
      if (text !== '' && Number.isFinite(value)) {
        params[key] = Math.min(range.max, Math.max(range.min, integer ? Math.round(value) : value));
      }
      input.value = params[key] === null ? '' : String(params[key]);
    }
    if (params[key] === before) return false;
    if (key === 'timeLimitMinutes') limitsChanged();
    return true;
  };
  const numberBindings: NumberBinding[] = [];
  const bindNumber = (binding: NumberBinding): void => {
    numberBindings.push(binding);
    binding.input.addEventListener('change', () => {
      commitNumber(binding);
      saveParams(binding.key);
      setupChanged();
    });
  };
  /** Every number field as it reads now (before a run): what Ctrl/Cmd+Enter runs with. */
  const commitNumbers = (): void => {
    const changed = numberBindings.filter((binding) => commitNumber(binding));
    if (changed.length === 0) return;
    saveParams(...changed.map((binding) => binding.key));
    setupChanged();
  };
  bindNumber({ input: turnsField.input, key: 'turnLimit', range: RANGES.turnLimit, integer: true });
  bindNumber({
    input: timeField.input,
    key: 'timeLimitMinutes',
    range: RANGES.timeLimitMinutes,
    integer: false,
  });
  bindNumber({
    input: costField.input,
    key: 'costCapUsd',
    range: RANGES.costCapUsd,
    integer: false,
  });

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
      openerHintEl,
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
  });
  bindNumber({ input: maxTokensInput, key: 'maxTokens', range: RANGES.maxTokens, integer: true });
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
        build: () => toJsonBlob(conversation ? toJson(conversation, exportContext()) : null),
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
        if (clearButton.getAttribute('aria-disabled') !== 'true') void clearConversation();
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
      onclick: () => void inject(),
    },
    icon('megaphone'),
    'Send',
  );
  modInput.addEventListener('keydown', (event) => {
    if (composing(event) || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
    // Enter (and Ctrl/Cmd+Enter, never the page's Run shortcut here) sends.
    event.preventDefault();
    event.stopPropagation();
    void inject();
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

  // --- run bar: Start/Resume and Step, or Pause and Stop (the runner's own bar) ----------------------------------
  // Ctrl/Cmd+Enter (no argument) is the primary action: Start, or Resume once there is a conversation.
  const runner = ui.runner<Action>({
    label: 'Start',
    icon: 'play-fill',
    hideWhileBusy: true,
    run: (signal, action) => perform(action, signal),
  });
  runner.addAction({
    label: 'Step',
    icon: 'skip-end-fill',
    run: 'step',
    title: 'Run exactly one turn, then hold',
    tone: 'primary',
    testId: 'bots-step',
  });
  const pause = runner.addAction({
    label: 'Pause',
    icon: 'pause-fill',
    when: 'busy',
    onClick: () => requestPause(),
    testId: 'bots-pause',
  });

  function requestPause(): void {
    if (!runState.busy || pauseRequested) return;
    pauseRequested = true;
    renderControls();
    ui.status('Pausing after this turn…');
  }

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
      `${formatDuration(elapsed / 1000)} / ${formatDuration(limits.timeMs / 1000)}`,
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

  const setOff = (button: HTMLElement, off: boolean): void => {
    button.setAttribute('aria-disabled', String(off));
    button.classList.toggle('disabled', off);
  };

  const renderControls = (): void => {
    const { busy } = runState;
    // The runner keeps Run, Step and Pause in step with busy and blocked; the tool only names them.
    runner.setLabel(conversation ? 'Resume' : 'Start');
    pause.setLabel(pauseRequested ? 'Pausing…' : 'Pause');
    pause.setDisabled(pauseRequested ? 'Pausing after this turn' : null);
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
    openerHintEl.textContent = conversation
      ? 'Used by your next conversation: this one keeps its own (edit it in the transcript). New conversation starts with this one.'
      : 'Both bots see it as the moderator’s first message.';
  };

  /**
   * Whether the reader is at the end of the transcript, measured when they scroll (never after the content grew:
   * a render adding a lot would otherwise look like scrolling up). Our own scrolls do not count.
   */
  let pinned = true;
  let ownScrollTop = -1;
  log.addEventListener('scroll', () => {
    if (pinned && log.scrollTop === ownScrollTop) return;
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  });
  /** Keeps the newest text in view while it arrives, unless the reader scrolled up (`force`: the user acted). */
  const follow = (force = false): void => {
    if (!force && !pinned) return;
    log.scrollTop = log.scrollHeight;
    ownScrollTop = log.scrollTop;
    pinned = true;
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
    save: (entry: Entry, text: string) => void saveEdit(entry, text),
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
    markdown,
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
    saveParams(BOT_KEY[speaker]);
    setupChanged();
    if (model === null) fields[speaker].modelButton.focus();
    const shown = modelOf(speaker);
    announce(`${nameOf(speaker)} now uses ${shown ? modelName(shown) : 'no model'}.`);
  }

  async function inject(): Promise<void> {
    if (!conversation) return;
    const text = modInput.value.trim();
    if (!text) {
      ui.status('Write a message for the bots first.');
      modInput.focus();
      return;
    }
    const added = await whileUnlocked(() => {
      if (!conversation) return;
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
    });
    if (!added) return;
    announce(
      runState.busy
        ? 'Moderator message added. The next bot to speak sees it.'
        : 'Moderator message added.',
    );
  }

  async function saveEdit(entry: Entry, text: string): Promise<void> {
    if (runState.busy || !conversation) return;
    const written = text.trim();
    if (!written) {
      ui.status('A message cannot be empty.');
      return;
    }
    let undo: EditUndo | null = null;
    const conv = conversation;
    // Refused (another tab runs it): the editor stays open with what was typed.
    const saved = await whileUnlocked(() => {
      if (conversation !== conv) return;
      undo = editEntry(conv, entry.id, written);
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
    });
    const done = undo as EditUndo | null;
    if (!saved || !done) return;
    if (done.removed.length === 0) {
      announce('Message edited. Resume carries on from here.');
      return;
    }
    toast({
      message: `Message edited; ${plural(done.removed.length, 'message')} after it removed.`,
      testId: 'bots-edit-toast',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => void undoEditPressed(conv, done),
      },
    });
  }

  async function undoEditPressed(conv: Conversation, undo: EditUndo): Promise<void> {
    let undone = false;
    const allowed = await whileUnlocked(() => {
      if (runState.busy || conversation !== conv || !undoEdit(conv, undo)) return;
      undone = true;
      touch(conv);
      persist();
      renderAll();
      // The toast's button goes away: focus goes back to the turn the edit was on.
      if (!focusKey(log, `edit-button:${undo.id}`)) runner.button.focus();
      void ui.refreshEstimate();
    });
    if (!allowed) return;
    if (!undone) {
      toast({
        variant: 'warning',
        message: 'The messages cannot come back: the conversation went on since.',
        testId: 'undo-refused',
      });
      return;
    }
    announce('Edit undone.');
  }

  /**
   * Clears the conversation (New conversation, or a loaded setup with another opener: `message` says which), with
   * Undo while nothing new was started.
   */
  async function clearConversation(
    message = 'Conversation cleared. Start begins a new one.',
  ): Promise<void> {
    if (runState.busy || !conversation) return;
    let removed: Conversation | null = null;
    const cleared = await whileUnlocked(() => {
      if (runState.busy || !conversation) return;
      removed = conversation;
      conversation = null;
      editing = null;
      queueWrite(() => ctx.state.delete(STATE_KEY));
      renderAll();
      // New conversation turned itself off: Start is next.
      const active = document.activeElement;
      if (!active || active === document.body || clearButton.contains(active)) {
        runner.button.focus();
      }
      void ui.refreshEstimate();
    });
    const previous = removed as Conversation | null;
    if (!cleared || !previous) return;
    toast({
      message,
      testId: 'bots-cleared-toast',
      action: { label: 'Undo', testId: 'toast-undo', onClick: () => void undoClear(previous) },
    });
  }

  async function undoClear(previous: Conversation): Promise<void> {
    let restored = false;
    const allowed = await whileUnlocked(() => {
      if (conversation) return;
      conversation = previous;
      restored = true;
      persist();
      renderAll();
      // The toast's button goes away: focus goes to Resume.
      runner.button.focus();
      void ui.refreshEstimate();
    });
    if (!allowed) return;
    if (!restored) {
      toast({
        variant: 'warning',
        message: 'The conversation cannot come back: a new one was started since.',
        testId: 'undo-refused',
      });
      return;
    }
    announce('Conversation restored.');
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
  async function planTurn(
    conv: Pick<Conversation, 'entries'>,
    speaker: Speaker,
    model: string,
    bots: Record<Speaker, BotProfile>,
    ahead = 1,
  ): Promise<{ built: BuiltTurn; cost: number | null }> {
    const info = await modelInfo(model);
    const built = buildTurn(conv, speaker, turnOptions(model, info, bots));
    const window = info?.contextLength && info.contextLength > 0 ? info.contextLength : Infinity;
    const grown = built.promptTokens + Math.max(0, ahead - 1) * built.completionTokens;
    const cost = await costOf(
      model,
      Math.min(grown, Math.max(window, built.promptTokens)),
      built.completionTokens,
    );
    return { built, cost };
  }
  const turnEstimate = async (...args: Parameters<typeof planTurn>): Promise<number | null> =>
    (await planTurn(...args)).cost;

  /** Refused before sending: even with older messages left out, the next turn does not fit. */
  const tooLong = (model: string): InvalidInputError =>
    new InvalidInputError(
      `This conversation is too long for ${modelName(model)}: even with older messages left out it does not fit the model's context window. Shorten the opening prompt or the last message, or choose a model with a larger window.`,
    );

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
        capReached(progress.spentUsd, limits.costUsd)
          ? `The cost cap is reached (${formatUsd(progress.spentUsd)} of ${formatUsd(limits.costUsd)}). ${raise}`
          : `The next turn (≈ ${formatUsd(nextEstimate ?? 0)}) could pass the cost cap (${formatUsd(progress.spentUsd)} spent of ${formatUsd(limits.costUsd)}). ${raise}`,
      );
      costField.input.focus();
    }
  }

  async function perform(requested: Action | undefined, signal: AbortSignal): Promise<void> {
    const mode: LoopMode = requested === 'step' ? 'step' : 'continue';
    // What the fields say now: Ctrl/Cmd+Enter starts a run without the blur that commits them.
    commitNumbers();
    // An open editor with changes is never thrown away by a run; an unchanged one just closes.
    if (editing) {
      const open = editing;
      const entry = conversation?.entries.find((item) => item.id === open.id);
      if (entry && open.text.trim() !== entry.content.trim()) {
        ui.status('Save or cancel your edit first.');
        focusKey(log, `edit:${open.id}`);
        return;
      }
      editing = null;
      renderLog();
    }
    if (!conversation && !openerField.value.trim()) {
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
    const release = await lockConversation();
    if (!release) throw new InvalidInputError(OTHER_TAB);
    try {
      // Another tab may have changed it since this one last looked: run only what is stored now.
      await writes;
      const stored = await readStored();
      if (!sameVersion(stored, conversation)) {
        adopt(stored);
        ui.status(
          'The conversation changed in another tab; this is its latest version. Press Resume or Step to go on.',
        );
        return;
      }
      const creating = conversation === null;
      const draft =
        conversation ??
        createConversation({ opener: openerField.value.trim(), first: params.first, bots });
      // Who speaks first follows the form until somebody has spoken.
      const first = turnCount(draft) === 0 ? params.first : draft.first;
      const plan: Conversation = { ...draft, first };
      const speaker = nextSpeaker(plan);
      const next = await planTurn(plan, speaker, models[speaker], bots);
      if (next.built.tooLong) throw tooLong(models[speaker]);
      const blocked = blockedBy(progressOf(draft), currentLimits(), next.cost);
      if (blocked) {
        refuse(blocked, draft, next.cost);
        return;
      }
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
      // (Checked before the run too; a later turn of the loop may have grown past the window.)
      if (built.tooLong) throw tooLong(model);
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
      follow(); // never pulls down a reader who scrolled up
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
        // A reply without text is a failure, not a turn: asking again would send the same request (and pay).
        if (!entry.content.trim()) {
          throw new InvalidInputError(
            `${bot.name} sent no text. It may have spent its token limit on reasoning: raise Max tokens per turn in Settings, or choose another model.`,
          );
        }
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
          // The shared wording, and the caution kept with it when the request may have gone through.
          const failed = failureText(error);
          entry.status = 'error';
          entry.error = failed.text;
          if (failed.outcomeUnknown) entry.outcomeUnknown = true;
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
        if (entry.content) await markdown.prerender(entry.id, entry.content).catch(() => undefined);
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
          onLimitsChange: (fn) => {
            limitListeners.add(fn);
            return () => limitListeners.delete(fn);
          },
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
    const lastSpoken = conv.entries.filter(isSpoken).at(-1);
    const ending = reason
      ? endText(reason, {
          // The limits that applied when it ended (a field may have changed since).
          limits: end?.limits ?? currentLimits(),
          spentUsd: conv.spentUsd,
          speakerName: lastSpoken?.speaker ? bots[lastSpoken.speaker].name : lastSpoken?.name,
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
        ui.status(`${failedTurn.name ?? 'The bot'}'s turn failed: ${failedTurn.error ?? ''}`);
        // Shown on the turn: that is the presentation (with the caution and the activity link, and no Resume
        // prompt, when it may have gone through). Errors that need a dialog (a locked key…) still go to the
        // runner, whose Retry resumes.
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

  /**
   * Loads a setup (Prompts' Use, History's Reopen and Re-run, `?prompt=`, the sample) for this visit: nothing is
   * saved as the user's options. With another opening prompt than the open conversation's it is a new
   * conversation, so the open one is set aside (Undo brings it back); the same opener keeps it.
   */
  function applyState({ prompt, settings }: ToolSnapshot): void {
    openerField.value = prompt;
    const next = paramsFrom({ ...settingsOf(params), ...settings });
    // A `?model=` visit (History's "Re-run with another model") gives Bot A the visit's model.
    if (ctx.modelOverride !== null) next.botA.model = null;
    params = next;
    renderParams();
    renderAll();
    void ui.refreshEstimate();
    if (conversation && !runState.busy && prompt.trim() !== opener(conversation).trim()) {
      void clearConversation(
        'The loaded setup has another opening prompt, so the conversation was set aside. Start begins the new one.',
      );
    }
  }

  // A link that brings its own setup (a run, a prompt, a sample) fills the opener itself.
  const fromLink = ['run', 'prompt', 'sample', 'receive'].some((name) =>
    new URLSearchParams(location.search).has(name),
  );
  if (conversation && !fromLink) openerField.value = opener(conversation);

  renderParams();
  renderAll();
  loadCatalog();
  runner.subscribe(({ busy }) => {
    runState = { busy };
    // A Pause asked for during a run that ended (or never began) does not carry over to the next one.
    if (!busy) pauseRequested = false;
    renderControls();
    applyBusy(log, busy);
    // Another tab's change announced while this one ran: look now.
    if (!busy && followStale) void followStore();
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
