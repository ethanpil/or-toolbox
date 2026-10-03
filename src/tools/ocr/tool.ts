/**
 * OCR: images and PDFs to Markdown. Every selected page goes to the vision model on its own (up to three at a
 * time), streaming its text into a per-page list and a combined document; a page that fails can be retried on
 * its own, and Stop ends the rest. PDFs can instead go whole through OpenRouter's PDF parser. One run covers
 * one Run press (its output is the combined text, checkpointed as pages finish).
 */
import type { ChatRequest } from '../../core/api/types';
import { InvalidInputError, userMessage } from '../../core/errors';
import { readAsDataUrl } from '../../core/files';
import {
  isPdfEngineId,
  PDF_ENGINES,
  type PdfEngineId,
  pdfEngine,
  pdfEngineAddon,
} from '../../core/models/pdf-engines';
import type { RunAddon, RunHandle } from '../../core/types';
import { documentInput, textImage, type PageRef } from '../../ui/components/document-input';
import { outputPanel } from '../../ui/components/output-panel';
import { focusedKey, focusKey, h, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop } from '../../ui/feedback/errors';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { batchSummary, batchTitle, runItems } from '../../ui/tool/batch';
import type { RunnerState, ToolContext, ToolInstance } from '../../ui/tool/index';
import {
  combineMarkdown,
  combinePlainText,
  estimateTokens,
  OCR_MODES,
  type OcrMode,
  type PageResult,
  pageLabel,
  pageRequest,
  pdfRequest,
  readMode,
} from './ocr';

interface Unit {
  key: string;
  kind: 'page' | 'pdf';
  ref: PageRef;
}

const IMAGE_SIZES = [1024, 1600, 2048] as const;
const DEFAULT_SIZE = 1600;
const CONCURRENCY = [1, 2, 3] as const;
const DEFAULT_CONCURRENCY = 3;

