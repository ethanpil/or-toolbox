/**
 * Model arena: one prompt (and files) to 2–4 models at once, answers side by side, blind voting and a local tally.
 *
 * Layout (the three-zone tool layout): prompt, files and contenders on the left; the round on the right (panels
 * in a two-column grid, the vote bar, the comparison table and the tally); blind voting, system prompt and
 * temperature in Settings, the PDF reader under Advanced. The header has no model chip (`modelChip: false`):
 * the contenders are the models.
 *
 * A round is one run per contender, begun in parallel with the round's id as `groupId` (one budget dialog for
 * all) and each booking its own estimate and PDF parser add-on; the header's estimate is their sum. The round
 * starts only once every `beginRun` has answered, so a refused round changes nothing, and the requests then go
 * out together, which keeps time-to-first-token fair. One contender failing never stops the others: it shows its
 * error inline with its own Retry (the runner's argument `{ kind: 'retry', index }`, a new run in the same
 * group, with the round's own input). Stop aborts every run in flight.
 *
 * Blind rounds shuffle the panels (Model A–D) and hide names and costs until a vote (or "Reveal without
 * voting", which takes no vote). Votes go to a small tally in the tool's state (`tally`), read-modify-write
 * under a Web Lock; Reset offers Undo, which adds back the old counts to whatever was voted since.
 *
 * `getState`/`applyState` carry the prompt and the whole form (contenders, system prompt, temperature, blind,
 * PDF reader), and the form is also kept in the tool's options for the next visit. Files are not part of it:
 * their bytes stay in memory (rule 3). A `?model=` visit (History's "Re-run with another model") puts that
 * model in place of the contender whose run was opened (contender 1 without a run).
 */