const STATUS_TEXT: Record<PageResult['status'], string> = {
  queued: 'Waiting',
  running: 'Reading…',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Not read',
};
const STATUS_BADGE: Record<PageResult['status'], string> = {
  queued: 'text-bg-secondary',
  running: 'text-bg-info',
  done: 'text-bg-success',
  failed: 'text-bg-danger',
  stopped: 'text-bg-secondary',
};

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const saved = ctx.options.get();
  const ids = {
    mode: uid('ocr-mode'),
    modeHint: uid('ocr-mode-hint'),
    prompt: uid('ocr-prompt'),
    language: uid('ocr-language'),
    separators: uid('ocr-separators'),
    textHint: uid('ocr-text-hint'),
    parser: uid('ocr-parser'),
    engine: uid('ocr-engine'),
    engineHint: uid('ocr-engine-hint'),
    size: uid('ocr-size'),
    concurrency: uid('ocr-concurrency'),
  };

  // --- input zone -----------------------------------------------------------------------------------------
  const docs = documentInput({
    accept: ctx.manifest.accepts,
    maxSide: () => Number(size.value) || DEFAULT_SIZE,
    onChange: () => void ui.refreshEstimate(),
  });

  const mode = h(
    'select',
    {
      id: ids.mode,
      class: 'form-select',
      'aria-describedby': ids.modeHint,
      'data-testid': 'ocr-mode',
      onchange: () => {
        modeHint.textContent = OCR_MODES.find((entry) => entry.id === mode.value)?.hint ?? '';
        ctx.options.set({ mode: mode.value });
      },
    },
    OCR_MODES.map((entry) => h('option', { value: entry.id }, entry.label)),
  );
  mode.value = readMode(saved['mode']);
  const modeHint = h(
    'div',
    { id: ids.modeHint, class: 'form-text' },
    OCR_MODES.find((entry) => entry.id === mode.value)?.hint ?? '',
  );

  const prompt = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 2,
    placeholder: 'For example: skip the page headers, or keep line breaks',
    'data-testid': 'tool-prompt',
  });

  ui.input.append(
    docs.element,
    h(
      'div',
      null,
      h('label', { class: 'form-label fw-semibold', htmlFor: ids.mode }, 'Mode'),
      mode,
      modeHint,
    ),
    h(
      'div',
      null,
      h(
        'label',
        { class: 'form-label fw-semibold', htmlFor: ids.prompt },
        'Extra instructions (optional)',
      ),
      prompt,
    ),
  );

  // --- drawer ---------------------------------------------------------------------------------------------
  const language = h('input', {
    id: ids.language,
    type: 'text',
    class: 'form-control',
    placeholder: 'Detect automatically',
    autocomplete: 'off',
    'data-testid': 'ocr-language',
    onchange: () => ctx.options.set({ language: language.value.trim() }),
  });
  language.value = typeof saved['language'] === 'string' ? saved['language'] : '';

  const checkbox = (
    id: string,
    checked: boolean,
    testId: string,
    key: string,
  ): HTMLInputElement => {
    const input = h('input', {
      id,
      type: 'checkbox',
      class: 'form-check-input',
      checked,
      'data-testid': testId,
      onchange: () => {
        ctx.options.set({ [key]: input.checked });
        if (key === 'pdfParser') {
          engine.disabled = !input.checked;
          void ui.refreshEstimate();
        }
        if (key === 'separators') refreshCombined();
        if (key === 'textHint') void ui.refreshEstimate();
      },
    });
    return input;
  };
  const separators = checkbox(
    ids.separators,
    saved['separators'] !== false,
    'ocr-separators',
    'separators',
  );
  const textHint = checkbox(ids.textHint, saved['textHint'] !== false, 'ocr-text-hint', 'textHint');
  const pdfParser = checkbox(
    ids.parser,
    saved['pdfParser'] === true,
    'ocr-pdf-parser',
    'pdfParser',
  );

  const engine = h(
    'select',
    {
      id: ids.engine,
      class: 'form-select',
      'aria-describedby': ids.engineHint,
      disabled: !pdfParser.checked,
      'data-testid': 'ocr-engine',
      onchange: () => {
        ctx.options.set({ engine: engine.value });
        engineHint.textContent = pdfEngine(engine.value as PdfEngineId).hint;
        void ui.refreshEstimate();
      },
    },
    PDF_ENGINES.map((entry) => h('option', { value: entry.id }, entry.label)),
  );
  engine.value = isPdfEngineId(saved['engine']) ? saved['engine'] : 'cloudflare-ai';
  const engineHint = h(
    'div',
    { id: ids.engineHint, class: 'form-text' },
    pdfEngine(engine.value as PdfEngineId).hint,
  );

  const formCheck = (
    input: HTMLInputElement,
    label: string,
    help: string,
    isSwitch = false,
  ): HTMLElement =>
    h(
      'div',
      { class: ['form-check', isSwitch && 'form-switch'] },
      input,
      h('label', { class: 'form-check-label', htmlFor: input.id }, label),
      h('div', { class: 'form-text mt-0' }, help),
    );

  ui.drawer.append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.language }, 'Language hint'),
      language,
      h(
        'div',
        { class: 'form-text' },
        'The main language of the pages, if you know it (for example German).',
      ),
    ),
    formCheck(
      separators,
      'Page separators',
      'Start every page with a line naming it in the combined text.',
    ),
    formCheck(
      textHint,
      "Send the PDF's own text along",
      'Where a PDF page carries text, the model gets it as a hint for spelling and numbers.',
    ),
    h(
      'fieldset',
      { class: 'vstack gap-2' },
      h('legend', { class: 'form-label fs-6 mb-1' }, 'PDF parser'),
      formCheck(
        pdfParser,
        "Use OpenRouter's PDF parser instead",
        'Sends each PDF whole (the page selection is ignored) for a text PDF. Images still go page by page.',
        true,
      ),
      h('label', { class: 'form-label mb-0', htmlFor: ids.engine }, 'Parser'),
      engine,
      engineHint,
    ),
  );

  const size = h(
    'select',
    {
      id: ids.size,
      class: 'form-select',
      'data-testid': 'ocr-size',
      onchange: () => {
        ctx.options.set({ maxSide: Number(size.value) });
        void ui.refreshEstimate();
      },
    },
    IMAGE_SIZES.map((value) => h('option', { value: String(value) }, `${value} px`)),
  );
  size.value = String(
    IMAGE_SIZES.includes(saved['maxSide'] as (typeof IMAGE_SIZES)[number])
      ? saved['maxSide']
      : DEFAULT_SIZE,
  );
  const concurrency = h(
    'select',
    {
      id: ids.concurrency,
      class: 'form-select',
      'data-testid': 'ocr-concurrency',
      onchange: () => ctx.options.set({ concurrency: Number(concurrency.value) }),
    },
    CONCURRENCY.map((value) => h('option', { value: String(value) }, plural(value, 'page'))),
  );
  concurrency.value = String(
    CONCURRENCY.includes(saved['concurrency'] as (typeof CONCURRENCY)[number])
      ? saved['concurrency']
      : DEFAULT_CONCURRENCY,
  );
  ui.advanced('Images and speed').append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.size }, 'Page image size (longest side)'),
      size,
      h(
        'div',
        { class: 'form-text' },
        'Larger reads small print better and costs more input tokens.',
      ),
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.concurrency }, 'Pages read at the same time'),
      concurrency,
    ),
  );

  // --- output zone ----------------------------------------------------------------------------------------
  let results: PageResult[] = [];
  let units: Unit[] = [];
  const openTexts = new Set<string>();
  const textElements = new Map<string, HTMLElement>();
  const pageItems = new Map<string, HTMLElement>();

  const stem = (): string => {
    const first = results[0]?.fileName ?? docs.files()[0]?.name;
    return first ? `${first.replace(/\.[^.]+$/, '')}-ocr` : 'ocr';
  };
  const combined = (): string => combineMarkdown(results, separators.checked);
  const output = outputPanel({
    format: 'markdown',
    filename: stem,
    sendTo: ui.sendTo,
    label: 'Combined text',
    empty: {
      icon: 'file-earmark-text',
      title: 'No text yet',
      text: 'Add images or a PDF and press Read.',
    },
    formats: [
      {
        label: 'Markdown',
        extension: 'md',
        icon: 'markdown',
        build: () => new Blob([combined()], { type: 'text/markdown' }),
      },
      {
        label: 'Plain text',
        extension: 'txt',
        icon: 'file-earmark-text',
        build: () => new Blob([combinePlainText(results)], { type: 'text/plain' }),
      },
      {
        label: 'Word document',
        extension: 'docx',
        icon: 'file-earmark-word',
        build: async () => (await import('../../core/export/docx')).toDocx(combined()),
      },
    ],
  });

  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': 'Pages read',
      'aria-valuemin': '0',
      'aria-valuemax': '0',
      'aria-valuenow': '0',
      hidden: true,
      'data-testid': 'ocr-progress',
    },
    progressBar,
  );

  const pagesList = h('ol', {
    class: 'list-unstyled vstack gap-2 mb-0',
    'data-testid': 'ocr-pages',
  });
  const failedNotice = h('div', { hidden: true, 'data-testid': 'ocr-failed' });
  const combinedPanel = h('div', { 'data-testid': 'ocr-combined' }, output.element);
  const pagesPanel = h('div', { hidden: true, 'data-testid': 'ocr-pages-panel' }, pagesList);

  const viewButton = (label: string, view: 'combined' | 'pages'): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary',
        'aria-pressed': String(view === 'combined'),
        'data-testid': `ocr-view-${view}`,
        onclick: () => showView(view),
      },
      label,
    );
  const combinedButton = viewButton('Combined', 'combined');
  const pagesButton = viewButton('By page', 'pages');
  const showView = (view: 'combined' | 'pages'): void => {
    combinedPanel.hidden = view !== 'combined';
    pagesPanel.hidden = view !== 'pages';
    combinedButton.setAttribute('aria-pressed', String(view === 'combined'));
    pagesButton.setAttribute('aria-pressed', String(view === 'pages'));
  };

  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h(
          'div',
          { class: 'btn-group', role: 'group', 'aria-label': 'View' },
          combinedButton,
          pagesButton,
        ),
        h('div', { class: 'flex-grow-1' }, progress),
      ),
      failedNotice,
      combinedPanel,
      pagesPanel,
    ),
  );

  // --- rendering ------------------------------------------------------------------------------------------
  let combinedTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshCombined = (): void => {
    if (combinedTimer) clearTimeout(combinedTimer);
    combinedTimer = null;
    if (results.length > 0) output.setText(combined());
  };
  const scheduleCombined = (): void => {
    combinedTimer ??= setTimeout(refreshCombined, 250);
  };

  /** The runner's state, kept by `runner.subscribe`: Retry buttons follow it. */
  let runnerState: RunnerState = { busy: false, disabledReason: null };
  /** Why a Retry cannot start now (Run busy or disabled), or null. */
  const retryBlocked = (): string | null =>
    runnerState.busy ? 'Wait until the current run ends.' : runnerState.disabledReason;

  /** Shows a Retry button as available or not, with the reason; it stays focusable (aria-disabled). */
  const setRetryState = (button: HTMLElement): void => {
    const reason = retryBlocked();
    button.setAttribute('aria-disabled', String(reason !== null));
    button.classList.toggle('disabled', reason !== null);
    button.title = reason ?? '';
  };

  const retryButton = (
    attributes: Record<string, string>,
    keys: () => string[],
    ...children: (HTMLElement | string)[]
  ): HTMLButtonElement => {
    const button = h(
      'button',
      { type: 'button', ...attributes, 'data-retry': '', onclick: () => retry(keys()) },
      ...children,
    );
    setRetryState(button);
    return button;
  };

  const pageItem = (result: PageResult): HTMLElement => {
    const text = h('div', { class: 'or-page-text', 'data-testid': 'ocr-page-text' }, result.text);
    textElements.set(result.key, text);
    const details = h(
      'details',
      {
        // Open while the page streams in, so its text shows as it arrives.
        open: openTexts.has(result.key) || result.status === 'running',
        ontoggle: () => {
          if (details.open) openTexts.add(result.key);
          else openTexts.delete(result.key);
        },
      },
      h('summary', { class: 'small', 'data-focus-key': `summary:${result.key}` }, 'Text'),
      text,
    );
    const item = h(
      'li',
      {
        class: 'border rounded p-2 vstack gap-2',
        tabIndex: -1,
        'data-focus-key': `page:${result.key}`,
        'data-testid': 'ocr-page',
        dataset: { status: result.status, page: String(result.pageNumber), key: result.key },
      },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h('span', { class: 'fw-semibold me-auto text-break' }, pageLabel(result)),
        h(
          'span',
          { class: `badge ${STATUS_BADGE[result.status]}`, 'data-testid': 'ocr-page-status' },
          STATUS_TEXT[result.status],
        ),
        result.status === 'failed' || result.status === 'stopped'
          ? retryButton(
              {
                class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
                'aria-label': `Retry ${pageLabel(result)}`,
                'data-focus-key': `retry:${result.key}`,
                'data-testid': 'ocr-page-retry',
              },
              () => [result.key],
              icon('arrow-clockwise'),
              'Retry',
            )
          : null,
      ),
      result.error
        ? h('div', { class: 'small text-danger-emphasis', role: 'note' }, result.error)
        : null,
      result.truncated
        ? h(
            'div',
            { class: 'small text-warning-emphasis', role: 'note', 'data-testid': 'ocr-page-cut' },
            'The answer reached the length limit; the end of the page may be missing.',
          )
        : null,
      result.text || result.status === 'done' ? details : null,
    );
    pageItems.set(result.key, item);
    return item;
  };

  /** Redraws one page (streaming text, a new status) without touching the others. */
  const updatePage = (result: PageResult): void => {
    const old = pageItems.get(result.key);
    if (!old?.isConnected) {
      renderPages();
      return;
    }
    const key = focusedKey(old);
    const fresh = pageItem(result);
    old.replaceWith(fresh);
    // A Retry that started takes its button away: stay on that page.
    if (key && !focusKey(fresh, key)) fresh.focus();
  };

  const renderFailed = (): void => {
    const failed = results.filter(
      (result) => result.status === 'failed' || result.status === 'stopped',
    );
    failedNotice.hidden = failed.length === 0 || reading;
    replaceWith(
      failedNotice,
      failed.length === 0
        ? null
        : h(
            'div',
            { class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 mb-0' },
            icon('exclamation-triangle'),
            h('span', { class: 'me-auto' }, `${plural(failed.length, 'page')} not read.`),
            retryButton(
              {
                class: 'btn btn-sm btn-warning',
                'data-focus-key': 'retry-failed',
                'data-testid': 'ocr-retry-failed',
              },
              () => failed.map((result) => result.key),
              `Retry ${failed.length === 1 ? 'it' : 'them'}`,
            ),
          ),
      // "Retry them" hides while reading: keep focus on the view switch next to the progress bar.
      { fallback: () => pagesButton },
    );
  };

  const renderPages = (): void => {
    textElements.clear();
    pageItems.clear();
    // A Retry that started takes its button away: stay on that page.
    replaceWith(pagesList, results.map(pageItem), {
      fallback: (lost) =>
        lost.startsWith('retry:') ? pageItems.get(lost.slice('retry:'.length)) : undefined,
    });
    renderFailed();
  };

  const updateProgress = (): void => {
    const total = results.length;
    const finished = results.filter((result) => result.status === 'done').length;
    progress.hidden = total === 0;
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(finished));
    progressBar.style.width = total ? `${Math.round((finished / total) * 100)}%` : '0%';
    if (reading && total > 0) ui.status(`Read ${finished} of ${plural(total, 'page')}`);
  };

  // --- running --------------------------------------------------------------------------------------------
  const settings = () => ({
    mode: mode.value as OcrMode,
    language: language.value.trim(),
    separators: separators.checked,
    textHint: textHint.checked,
    pdfParser: pdfParser.checked,
    engine: engine.value as PdfEngineId,
    maxSide: Number(size.value),
    concurrency: Number(concurrency.value),
  });

  const planUnits = (): Unit[] => {
    const planned: Unit[] = [];
    const wholePdfs = new Set<string>();
    for (const ref of docs.selection()) {
      if (pdfParser.checked && ref.kind === 'pdf') {
        if (wholePdfs.has(ref.fileId)) continue;
        wholePdfs.add(ref.fileId);
        planned.push({ key: `${ref.fileId}:all`, kind: 'pdf', ref });
      } else {
        planned.push({ key: `${ref.fileId}:${ref.pageNumber}`, kind: 'page', ref });
      }
    }
    return planned;
  };

  /** Pages a plan reads (a whole PDF counts all its pages). */
  const pagesIn = (plan: readonly Unit[]): number =>
    plan.reduce((sum, unit) => sum + (unit.kind === 'pdf' ? unit.ref.pageCount : 1), 0);

  /** Pages a plan sends through the PDF parser (whole PDFs). */
  const parsedPagesIn = (plan: readonly Unit[]): number =>
    plan.reduce((sum, unit) => sum + (unit.kind === 'pdf' ? unit.ref.pageCount : 0), 0);

  /** The plan's model cost: page images at the chosen size (plus the PDF text hint) and parsed pages. */
  const estimatePlan = async (plan: readonly Unit[], model: string): Promise<number | null> => {
    if (plan.length === 0) return null;
    const s = settings();
    let imagePages = 0;
    let hintPages = 0;
    for (const unit of plan) {
      if (unit.kind === 'pdf') continue;
      imagePages += 1;
      if (s.textHint && unit.ref.kind === 'pdf') hintPages += 1;
    }
    return ctx.models.estimate({
      kind: 'tokens',
      model,
      ...estimateTokens({
        imagePages,
        hintPages,
        parsedPages: parsedPagesIn(plan),
        maxSide: s.maxSide,
      }),
    });
  };

  /** The parser's own charge for a plan (Mistral OCR bills per page, even with a free model). */
  const addonsFor = (plan: readonly Unit[]): RunAddon[] => {
    const addon = pdfEngineAddon(settings().engine, parsedPagesIn(plan));
    return addon ? [addon] : [];
  };

  const readUnit = async (
    run: RunHandle,
    unit: Unit,
    result: PageResult,
    signal: AbortSignal,
  ): Promise<void> => {
    const s = settings();
    const instructions = prompt.value;
    let body: ChatRequest;
    if (unit.kind === 'pdf') {
      const file = docs.file(unit.ref.fileId);
      if (!file) throw new InvalidInputError('That file was removed from the list.');
      body = pdfRequest(
        run.model,
        { fileName: unit.ref.fileName, dataUrl: await readAsDataUrl(file) },
        { ...s, instructions },
      );
    } else {
      const page = await docs.loadPage(unit.ref);
      body = pageRequest(run.model, page, { ...s, instructions });
    }
    signal.throwIfAborted();
    result.text = '';
    const answer = await ctx.api.chatStream(body, {
      run,
      onEvent: (event) => {
        if (event.type !== 'text') return;
        result.text += event.text;
        // Only this page changes: its text element if it is showing, else its row (the first text arrived).
        const element = textElements.get(result.key);
        if (element?.isConnected) element.textContent = result.text;
        else updatePage(result);
        scheduleCombined();
      },
    });
    result.text = answer.text;
    result.truncated = answer.finishReason === 'length';
  };

  /** True while a run reads pages (the runner's own flag is still set while its `run` returns). */
  let reading = false;

  /** Reads `keys` again (a Retry); the runner's own Retry after a refusal repeats the same pages. */
  const retry = (keys: string[]): void => {
    if (keys.length === 0) return;
    if (!runner.trigger(keys).started) announce(retryBlocked() ?? 'Reading cannot start now.');
  };

  const run = async (signal: AbortSignal, keys?: string[]): Promise<void> => {
    const plan = keys ? units.filter((unit) => keys.includes(unit.key)) : planUnits();
    if (plan.length === 0) {
      if (!keys) {
        ui.status(
          docs.files().length ? 'Choose at least one page.' : 'Add an image or a PDF first.',
        );
      }
      return;
    }

    const model = ctx.model().model;
    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): every page stays as it was.
    const runHandle = await ctx.beginRun(
      {
        title: batchTitle(
          plan.map((unit) => unit.ref.fileName),
          { retry: keys !== undefined },
        ),
        // A retry books only what it reads; a full run uses the header's estimate and add-ons.
        ...(keys
          ? {
              estimateUsd: model ? await estimatePlan(plan, model) : null,
              addons: addonsFor(plan),
            }
          : {}),
      },
      signal,
    );

    // The run is on: only now replace (or reset) what it reads.
    if (keys) {
      for (const result of results) {
        if (!keys.includes(result.key)) continue;
        result.status = 'queued';
        result.error = null;
        result.text = '';
        result.truncated = false;
      }
    } else {
      units = plan;
      openTexts.clear();
      results = plan.map((unit) => ({
        key: unit.key,
        fileId: unit.ref.fileId,
        fileName: unit.ref.fileName,
        pageNumber: unit.kind === 'pdf' ? 0 : unit.ref.pageNumber,
        pageCount: unit.ref.pageCount,
        status: 'queued',
        text: '',
        error: null,
        truncated: false,
      }));
    }
    reading = true;
    renderPages();
    updateProgress();
    output.start(
      keys
        ? `Retrying ${plural(plan.length, 'page')}…`
        : `Reading ${plural(pagesIn(plan), 'page')}…`,
    );
    if (keys) output.setText(combined());
    const resultOf = (unit: Unit): PageResult | undefined =>
      results.find((candidate) => candidate.key === unit.key);
    try {
      await runItems({
        items: plan,
        concurrency: Number(concurrency.value) || DEFAULT_CONCURRENCY,
        signal: runHandle.signal,
        work: async (unit, itemSignal) => {
          const result = resultOf(unit);
          if (result) await readUnit(runHandle, unit, result, itemSignal);
        },
        onItem: (outcome) => {
          const result = resultOf(outcome.item);
          if (!result) return;
          result.status = outcome.status;
          if (outcome.status === 'running') result.error = null;
          if (outcome.status === 'failed') result.error = userMessage(outcome.error);
          updatePage(result);
          updateProgress();
          if (outcome.status === 'running' || outcome.status === 'queued') return;
          scheduleCombined();
          void runHandle.checkpoint({ output: combined }).catch(() => undefined);
        },
      });
      refreshCombined();
      // The whole document, not just this run's pages (a retry reads a few).
      const done = results.filter((result) => result.status === 'done').length;
      const cut = results.filter((result) => result.status === 'done' && result.truncated).length;
      const summary = batchSummary({ done, failed: results.length - done, stopped: 0 }, 'page');
      output.finish(cut ? `${summary}; ${cut} cut off` : summary);
      ui.status(summary);
      await runHandle.finish({
        output: combined(),
        meta: {
          pages: results.length,
          failed: results
            .filter((result) => result.status !== 'done')
            .map((result) => pageLabel(result)),
          ...(cut
            ? {
                cutOff: results
                  .filter((result) => result.status === 'done' && result.truncated)
                  .map((result) => pageLabel(result)),
              }
            : {}),
        },
      });
    } catch (error) {
      refreshCombined();
      output.fail(error);
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await runHandle.fail(error);
      throw error;
    } finally {
      reading = false;
      renderPages();
      updateProgress();
    }
  };

  const runner = ui.runner<string[]>({ label: 'Read', icon: 'file-earmark-text', run });
  // Run turning busy, disabled or enabled (by this tool or the framework) updates the Retry buttons.
  runner.subscribe((state) => {
    runnerState = state;
    for (const button of ui.output.querySelectorAll<HTMLElement>('[data-retry]'))
      setRetryState(button);
  });
  renderPages();

  const applyState = ({
    prompt: text,
    settings: state,
  }: {
    prompt: string;
    settings: Record<string, unknown>;
  }): void => {
    prompt.value = text;
    if ('mode' in state) mode.value = readMode(state['mode']);
    modeHint.textContent = OCR_MODES.find((entry) => entry.id === mode.value)?.hint ?? '';
    if (typeof state['language'] === 'string') language.value = state['language'];
    if (typeof state['separators'] === 'boolean') separators.checked = state['separators'];
    if (typeof state['textHint'] === 'boolean') textHint.checked = state['textHint'];
    if (typeof state['pdfParser'] === 'boolean') pdfParser.checked = state['pdfParser'];
    if (isPdfEngineId(state['engine'])) engine.value = state['engine'];
    engine.disabled = !pdfParser.checked;
    engineHint.textContent = pdfEngine(engine.value as PdfEngineId).hint;
    if (IMAGE_SIZES.includes(state['maxSide'] as (typeof IMAGE_SIZES)[number]))
      size.value = String(state['maxSide']);
    if (CONCURRENCY.includes(state['concurrency'] as (typeof CONCURRENCY)[number])) {
      concurrency.value = String(state['concurrency']);
    }
    void ui.refreshEstimate();
  };

  return {
    getState: () => ({ prompt: prompt.value, settings: settings() }),
    applyState,
    estimate: (model) => estimatePlan(planUnits(), model),
    addons: () => (pdfParser.checked ? addonsFor(planUnits()) : []),
    onFiles: (files) => void docs.add(files),
    onReceive: (items) => {
      const files = items.flatMap((item) =>
        item.kind === 'file' ? [new File([item.blob], item.name, { type: item.blob.type })] : [],
      );
      if (files.length > 0) void docs.add(files);
    },
    sample: async () => {
      prompt.value = 'Keep the line breaks as they are.';
      mode.value = 'printed';
      modeHint.textContent = OCR_MODES[0]!.hint;
      const page = await textImage('sample-notes.png', 'Meeting notes, 3 October', [
        'Present: Ana, Ben, Chloe',
        '1. Budget for Q4 approved (EUR 12,500).',
        '2. Launch moved to 14 November.',
        '3. Ben sends the slides by Friday.',
      ]);
      if (page) await docs.add([page]);
      void ui.refreshEstimate();
    },
  };
}