import type { WireUsage } from '../../core/api/types';
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
import { missingInput, needsParser, parserAddons } from '../../core/attachments/request';
import { FreeOnlyError, InvalidInputError, isOutcomeUnknown, userMessage } from '../../core/errors';
import { webLocks } from '../../core/jobs/index';
import { isPdfEngineId, PDF_ENGINES, pdfEngine } from '../../core/models/pdf-engines';
import { paidAddons } from '../../core/runs/addons';
import type { ModelInfo, RunAddon, RunHandle, UsageTotals } from '../../core/types';
import { debounce, isFiniteNumber } from '../../core/util';
import { attachmentChip } from '../../ui/components/attachment-chip';
import { emptyState } from '../../ui/components/empty-state';
import { exportMenu } from '../../ui/components/export-menu';
import { modelPicker } from '../../ui/components/model-picker';
import { switchField } from '../../ui/components/switch-field';
import { focusKey, h, replace, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented, needsAction, presentError } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { formatBytes, formatModelPrice, plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { retryGate } from '../../ui/tool/retry-gate';
import type { SendItem, ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/types';
import { roundJson, roundMarkdown } from './export';
import {
  type ArenaInput,
  type ContenderRequest,
  contenderRequest,
  fitOutput,
  inputTokens,
} from './request';
import {
  type ArenaSettings,
  canVote,
  castVote,
  DEFAULT_SETTINGS,
  defaultContenders,
  type Entry,
  type EntryUsage,
  exportReady,
  hasAnswer,
  MAX_CONTENDERS,
  MAX_TOKENS_LIMIT,
  MIN_CONTENDERS,
  newRound,
  panelLabel,
  panelLetter,
  panelOf,
  reveal,
  type Round,
  settingsFrom,
  type Vote,
} from './round';
import { addVote, emptyTally, isEmptyTally, mergeTallies, parseTally, type Tally } from './tally';
import {
  comparisonTable,
  type Naming,
  panelView,
  type PanelView,
  tallyView,
  voteBar,
} from './view';

export const SAMPLE_PROMPT =
  'Explain why the sky is blue to a curious ten-year-old in under 120 words, then give one everyday example.';

const STATE_TALLY = 'tally';
const TALLY_LOCK = 'ortoolbox:model-arena:tally';

/** The runner's argument: a new round, or one failed contender of the current round again. */
export type RunArg = { kind: 'round' } | { kind: 'retry'; index: number };

const MISSING_INPUT: Readonly<Record<'image' | 'audio' | 'file', string>> = {
  image: "can't read images",
  audio: "doesn't take audio",
  file: "can't read PDF files itself",
};

/** The round on screen, with what only this page holds: its files (bytes in `session`) and its panels. */
interface Live {
  round: Round;
  files: AttachmentRef[];
  panels: PanelView[];
}

/** One contender's part of a round, planned before anything is booked. */
interface Planned {
  model: string;
  request: ContenderRequest;
  estimate: number | null;
  addons: RunAddon[];
}

const now = (): number => performance.now();

export async function setup(ctx: ToolContext): Promise<ToolInstance> {
  const { ui } = ctx;
  /** Data URLs of image, PDF and audio files, by attachment id: this page only. */
  const session = new Map<string, string>();
  let files: AttachmentRef[] = [];
  let live: Live | null = null;
  let tally: Tally = emptyTally();

  // --- models -------------------------------------------------------------------------------------------
  let catalog = new Map<string, ModelInfo>();
  const fillCatalog = (list: readonly ModelInfo[]): void => {
    catalog = new Map(list.map((model) => [model.id, model]));
  };
  const naming: Naming = {
    name: (id) => catalog.get(id)?.name ?? id,
    isFree: (id) => ctx.models.isFree(id),
  };

  // The form as last used; a first visit picks distinct free text models, which needs the catalog first.
  let form: ArenaSettings = settingsFrom(ctx.options.get(), { ...DEFAULT_SETTINGS, models: [] });
  if (form.models.length === 0) {
    fillCatalog(await ctx.models.list().catch(() => []));
    const textDefault = ctx.model().model;
    form.models = defaultContenders(
      [...catalog.values()].filter((model) => model.capabilities.includes('text')),
      [
        textDefault,
        ctx.models.shippedDefault('text').free,
        ctx.models.shippedDefault('vision').free,
      ],
      [textDefault, ctx.models.shippedDefault('text').paid],
    );
  }

  const saveForm = (): void => {
    try {
      ctx.options.set({ ...form, models: [...form.models] });
    } catch (error) {
      void presentError(error);
    }
  };

  // `?model=` (History's "Re-run with another model"): the model replaces the contender whose run was opened.
  let overrideNote: { slot: number; model: string } | null = null;
  let pendingOverride: { target: string | null } | null = null;
  if (ctx.modelOverride) {
    const runId = new URLSearchParams(location.search).get('run');
    const record = runId ? await ctx.history.get(runId).catch(() => undefined) : undefined;
    pendingOverride = { target: record?.tool === ctx.manifest.id ? record.model : null };
    // Without a round of this tool to reopen, no applyState follows: replace contender 1 now, and keep it like
    // any other form change (applyState saves the reopened round the same way).
    if (!record || record.tool !== ctx.manifest.id) {
      applyOverride();
      saveForm();
    }
  }

  function applyOverride(): void {
    const override = ctx.modelOverride;
    const target = pendingOverride?.target ?? null;
    pendingOverride = null;
    if (!override) return;
    const index = target ? form.models.indexOf(target) : -1;
    const slot = index >= 0 ? index : 0;
    form.models[slot] = override;
    overrideNote = { slot, model: override };
  }

  // --- input zone: prompt, files, contenders -------------------------------------------------------------
  const ids = { prompt: uid('prompt'), hint: uid('prompt-hint'), contenders: uid('contenders') };
  const promptInput = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 5,
    placeholder: 'Ask something to compare the models on, or drop files here',
    'aria-describedby': ids.hint,
    'data-testid': 'tool-prompt',
  });
  const fileInput = h('input', {
    type: 'file',
    hidden: true,
    multiple: true,
    accept: ACCEPT_ATTRIBUTE,
    tabIndex: -1,
    'data-testid': 'arena-file',
    onchange: () => {
      void addFiles([...(fileInput.files ?? [])]);
      fileInput.value = '';
    },
  });
  const fileList = h('ul', {
    class: 'list-unstyled d-flex flex-wrap gap-2 mb-0 empty-hidden',
    'aria-label': 'Files sent with the prompt',
    'data-testid': 'arena-files',
  });
  const contenderList = h('ol', {
    class: 'list-group or-arena-contenders',
    'aria-labelledby': ids.contenders,
    'data-testid': 'arena-contenders',
  });
  const contenderCount = h('span', {
    class: 'badge rounded-pill text-bg-secondary',
    'data-testid': 'contender-count',
  });
  const addButton = h(
    'button',
    {
      type: 'button',
      class:
        'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1 align-self-start',
      'data-focus-key': 'contender-add',
      'data-testid': 'contender-add',
      onclick: () => void addContender(),
    },
    icon('plus-lg'),
    'Add a contender',
  );
  const overrideArea = h('div', { class: 'empty-hidden' });

  ui.input.append(
    h(
      'div',
      { class: 'd-flex flex-column gap-2' },
      h('label', { class: 'form-label fw-semibold mb-0', htmlFor: ids.prompt }, 'Prompt'),
      promptInput,
      h(
        'p',
        { id: ids.hint, class: 'form-text mt-0 mb-0' },
        'Every contender gets the same prompt and files.',
      ),
      fileList,
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2',
            'data-testid': 'arena-attach',
            onclick: () => fileInput.click(),
          },
          icon('paperclip'),
          'Attach files',
        ),
        fileInput,
        h(
          'span',
          { class: 'small text-body-secondary' },
          'Images, PDFs, audio and text; or drop or paste them anywhere.',
        ),
      ),
    ),
    h(
      'div',
      { class: 'd-flex flex-column gap-2' },
      h(
        'div',
        { class: 'd-flex align-items-center gap-2' },
        h('h3', { id: ids.contenders, class: 'h6 mb-0' }, 'Contenders'),
        contenderCount,
      ),
      overrideArea,
      contenderList,
      addButton,
    ),
  );

  // --- settings drawer ----------------------------------------------------------------------------------
  const drawerIds = {
    system: uid('system'),
    temperature: uid('temperature'),
    maxTokens: uid('max-tokens'),
    engine: uid('pdf'),
  };
  const blindSwitch = switchField({
    label: 'Blind voting',
    help: 'Answers are shuffled and shown as Model A to D. Names and costs show after you vote.',
    checked: form.blind,
    testId: 'arena-blind',
    onChange: (on) => {
      form.blind = on;
      saveForm();
    },
  });
  const saveSoon = debounce(saveForm, 400);
  const systemArea = h('textarea', {
    id: drawerIds.system,
    class: 'form-control',
    rows: 4,
    placeholder: 'Optional. For example: Answer in at most three sentences.',
    'data-testid': 'arena-system',
    oninput: () => {
      form.system = systemArea.value;
      saveSoon();
      refreshSoon();
    },
  });
  const temperatureInput = h('input', {
    id: drawerIds.temperature,
    type: 'number',
    class: 'form-control',
    min: '0',
    max: '2',
    step: '0.1',
    placeholder: 'Model default',
    inputMode: 'decimal',
    'data-testid': 'arena-temperature',
    onchange: () => {
      const raw = temperatureInput.value.trim();
      const value = raw === '' ? null : Number(raw);
      form.temperature =
        value === null || !Number.isFinite(value) ? null : Math.min(2, Math.max(0, value));
      temperatureInput.value = form.temperature === null ? '' : String(form.temperature);
      saveForm();
    },
  });
  const maxTokensInput = h('input', {
    id: drawerIds.maxTokens,
    type: 'number',
    class: 'form-control',
    min: '1',
    max: String(MAX_TOKENS_LIMIT),
    step: '1',
    placeholder: 'Model default',
    inputMode: 'numeric',
    'data-testid': 'arena-max-tokens',
    onchange: () => {
      const raw = maxTokensInput.value.trim();
      const value = raw === '' ? null : Number(raw);
      form.maxTokens =
        value === null || !Number.isFinite(value)
          ? null
          : Math.min(MAX_TOKENS_LIMIT, Math.max(1, Math.round(value)));
      maxTokensInput.value = form.maxTokens === null ? '' : String(form.maxTokens);
      saveForm();
      renderContenders();
      void ui.refreshEstimate();
    },
  });
  ui.drawer.append(
    blindSwitch.element,
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: drawerIds.system }, 'System prompt'),
      systemArea,
      h('div', { class: 'form-text' }, 'Sent to every contender before the prompt.'),
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
      h(
        'div',
        { class: 'col-12 form-text mt-1' },
        'Temperature 0 to 2. Max tokens caps each answer (and what the estimate assumes). Empty uses each model’s default.',
      ),
    ),
  );
  const engineHint = h('div', { id: `${drawerIds.engine}-hint`, class: 'form-text' });
  const engineSelect = h(
    'select',
    {
      id: drawerIds.engine,
      class: 'form-select',
      'aria-describedby': `${drawerIds.engine}-hint`,
      'data-testid': 'arena-pdf-engine',
      onchange: () => {
        form.pdfEngine = isPdfEngineId(engineSelect.value) ? engineSelect.value : 'cloudflare-ai';
        saveForm();
        renderEngineHint();
        renderContenders();
        void ui.refreshEstimate();
      },
    },
    PDF_ENGINES.map((engine) => h('option', { value: engine.id }, engine.label)),
  );
  const renderEngineHint = (): void => {
    engineHint.textContent = `${pdfEngine(form.pdfEngine).hint} Every contender's request reads the PDF, and a paid reader is charged for each. A PDF read once is sent as text in later rounds.`;
  };
  ui.advanced('PDFs').append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: drawerIds.engine }, 'PDF reader'),
      engineSelect,
      engineHint,
    ),
  );

  // --- output zone ----------------------------------------------------------------------------------------
  const roundTitle = h('h3', { class: 'h6 mb-0', 'data-testid': 'round-title' });
  const exportHint = h('span', {
    class: 'small text-body-secondary',
    'data-testid': 'export-hint',
  });
  const menu = exportMenu({
    label: 'Export',
    filename: () => `Model arena - ${(live?.round.prompt ?? '').slice(0, 40).trim() || 'round'}`,
    formats: [
      {
        label: 'Markdown',
        extension: 'md',
        icon: 'markdown',
        build: () =>
          new Blob([live ? roundMarkdown(live.round, naming.name) : ''], { type: 'text/markdown' }),
      },
      {
        label: 'JSON',
        extension: 'json',
        icon: 'filetype-json',
        build: () =>
          new Blob([live ? `${JSON.stringify(roundJson(live.round), null, 2)}\n` : ''], {
            type: 'application/json',
          }),
      },
    ],
    disabled: true,
    testId: 'arena-export',
  });
  const roundHeader = h(
    'div',
    { class: 'd-flex flex-wrap align-items-center gap-2', hidden: true },
    roundTitle,
    h('div', { class: 'ms-auto d-flex flex-wrap align-items-center gap-2' }, exportHint, menu),
  );
  const empty = emptyState({
    icon: 'trophy',
    title: 'No round yet',
    text: 'Write a prompt, pick two to four models and press Compare. The answers stream in side by side.',
    testId: 'arena-empty',
  });
  const panelGrid = h('div', {
    class: 'row row-cols-1 row-cols-md-2 g-3',
    hidden: true,
    'data-testid': 'arena-panels',
  });
  const voteArea = h('div', {
    class: 'or-arena-vote',
    hidden: true,
    'data-testid': 'arena-vote',
  });
  const compareTitleId = uid('compare-title');
  const compareView = comparisonTable(naming);
  const compareArea = h(
    'section',
    { hidden: true, 'aria-labelledby': compareTitleId, 'data-testid': 'arena-compare' },
    h('h3', { id: compareTitleId, class: 'h6' }, 'Side by side'),
    compareView.element,
  );
  const tallyTitleId = uid('tally-title');
  const tallyTitle = h(
    'h3',
    { id: tallyTitleId, class: 'h6 mb-0 or-arena-heading', tabIndex: -1 },
    'Your votes',
  );
  const tallyTableView = tallyView(naming);
  const resetButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'data-testid': 'tally-reset',
      onclick: () => void resetTally(),
    },
    icon('arrow-counterclockwise'),
    'Reset',
  );
  const tallyArea = h(
    'section',
    { class: 'or-arena-tally', 'aria-labelledby': tallyTitleId, 'data-testid': 'arena-tally' },
    h(
      'div',
      { class: 'd-flex align-items-center gap-2 mb-2' },
      tallyTitle,
      h('div', { class: 'ms-auto' }, resetButton),
    ),
    tallyTableView.element,
  );
  ui.output.append(
    h(
      'div',
      { class: 'd-flex flex-column gap-4' },
      roundHeader,
      empty,
      panelGrid,
      voteArea,
      compareArea,
      tallyArea,
    ),
  );

  // --- rendering ------------------------------------------------------------------------------------------
  /** The form's input as it is now; a round takes it once, when Compare is pressed. */
  const input = (): ArenaInput => ({
    prompt: promptInput.value.trim(),
    system: form.system,
    temperature: form.temperature,
    maxTokens: form.maxTokens,
    pdfEngine: form.pdfEngine,
    attachments: [...files],
    data: (id) => session.get(id),
  });

  /** What stops a model from running this input (`promptTokens` counted once for all), or null. */
  function problemFor(model: string, promptTokens: number): string | null {
    const info = catalog.get(model);
    if (ctx.settings.get().freeOnly && !ctx.models.isFree(model)) {
      return 'Not free, and free-only mode is on';
    }
    if (info) {
      const missing = missingInput(files, info.inputModalities, form.pdfEngine, (id) =>
        session.has(id),
      );
      if (missing) return `This model ${MISSING_INPUT[missing]}`;
      if (fitOutput(promptTokens, info, form.maxTokens).tooLong) {
        return 'The prompt and files are too long for this model';
      }
    }
    return null;
  }

  function renderContenders(): void {
    const count = form.models.length;
    const promptTokens = inputTokens(input());
    contenderCount.textContent = `${count} of ${MAX_CONTENDERS}`;
    contenderCount.setAttribute('aria-label', `${count} of at most ${MAX_CONTENDERS}`);
    replace(
      contenderList,
      form.models.map((model, index) => {
        const name = naming.name(model);
        const info = catalog.get(model);
        const problem = problemFor(model, promptTokens);
        return h(
          'li',
          {
            class: 'list-group-item d-flex align-items-center gap-2 or-arena-contender',
            'data-testid': 'contender',
          },
          h('span', { class: 'or-arena-slot', 'aria-hidden': 'true' }, String(index + 1)),
          h(
            'div',
            { class: 'min-w-0 flex-grow-1' },
            h(
              'div',
              { class: 'fw-semibold text-break', title: model, 'data-testid': 'contender-name' },
              name,
            ),
            h(
              'div',
              { class: 'small text-body-secondary text-truncate' },
              ctx.models.isFree(model)
                ? h('span', { class: 'badge rounded-pill text-bg-success me-1' }, 'Free')
                : info
                  ? `${formatModelPrice(info)} · `
                  : null,
              model,
            ),
            problem
              ? h(
                  'div',
                  {
                    class: 'small text-warning-emphasis d-flex gap-1 align-items-start',
                    'data-testid': 'contender-warning',
                  },
                  icon('exclamation-triangle'),
                  problem,
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-sm btn-outline-secondary flex-shrink-0',
              'aria-label': `Change contender ${index + 1}, ${name}`,
              'data-focus-key': `change:${index}`,
              'data-testid': 'contender-change',
              onclick: () => void changeContender(index),
            },
            'Change',
          ),
          count > MIN_CONTENDERS
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-link or-attachment-remove flex-shrink-0',
                  'aria-label': `Remove contender ${index + 1}, ${name}`,
                  title: 'Remove',
                  'data-focus-key': `remove:${index}`,
                  'data-testid': 'contender-remove',
                  onclick: () => removeContender(index),
                },
                icon('x-lg'),
              )
            : null,
        );
      }),
    );
    addButton.hidden = count >= MAX_CONTENDERS;
    overrideArea.replaceChildren(
      overrideNote && form.models[overrideNote.slot] === overrideNote.model
        ? h(
            'div',
            {
              class: 'alert alert-info d-flex gap-2 align-items-start py-2 mb-0 small',
              'data-testid': 'arena-override-note',
            },
            icon('info-circle'),
            `Contender ${overrideNote.slot + 1} is ${naming.name(overrideNote.model)}, from the link you opened.`,
          )
        : '',
    );
  }

  const renderFiles = (): void => {
    replace(
      fileList,
      files.map((ref) => {
        const data = session.get(ref.id);
        return attachmentChip({
          ref,
          ...(data ? { data } : {}),
          testId: 'arena-file-chip',
          remove: {
            focusKey: `unattach:${ref.id}`,
            testId: 'arena-file-remove',
            onClick: () => {
              files = files.filter((other) => other.id !== ref.id);
              releaseUnused();
              renderFiles();
              renderContenders();
              promptInput.focus();
              void ui.refreshEstimate();
            },
          },
        });
      }),
    );
  };

  const renderForm = (): void => {
    blindSwitch.input.checked = form.blind;
    systemArea.value = form.system;
    temperatureInput.value = form.temperature === null ? '' : String(form.temperature);
    maxTokensInput.value = form.maxTokens === null ? '' : String(form.maxTokens);
    engineSelect.value = form.pdfEngine;
    renderEngineHint();
    renderContenders();
  };

  const refreshSoon = debounce(() => {
    renderContenders();
    void ui.refreshEstimate();
  }, 300);
  promptInput.addEventListener('input', refreshSoon);

  /** Keeps the bytes of files the form or the round on screen still refers to. */
  function releaseUnused(): void {
    const used = new Set([...files, ...(live?.files ?? [])].map((ref) => ref.id));
    for (const id of session.keys()) if (!used.has(id)) session.delete(id);
  }

  // --- round rendering ----------------------------------------------------------------------------------
  const renderVote = (): void => {
    if (!live) return;
    const round = live.round;
    voteArea.hidden = false;
    replaceWith(
      voteArea,
      voteBar(round, naming, {
        winner: (panel) => void vote({ kind: 'winner', panel }),
        tie: () => void vote({ kind: 'tie' }),
        bad: () => void vote({ kind: 'bad' }),
        reveal: () => revealRound(),
      }),
      { fallback: () => voteArea.querySelector<HTMLElement>('[data-focus-key="vote:result"]') },
    );
  };

  const renderRound = (): void => {
    if (!live) return;
    const round = live.round;
    for (const panel of live.panels) panel.update();
    roundTitle.textContent = `Round of ${plural(round.entries.length, 'model')}${round.settings.blind ? ' · blind' : ''}`;
    menu.update({ disabled: !exportReady(round) });
    exportHint.textContent = exportReady(round)
      ? ''
      : round.revealed
        ? 'Export when every answer is in'
        : 'Vote or reveal to export';
    compareView.update(round);
    renderVote();
  };

  const renderTally = (): void => {
    resetButton.hidden = isEmptyTally(tally);
    tallyTableView.update(tally);
  };

  /** Puts a new round on screen: its panels in panel order. */
  function showRound(round: Round, roundFiles: AttachmentRef[]): void {
    const previous = live;
    const panels = round.order.map((_, panel) =>
      panelView({ round, panel, naming, retryButton: retryButtonFor }),
    );
    live = { round, files: roundFiles, panels };
    if (previous) releaseUnused();
    empty.hidden = true;
    roundHeader.hidden = false;
    panelGrid.hidden = false;
    compareArea.hidden = false;
    replace(
      panelGrid,
      panels.map((panel) => h('div', { class: 'col' }, panel.element)),
    );
    // Contenders refused before the round (a budget block, say) show why, with Retry.
    round.order.forEach((index, panel) => {
      if (round.entries[index]!.status === 'error') void panels[panel]!.end();
    });
    renderRound();
  }

  // --- runs -----------------------------------------------------------------------------------------------
  /**
   * The cost from the run's totals; the token counts only from the stream's own usage chunk (`wire`): without
   * one (a stopped or cut stream) the client books zeros, which are unknown here, not 0.
   */
  const usageOf = (totals: UsageTotals, wire: WireUsage | null): EntryUsage | undefined => {
    if (totals.requests === 0 && !wire) return undefined;
    const count = (value: unknown): number | null => (isFiniteNumber(value) ? value : null);
    const reasoning = wire?.completion_tokens_details?.reasoning_tokens;
    return {
      promptTokens: count(wire?.prompt_tokens),
      completionTokens: count(wire?.completion_tokens),
      ...(isFiniteNumber(reasoning) ? { reasoningTokens: reasoning } : {}),
      costUsd: totals.costUsd,
      costEstimated: totals.costEstimated,
      costUnknown: totals.costUnknown,
    };
  };

  /** Plans `models` on `source` (the form, or a round's own input); throws what refuses it before anything. */
  async function plan(models: readonly string[], source: ArenaInput): Promise<Planned[]> {
    const problems: string[] = [];
    const paid: string[] = [];
    const promptTokens = inputTokens(source);
    const planned = models.map((model): Planned => {
      const info = catalog.get(model);
      const request = contenderRequest(model, info, source, promptTokens);
      const name = naming.name(model);
      const missing = info
        ? missingInput(source.attachments, info.inputModalities, source.pdfEngine, (id) =>
            session.has(id),
          )
        : null;
      if (missing) problems.push(`${name} ${MISSING_INPUT[missing]}.`);
      else if (request.tooLong) {
        problems.push(`The prompt and files are too long for ${name}'s context window.`);
      }
      if (!ctx.models.isFree(model)) paid.push(model);
      return {
        model,
        request,
        estimate: null,
        addons: parserAddons(source.pdfEngine, request.parses),
      };
    });
    if (problems.length > 0) {
      throw new InvalidInputError(
        `${problems.join(' ')} Choose another model or remove the file that model cannot read.`,
      );
    }
    // Free-only mode checks every contender (and the PDF reader) before any of them starts.
    const extras = [...new Set(planned.flatMap((p) => paidAddons(p.addons).map((a) => a.label)))];
    if (ctx.settings.get().freeOnly && (paid.length > 0 || extras.length > 0)) {
      throw new FreeOnlyError([...new Set(paid)], extras);
    }
    await Promise.all(
      planned.map(async (p) => {
        p.estimate = await ctx.models
          .estimate({
            kind: 'tokens',
            model: p.model,
            promptTokens: p.request.promptTokens,
            completionTokens: p.request.completionTokens,
          })
          .catch(() => null);
      }),
    );
    return planned;
  }

  /** Streams one contender into its panel; never throws (the entry and the panel show the outcome). */
  async function stream(
    round: Round,
    index: number,
    run: RunHandle,
    planned: Planned,
  ): Promise<void> {
    const entry = round.entries[index]!;
    const panel = live?.round === round ? live.panels[panelOf(round, index)] : undefined;
    Object.assign(entry, {
      status: 'streaming',
      text: '',
      thinking: false,
      reasoned: false,
      runId: run.id,
    } satisfies Partial<Entry>);
    delete entry.error;
    delete entry.outcomeUnknown;
    delete entry.firstTokenAt;
    delete entry.endedAt;
    delete entry.usage;
    delete entry.servedModel;
    delete entry.finishReason;
    const md = panel?.begin();
    /** The stream's usage chunk, when one arrives. */
    const seen: { usage: WireUsage | null } = { usage: null };
    entry.startedAt = now();
    panel?.update();
    try {
      const answer = await ctx.api.chatStream(planned.request.body, {
        run,
        onEvent: (event) => {
          if (event.type === 'text' && event.text) {
            entry.firstTokenAt ??= now();
            const first = !entry.text;
            entry.text += event.text;
            md?.append(event.text);
            if (first) panel?.update();
          } else if (event.type === 'reasoning' && event.text) {
            entry.firstTokenAt ??= now();
            entry.reasoned = true;
            if (!entry.thinking && !entry.text) {
              entry.thinking = true;
              panel?.update();
            }
          } else if (event.type === 'usage') {
            seen.usage = event.usage;
          } else if (event.type === 'meta' && event.model && event.model !== entry.model) {
            entry.servedModel = event.model;
          }
        },
      });
      entry.endedAt = now();
      // The parser's text rides on the file references (the form's and the round's alike): later rounds and
      // retries send it as text instead of the PDF.
      keepParsed(planned.request.parses, answer.annotations);
      if (answer.text && answer.text !== entry.text) {
        entry.text = answer.text;
        md?.set(answer.text);
      }
      entry.finishReason = answer.finishReason;
      entry.status = 'done';
      entry.usage = usageOf(run.totals, seen.usage ?? answer.usage);
      // The answer is in; a failure to record it is shown, but does not turn it into a failed answer. No panel
      // letter goes to History: it would tell which model a blind panel was before the vote.
      await run.finish({ output: entry.text }).catch((error: unknown) => void presentError(error));
    } catch (error) {
      entry.endedAt ??= now();
      const usage = usageOf(run.totals, seen.usage);
      if (usage) entry.usage = usage;
      if (isStop(error)) {
        entry.status = 'stopped';
      } else {
        entry.status = 'error';
        entry.error = userMessage(error);
        if (isOutcomeUnknown(error)) entry.outcomeUnknown = true;
        // A key, a lock or a budget: the dialog helps, and then this contender runs again.
        if (needsAction(error)) {
          void presentError(error, {
            retry: () => void retryGateRef.retry({ kind: 'retry', index }),
          });
        }
      }
      markPresented(error);
      await run.fail(error).catch(() => undefined);
    } finally {
      await panel?.end();
      if (live?.round === round) renderRound();
    }
  }

  function roundStatus(round: Round, stopped: boolean): string {
    const answered = round.entries.filter(hasAnswer).length;
    const failed = round.entries.filter((entry) => entry.status === 'error').length;
    if (stopped) return 'Stopped. Partial answers are kept.';
    const parts = [
      `Round complete: ${answered} of ${round.entries.length} answered`,
      failed > 0 ? `, ${failed} failed.` : '.',
    ];
    if (canVote(round)) {
      parts.push(
        round.settings.blind
          ? ' Vote for the best answer to see the names.'
          : ' Vote for the best.',
      );
    }
    return parts.join('');
  }

  async function startRound(signal: AbortSignal): Promise<void> {
    // The round is what the form says now: planning and a budget dialog take time, and a file dropped or a
    // setting changed meanwhile belongs to the next round, not to this one (or its Retry).
    const source = input();
    const settings: ArenaSettings = { ...form, models: [...form.models] };
    const snapshot = getState();
    const roundFiles = [...source.attachments];
    if (!source.prompt && roundFiles.length === 0) {
      ui.status('Write a prompt or attach a file first.');
      promptInput.focus();
      return;
    }
    const models = settings.models;
    const planned = await plan(models, source);
    const id = crypto.randomUUID();
    // Every contender's run is begun before any request goes out: one budget dialog for the group, and a round
    // refused as a whole changes nothing on the page.
    const begun = await Promise.allSettled(
      planned.map((p) =>
        ctx.beginRun(
          {
            model: p.model,
            estimateUsd: p.estimate,
            addons: p.addons,
            prompt: snapshot.prompt,
            settings: snapshot.settings,
            groupId: id,
          },
          signal,
        ),
      ),
    );
    const runs = begun.map((result) => (result.status === 'fulfilled' ? result.value : null));
    if (runs.every((run) => run === null)) {
      throw (begun[0] as PromiseRejectedResult).reason;
    }

    const round = newRound({
      id,
      prompt: source.prompt,
      settings,
      attachments: roundFiles,
      startedAt: Date.now(),
    });
    begun.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      const entry = round.entries[index]!;
      entry.status = 'error';
      entry.error = isStop(result.reason)
        ? 'Not run: the budget confirmation was cancelled.'
        : userMessage(result.reason);
    });
    showRound(round, roundFiles);
    const refused = begun.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected' && needsAction(result.reason),
    );
    if (refused) void presentError(refused.reason);
    ui.status(
      round.settings.blind
        ? `Comparing ${plural(models.length, 'model')}, shown as Model A to ${panelLetter(models.length - 1)}.`
        : `Comparing ${models.map(naming.name).join(', ')}.`,
    );

    let settled = 0;
    const total = runs.filter(Boolean).length;
    await Promise.all(
      runs.map(async (run, index) => {
        if (!run) return;
        await stream(round, index, run, planned[index]!);
        settled++;
        if (settled < total) ui.progress(`${settled} of ${total} answers in`);
      }),
    );
    ui.status(roundStatus(round, signal.aborted));
  }

  async function retryContender(index: number, signal: AbortSignal): Promise<void> {
    const current = live;
    const entry = current?.round.entries[index];
    if (!current || !entry || (entry.status !== 'error' && entry.status !== 'stopped')) return;
    const round = current.round;
    const source: ArenaInput = {
      prompt: round.prompt,
      system: round.settings.system,
      temperature: round.settings.temperature,
      maxTokens: round.settings.maxTokens,
      pdfEngine: round.settings.pdfEngine,
      attachments: current.files,
      data: (id) => session.get(id),
    };
    // From the press until it settles (planning and a budget dialog included) the round takes no vote and no
    // export: the panel is about to change, and a vote now would reveal the names before it streams.
    round.retrying = index;
    renderRound();
    try {
      const [planned] = await plan([entry.model], source);
      const run = await ctx.beginRun(
        {
          model: planned!.model,
          estimateUsd: planned!.estimate,
          addons: planned!.addons,
          prompt: round.prompt,
          settings: { ...round.settings, models: [...round.settings.models] },
          groupId: round.id,
        },
        signal,
      );
      const label = panelLabel(panelOf(round, index));
      ui.status(`Running ${label} again.`);
      await stream(round, index, run, planned!);
      const after = round.entries[index]!;
      delete round.retrying;
      ui.status(
        signal.aborted
          ? 'Stopped. The partial answer is kept.'
          : after.status === 'done'
            ? `${label} answered.${canVote(round) ? ' Voting is open.' : ''}`
            : `${label} failed again.`,
      );
    } finally {
      delete round.retrying;
      if (live?.round === round) renderRound();
    }
  }

  const runner = ui.runner<RunArg>({
    label: 'Compare',
    icon: 'play-fill',
    run: (signal, arg) =>
      arg?.kind === 'retry' ? retryContender(arg.index, signal) : startRound(signal),
  });
  /** The answer region of the contender last retried: where focus goes when its Retry button disappears. */
  let retried: HTMLElement | null = null;
  const retryGateRef = retryGate(runner, { fallback: () => retried });
  /** A Retry button for contender `index` of the round on screen, in step with the runner (`retryGate`). */
  const retryButtonFor = (index: number): HTMLElement =>
    retryGateRef.bind(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1',
          'data-testid': 'panel-retry',
          onclick: () => {
            const round = live?.round;
            retried = round ? (live?.panels[panelOf(round, index)]?.answer ?? null) : null;
            retryGateRef.retry({ kind: 'retry', index }, 'Retry cannot start now.');
          },
        },
        icon('arrow-clockwise'),
        'Retry',
      ),
    );

  // --- votes and the tally ------------------------------------------------------------------------------
  /** Read-modify-write of the stored tally, under a lock shared by every tab. */
  async function changeTally(change: (stored: Tally) => Tally): Promise<Tally> {
    const work = async (): Promise<Tally> => {
      const next = change(parseTally(await ctx.state.get(STATE_TALLY)));
      await ctx.state.set(STATE_TALLY, next);
      return next;
    };
    const locks = webLocks();
    return locks ? locks.request(TALLY_LOCK, work) : work();
  }

  const loadTally = async (): Promise<void> => {
    try {
      tally = parseTally(await ctx.state.get(STATE_TALLY));
    } catch (error) {
      void presentError(error);
    }
    renderTally();
  };

  async function vote(choice: Vote): Promise<void> {
    const round = live?.round;
    if (!round || !castVote(round, choice)) return;
    renderRound();
    ui.status(
      choice.kind === 'winner'
        ? `You picked ${panelLabel(choice.panel)}: ${naming.name(round.entries[round.order[choice.panel]!]!.model)}. Names are shown.`
        : choice.kind === 'tie'
          ? 'Tie recorded. Names are shown.'
          : '“All bad” recorded. Names are shown.',
    );
    try {
      tally = await changeTally((stored) => addVote(stored, round, choice));
      renderTally();
    } catch (error) {
      void presentError(error);
    }
  }

  function revealRound(): void {
    const round = live?.round;
    if (!round || round.revealed) return;
    reveal(round);
    renderRound();
    ui.status('Names revealed. This round takes no vote.');
  }

  async function resetTally(): Promise<void> {
    const before = tally;
    if (isEmptyTally(before)) return;
    try {
      tally = await changeTally(() => emptyTally());
    } catch (error) {
      void presentError(error);
      return;
    }
    renderTally();
    // Reset is hidden with nothing to reset: focus lands on the section's heading instead of the page.
    tallyTitle.focus();
    toast({
      variant: 'info',
      message: 'Vote tally reset.',
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          void changeTally((stored) => mergeTallies(before, stored))
            .then((restored) => {
              tally = restored;
              renderTally();
              announce('Vote tally restored.');
            })
            .catch((error: unknown) => void presentError(error));
        },
      },
      testId: 'tally-reset-toast',
    });
  }

  // --- contenders -------------------------------------------------------------------------------------------
  const pickModel = (title: string, selected: string | null): Promise<string | null> =>
    modelPicker(ctx, { capability: 'text', selected, title });

  const contendersChanged = (): void => {
    saveForm();
    renderContenders();
    void ui.refreshEstimate();
  };

  async function changeContender(index: number): Promise<void> {
    const chosen = await pickModel(`Choose contender ${index + 1}`, form.models[index] ?? null);
    if (!chosen || form.models[index] === chosen) return;
    form.models[index] = chosen;
    contendersChanged();
    announce(`Contender ${index + 1} is now ${naming.name(chosen)}.`);
  }

  async function addContender(): Promise<void> {
    if (form.models.length >= MAX_CONTENDERS) return;
    const chosen = await pickModel(`Add contender ${form.models.length + 1}`, null);
    if (!chosen || form.models.length >= MAX_CONTENDERS) return;
    form.models = [...form.models, chosen];
    contendersChanged();
    focusKey(contenderList, `change:${form.models.length - 1}`);
    announce(`${naming.name(chosen)} added as contender ${form.models.length}.`);
  }

  function removeContender(index: number): void {
    if (form.models.length <= MIN_CONTENDERS) return;
    const [removed] = form.models.splice(index, 1);
    if (overrideNote && overrideNote.slot >= index) overrideNote = null;
    contendersChanged();
    announce(
      `${naming.name(removed ?? '')} removed. ${plural(form.models.length, 'contender')} left.`,
    );
  }

  // --- files --------------------------------------------------------------------------------------------
  function attach(ref: AttachmentRef, data?: string): void {
    if (files.length >= MAX_ATTACHMENTS) {
      throw new InvalidInputError(`At most ${MAX_ATTACHMENTS} files go with one prompt.`);
    }
    if (ref.kind === 'text') checkText(files, ref.name, ref.size);
    if (data) session.set(ref.id, data);
    files = [...files, ref];
  }

  async function addFiles(list: File[]): Promise<void> {
    const problems: string[] = [];
    let added = 0;
    for (const file of list) {
      try {
        if (files.length >= MAX_ATTACHMENTS) {
          throw new InvalidInputError(`At most ${MAX_ATTACHMENTS} files go with one prompt.`);
        }
        const { ref, data } = await readAttachment(file);
        attach(ref, data);
        added++;
      } catch (error) {
        problems.push(userMessage(error));
      }
    }
    renderFiles();
    renderContenders();
    void ui.refreshEstimate();
    if (problems.length > 0) {
      toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
    } else if (added > 0) announce(`${plural(added, 'file')} attached.`);
  }

  // --- live updates ---------------------------------------------------------------------------------------
  const loadCatalog = (): void => {
    ctx.models
      .list()
      .then((list) => {
        fillCatalog(list);
        renderContenders();
        renderTally();
        if (live) renderRound();
        void ui.refreshEstimate();
      })
      .catch(() => undefined);
  };
  ctx.bus.on('models-refreshed', loadCatalog);
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool === ctx.manifest.id && event.key === STATE_TALLY) void loadTally();
  });
  ctx.settings.subscribe((next, prev) => {
    if (next.freeOnly !== prev.freeOnly) {
      renderContenders();
      void ui.refreshEstimate();
    }
  });

  // --- state ----------------------------------------------------------------------------------------------
  function getState(): ToolSnapshot {
    return {
      prompt: promptInput.value,
      settings: {
        models: [...form.models],
        system: form.system,
        temperature: form.temperature,
        maxTokens: form.maxTokens,
        blind: form.blind,
        pdfEngine: form.pdfEngine,
      },
    };
  }

  function applyState({ prompt, settings }: ToolSnapshot): void {
    promptInput.value = prompt;
    form = settingsFrom(settings, form);
    if (pendingOverride) applyOverride();
    saveForm();
    renderForm();
    void ui.refreshEstimate();
  }

  renderForm();
  renderFiles();
  renderTally();
  void loadTally();
  loadCatalog();

  return {
    getState,
    applyState,
    // The sum over the contenders, each on its own request (context limits and output caps differ).
    estimate: async () => {
      // The prompt counts the same for every contender: once, then each model's own limits.
      const promptTokens = inputTokens(input());
      const costs = await Promise.all(
        form.models.map((model) =>
          ctx.models
            .estimate({
              kind: 'tokens',
              model,
              promptTokens,
              completionTokens: fitOutput(promptTokens, catalog.get(model), form.maxTokens)
                .completionTokens,
            })
            .catch(() => null),
        ),
      );
      return costs.some((cost) => cost === null)
        ? null
        : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
    },
    // Every contender's request sends unread PDFs to the parser, so a paid reader is charged once per contender.
    addons: () => {
      if (form.pdfEngine === 'native') return [];
      const unread = files.filter((ref) => needsParser(ref, (id) => session.get(id)));
      return form.models.flatMap(() => parserAddons(form.pdfEngine, unread));
    },
    onFiles: (list) => void addFiles(list),
    onReceive: (items: SendItem[]) => {
      const list: File[] = [];
      const problems: string[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          list.push(new File([item.blob], item.name, { type: item.blob.type }));
          continue;
        }
        try {
          if (item.name) attach(textAttachment(item.name, item.text, item.type));
          else {
            const size = new Blob([item.text]).size;
            if (size > SIZE_LIMITS.text) {
              throw new InvalidInputError(
                `The text sent here is ${formatBytes(size)}. A prompt takes at most ${formatBytes(SIZE_LIMITS.text)} of typed text; send it as a file instead.`,
              );
            }
            promptInput.value = [promptInput.value, item.text].filter(Boolean).join('\n\n');
          }
        } catch (error) {
          problems.push(userMessage(error));
        }
      }
      renderFiles();
      if (problems.length > 0) {
        toast({ variant: 'warning', message: problems.join(' '), testId: 'attach-error' });
      }
      void addFiles(list);
    },
    sample: () => {
      promptInput.value = SAMPLE_PROMPT;
      renderContenders();
      void ui.refreshEstimate();
    },
  };
}
