/**
 * Table extractor: finds the tables (and, optionally, charts as their data series) on the selected pages, one
 * structured request per page in a small pool, and shows each as an editable grid: cells, headers, rows and
 * columns, merging a table that continues on the next page, deleting one. Exports CSV (a ZIP for several),
 * an Excel workbook with a sheet per table, Markdown, and TSV for pasting into a spreadsheet. One run per
 * Run press; its output is the tables as Markdown.
 */
import type { ChatResponse } from '../../core/api/types';
import { InvalidInputError, isOutcomeUnknown, userMessage } from '../../core/errors';
import type { RunHandle } from '../../core/types';
import { copyText } from '../../ui/clipboard';
import { documentInput, type PageRef, textImage } from '../../ui/components/document-input';
import { emptyState } from '../../ui/components/empty-state';
import { type ExportFormat, exportMenu } from '../../ui/components/export-menu';
import { failureLine } from '../../ui/components/failure-line';
import { focusedKey, focusKey, h, replaceWith } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { type FailureText, isStop } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { batchSummary, batchTitle, runItems } from '../../ui/tool/batch';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import { pendingOnly } from '../../ui/tool/runner';
import {
  csvZip,
  tableCsv,
  tablesMarkdown,
  tablesWorkbook,
  tableStem,
  tableTitle,
  tableTsv,
} from './export';
import { type TableCard, tableCard } from './grid';
import {
  canMerge,
  describeTables,
  estimateTokens,
  type ExtractedTable,
  fallbackMode,
  isUnsupportedStrict,
  mergeTables,
  type OutputMode,
  outputMode,
  pageRequest,
  parseTables,
  responseRefusal,
  toTable,
} from './tables';
import { progressBar } from '../../ui/components/progress-bar';

interface PageState {
  key: string;
  ref: PageRef;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  error: string | null;
  /** How to show the failure (`failureText`: after an unknown outcome it carries the caution and the link). */
  failure: FailureText | null;
  found: number;
  /** The answer hit the length limit: its complete rows were kept, later ones may be missing. */
  truncated: boolean;
}

const IMAGE_SIZES = [1024, 1600, 2048] as const;
const CONCURRENCY = [1, 2, 3] as const;

export function setup(ctx: ToolContext): ToolInstance {
  const { ui } = ctx;
  const options = ctx.options.get();
  const ids = {
    prompt: uid('te-prompt'),
    charts: uid('te-charts'),
    textHint: uid('te-text-hint'),
    size: uid('te-size'),
    concurrency: uid('te-concurrency'),
  };

  /**
   * What the read that is going on began with, taken once when Find tables was pressed. Nothing read per page may
   * change what a page costs or says (the image size, the PDF text hint, the charts switch, the instructions), so
   * the estimate and every request come from this, never from the form.
   */
  interface Began {
    charts: boolean;
    instructions: string;
    textHint: boolean;
    maxSide: number;
    concurrency: number;
    /** `getState().settings` of that moment, for History. */
    settings: Record<string, unknown>;
  }
  let active: Began | null = null;

  // --- input zone -----------------------------------------------------------------------------------------
  const docs = documentInput({
    accept: ctx.manifest.accepts,
    maxSide: () => active?.maxSide ?? (Number(size.value) || 2048),
    onChange: () => void ui.refreshEstimate(),
    label: 'Drop pages with tables',
  });
  const charts = h('input', {
    id: ids.charts,
    type: 'checkbox',
    class: 'form-check-input',
    checked: options['charts'] !== false,
    'data-testid': 'te-charts',
    onchange: () => ctx.options.set({ charts: charts.checked }),
  });
  const prompt = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 2,
    placeholder: 'For example: only the table about 2025; keep units in the headers',
    'data-testid': 'tool-prompt',
  });
  ui.input.append(
    docs.element,
    h(
      'div',
      { class: 'form-check' },
      charts,
      h(
        'label',
        { class: 'form-check-label', htmlFor: ids.charts },
        'Also turn charts into tables of their data',
      ),
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
  const textHint = h('input', {
    id: ids.textHint,
    type: 'checkbox',
    class: 'form-check-input',
    role: 'switch',
    checked: options['textHint'] !== false,
    'data-testid': 'te-text-hint',
    onchange: () => ctx.options.set({ textHint: textHint.checked }),
  });
  ui.drawer.append(
    h(
      'div',
      { class: 'form-check form-switch' },
      textHint,
      h(
        'label',
        { class: 'form-check-label', htmlFor: ids.textHint },
        "Send the PDF's own text along",
      ),
      h(
        'div',
        { class: 'form-text mt-0' },
        'Where a PDF page carries text, the model gets it to check numbers against.',
      ),
    ),
  );
  const select = <T extends number>(
    id: string,
    values: readonly T[],
    value: unknown,
    fallback: T,
    key: string,
    label: (v: T) => string,
  ): HTMLSelectElement => {
    const element = h(
      'select',
      {
        id,
        class: 'form-select',
        onchange: () => ctx.options.set({ [key]: Number(element.value) }),
      },
      values.map((entry) => h('option', { value: String(entry) }, label(entry))),
    );
    element.value = String(values.includes(value as T) ? value : fallback);
    return element;
  };
  const size = select(
    ids.size,
    IMAGE_SIZES,
    options['maxSide'],
    2048,
    'maxSide',
    (value) => `${value} px`,
  );
  const concurrency = select(
    ids.concurrency,
    CONCURRENCY,
    options['concurrency'],
    3,
    'concurrency',
    (value) => plural(value, 'page'),
  );
  ui.advanced('Images and speed').append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.size }, 'Page image size (longest side)'),
      size,
      h('div', { class: 'form-text' }, 'Dense tables need a large image.'),
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.concurrency }, 'Pages read at the same time'),
      concurrency,
    ),
  );

  // --- output zone ----------------------------------------------------------------------------------------
  let tables: ExtractedTable[] = [];
  let pages: PageState[] = [];
  let reading = false;
  /** Bumped whenever a run replaces tables: an Undo from before then would bring back a stale table. */
  let extraction = 0;

  const summary = h('div', {
    class: 'small text-body-secondary me-auto',
    tabIndex: -1,
    'data-testid': 'te-summary',
  });
  const exportSlot = h('span', { class: 'd-inline-block' });
  const failedBox = h('div', { hidden: true, 'data-testid': 'te-failed' });
  const truncatedBox = h('div', { hidden: true, 'data-testid': 'te-truncated' });
  const list = h('div', { class: 'vstack gap-3', 'data-testid': 'te-tables' });
  const empty = emptyState({
    icon: 'table',
    title: 'No tables yet',
    text: 'Add pages and press Find tables. Every table appears here as a grid you can edit before exporting.',
    compact: true,
    testId: 'te-empty',
  });
  const none = emptyState({
    icon: 'table',
    title: 'No tables found',
    text: 'The pages were read, but no table or chart was found on them. Try a larger page image in Settings, or say in the extra instructions what to look for.',
    compact: true,
    testId: 'te-none',
  });
  none.hidden = true;
  const progress = progressBar({ label: 'Pages read', hidden: true, testId: 'te-progress' });
  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h('div', { class: 'd-flex flex-wrap align-items-center gap-2' }, summary, exportSlot),
      progress.element,
      failedBox,
      truncatedBox,
      empty,
      none,
      list,
    ),
  );

  const stem = (): string => {
    const first = tables[0]?.fileName ?? docs.files()[0]?.name;
    return first ? `${first.replace(/\.[^.]+$/, '')}-tables` : 'tables';
  };

  /** Edits made since the tables were last exported (or last filled by a read). */
  let unsaved = false;
  let releaseHold: (() => void) | null = null;
  /** Edited tables are unsaved work: leaving the page asks first, until they are exported. */
  const syncHold = (): void => {
    const dirty = unsaved && tables.length > 0;
    if (dirty && !releaseHold) releaseHold = ui.holdWork('Edited tables not exported yet');
    else if (!dirty && releaseHold) {
      releaseHold();
      releaseHold = null;
    }
  };
  const edited = (): void => {
    unsaved = true;
    syncHold();
  };

  /** Building a file is what saves the edits: from then on they are exported. */
  const exporting = (list: ExportFormat[]): ExportFormat[] =>
    list.map((format) => ({
      ...format,
      build: async () => {
        const blob = await format.build();
        unsaved = false;
        syncHold();
        return blob;
      },
    }));

  /** The download formats; they read the tables when chosen, so only one table versus several changes them. */
  const formats = (single: boolean): ExportFormat[] => {
    return exporting([
      single
        ? {
            label: 'CSV',
            extension: 'csv',
            icon: 'filetype-csv',
            filename: () => tableStem(tables[0]!, 1),
            build: () => new Blob([tableCsv(tables[0]!)], { type: 'text/csv' }),
          }
        : {
            label: 'CSV files (ZIP, one per table)',
            extension: 'zip',
            icon: 'file-earmark-zip',
            filename: () => `${stem()}-csv`,
            build: () => csvZip(tables),
          },
      {
        label: 'Excel workbook (a sheet per table)',
        extension: 'xlsx',
        icon: 'file-earmark-excel',
        build: () => tablesWorkbook(tables),
      },
      {
        label: 'Markdown',
        extension: 'md',
        icon: 'markdown',
        build: () => new Blob([tablesMarkdown(tables)], { type: 'text/markdown' }),
      },
    ]);
  };

  const menu = exportMenu({
    formats: formats(false),
    filename: stem,
    disabled: true,
    testId: 'te-export',
  });
  exportSlot.append(menu);
  let menuShape = 'none';

  const pageName = (page: PageState): string =>
    page.ref.pageCount > 1 ? `${page.ref.fileName} p. ${page.ref.pageNumber}` : page.ref.fileName;

  const renderSummary = (): void => {
    const done = pages.filter((page) => page.status === 'done').length;
    const failed = pages.filter((page) => page.status === 'failed' || page.status === 'stopped');
    const cut = pages.filter((page) => page.status === 'done' && page.truncated);
    summary.textContent =
      pages.length === 0 && tables.length === 0
        ? ''
        : `${describeTables(tables)} · ${done} of ${plural(pages.length, 'page')} read`;
    // Pages were read and none held a table: say so, instead of inviting the user to add pages again.
    const noneFound =
      !reading &&
      tables.length === 0 &&
      pages.some((page) => page.status === 'done') &&
      pages.every((page) => page.status !== 'done' || page.found === 0);
    empty.hidden = tables.length > 0 || reading || noneFound;
    none.hidden = !noneFound;
    progress.element.hidden = !reading;
    progress.update(
      done + failed.length,
      pages.length,
      `${done + failed.length} of ${plural(pages.length, 'page')}`,
    );
    failedBox.hidden = reading || failed.length === 0;
    replaceWith(
      failedBox,
      failed.length === 0
        ? null
        : h(
            'div',
            { class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 mb-0' },
            icon('exclamation-triangle'),
            h(
              'div',
              { class: 'me-auto' },
              `${plural(failed.length, 'page')} not read:`,
              h(
                'ul',
                { class: 'mb-0 ps-3' },
                failed.map((page) =>
                  h(
                    'li',
                    null,
                    pageName(page),
                    page.error
                      ? [
                          ': ',
                          failureLine(
                            page.failure ?? {
                              text: page.error,
                              outcomeUnknown: false,
                              activityUrl: null,
                              note: null,
                            },
                            { className: 'd-inline', testId: 'te-error' },
                          ),
                        ]
                      : null,
                  ),
                ),
              ),
            ),
            retryButton(failed.map((page) => page.key)),
          ),
      // "Retry" hides while reading: keep keyboard focus nearby, on the summary line.
      { fallback: () => summary },
    );
    truncatedBox.hidden = cut.length === 0;
    replaceWith(
      truncatedBox,
      cut.length === 0
        ? null
        : h(
            'div',
            { class: 'alert alert-warning d-flex gap-2 mb-0' },
            icon('scissors'),
            h(
              'span',
              null,
              `Cut off at the length limit, so the last rows may be missing: ${cut.map(pageName).join('; ')}.`,
            ),
          ),
    );
    // In place, and only when it changes: an open menu stays open while pages finish and cells are edited.
    const shape = tables.length === 0 ? 'none' : tables.length === 1 ? 'one' : 'many';
    if (shape !== menuShape) {
      menuShape = shape;
      menu.update({ formats: formats(shape === 'one'), disabled: shape === 'none' });
    }
    syncHold();
  };

  /** The card drawn for each table, reused for as long as the table object stays the same. */
  const cards = new Map<string, TableCard>();

  const cardHandlers = {
    onReplace: (next: ExtractedTable, key?: string) => {
      tables = tables.map((candidate) => (candidate.id === next.id ? next : candidate));
      unsaved = true;
      renderTables(key);
      renderSummary();
    },
    onEdit: edited,
    onDelete: (gone: ExtractedTable) => deleteTable(gone),
    onMerge: (first: ExtractedTable) => {
      const at = tables.indexOf(first);
      const next = tables[at + 1];
      if (!next) return;
      const merged = mergeTables(first, next);
      tables = [...tables.slice(0, at), merged, ...tables.slice(at + 2)];
      unsaved = true;
      renderTables(`${merged.id}:title`);
      renderSummary();
      announce(
        `Merged into “${tableTitle(merged, at + 1)}”: ${plural(merged.rows.length, 'row')}.`,
      );
    },
    onCopy: (table: ExtractedTable) => {
      void copyText(tableTsv(table)).then((ok) =>
        toast(
          ok
            ? { message: 'Copied. Paste it into a spreadsheet.', variant: 'success' }
            : { message: 'Copying was blocked by the browser.', variant: 'warning' },
        ),
      );
    },
  };

  /**
   * Shows `tables` in order. A card whose table (and name) did not change is kept as it is, so a page finishing
   * never redraws, refocuses or resets the cards around it; only new or replaced tables get new cards.
   */
  const renderTables = (focus?: string): void => {
    const activeKey = focusedKey(list);
    const wanted = tables.map((table, index) => {
      const mergeable = canMerge(table, tables[index + 1]);
      const cached = cards.get(table.id);
      if (cached?.table === table) {
        cached.setCanMerge(mergeable);
        cached.setPosition(index + 1);
        return cached.element;
      }
      const card = tableCard(table, { position: index + 1, canMerge: mergeable, ...cardHandlers });
      cards.set(table.id, card);
      return card.element;
    });
    for (const id of [...cards.keys()])
      if (!tables.some((table) => table.id === id)) cards.delete(id);
    // Move only what is out of place, so cards that stay keep their focus and caret.
    wanted.forEach((element, index) => {
      const at = list.children[index];
      if (at !== element) list.insertBefore(element, at ?? null);
    });
    while (list.children.length > wanted.length) list.lastElementChild!.remove();
    if (focus) focusKey(list, focus);
    else if (activeKey && !list.contains(document.activeElement)) focusKey(list, activeKey);
  };

  /** Deletes a table; Undo puts it back next to the neighbours it had, unless a run replaced the tables since. */
  const deleteTable = (gone: ExtractedTable): void => {
    const at = tables.indexOf(gone);
    if (at < 0) return;
    const before = tables[at - 1]?.id ?? null;
    const after = tables[at + 1]?.id ?? null;
    const deletedIn = extraction;
    const name = tableTitle(gone, at + 1);
    tables = tables.filter((candidate) => candidate !== gone);
    unsaved = true;
    renderTables();
    renderSummary();
    const neighbour = tables[Math.min(at, tables.length - 1)];
    if (neighbour) focusKey(list, `${neighbour.id}:title`);
    toast({
      message: `Deleted “${name}”.`,
      action: {
        label: 'Undo',
        testId: 'toast-undo',
        onClick: () => {
          if (deletedIn !== extraction) {
            toast({
              variant: 'warning',
              message: `“${name}” came from an earlier extraction, so it was not put back.`,
            });
            return;
          }
          if (tables.some((table) => table.id === gone.id)) return;
          const indexOf = (id: string | null): number =>
            id === null ? -1 : tables.findIndex((table) => table.id === id);
          let index: number;
          if (before === null) index = 0;
          else if (indexOf(before) >= 0) index = indexOf(before) + 1;
          else if (indexOf(after) >= 0) index = indexOf(after);
          else index = Math.min(at, tables.length);
          tables = [...tables.slice(0, index), gone, ...tables.slice(index)];
          renderTables(`${gone.id}:title`);
          renderSummary();
        },
      },
    });
  };

  // --- running --------------------------------------------------------------------------------------------
  const estimateFor = (
    refs: readonly PageRef[],
    model: string,
    began: Pick<Began, 'textHint' | 'maxSide'>,
  ): Promise<number | null> =>
    refs.length === 0
      ? Promise.resolve(null)
      : ctx.models.estimate({
          kind: 'tokens',
          model,
          ...estimateTokens({
            pages: refs.length,
            // Each PDF page whose own text goes along (a page image has none).
            hintPages: began.textHint ? refs.filter((ref) => ref.kind === 'pdf').length : 0,
            maxSide: began.maxSide,
          }),
        });

  /** The form's settings: the state Prompts and History keep (`getState().settings`). */
  const formSettings = () => ({
    charts: charts.checked,
    textHint: textHint.checked,
    maxSide: Number(size.value),
    concurrency: Number(concurrency.value),
  });

  /** The form as it is now, as a snapshot a run can hold on to. */
  const readForm = (): Began => ({
    charts: charts.checked,
    instructions: prompt.value,
    textHint: textHint.checked,
    maxSide: Number(size.value),
    concurrency: Number(concurrency.value) || 3,
    settings: formSettings(),
  });

  /** The error each failed page ended with, for its Retry (a request that may have been billed asks first). */
  const failures = new Map<string, unknown>();

  /** A Retry button that follows the runner (see `retryGate`). */
  function retryButton(keys: string[]): HTMLButtonElement {
    return gate.bind(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-warning',
          'data-focus-key': 'retry-failed',
          'data-testid': 'te-retry-failed',
          onclick: () => retry(keys),
        },
        'Retry',
      ),
    );
  }

  /** Reads `keys` again (a Retry); the runner's own Retry after a refusal repeats the same pages. */
  function retry(keys: string[]): void {
    if (keys.length === 0) return;
    const errors = keys.flatMap((key) => (failures.has(key) ? [failures.get(key)] : []));
    void gate.retryFailed(
      errors.find((error) => isOutcomeUnknown(error)) ?? errors[0],
      keys,
      'Reading cannot start now.',
    );
  }

  const CUT_OFF_NOTE =
    'The answer was cut off at the length limit; rows at the end of this page may be missing.';

  /** The structured-output mode of the batch being read; strict mode can drop to JSON mode mid-batch. */
  interface BatchMode {
    mode: OutputMode;
    supported: readonly string[];
  }

  const readPage = async (
    run: RunHandle,
    page: PageState,
    batch: BatchMode,
    began: Began,
    maxCompletionTokens: number | null,
  ): Promise<void> => {
    const input = await docs.loadPage(page.ref);
    const ask = () =>
      pageRequest(run.model, input, {
        charts: began.charts,
        mode: batch.mode,
        instructions: began.instructions,
        textHint: began.textHint,
        supported: batch.supported,
        maxCompletionTokens,
      });
    let body = ask();
    let response: ChatResponse;
    try {
      response = await ctx.api.chat(body, { run });
    } catch (error) {
      // No provider serves the strict request: carry on (this page and the rest) in JSON mode.
      if (body.response_format?.type !== 'json_schema' || !isUnsupportedStrict(error)) throw error;
      if (batch.mode === 'schema') batch.mode = fallbackMode(batch.supported);
      body = ask();
      response = await ctx.api.chat(body, { run });
    }
    // A model that declined (or a filter that blocked it) did not read the page.
    const refusal = responseRefusal(response);
    if (refusal) throw new InvalidInputError(`The model did not answer: ${refusal}`);
    const choice = response.choices[0];
    const truncated = choice?.finish_reason === 'length';
    // Cut off: keep the tables and rows that were complete, and say so.
    const parsed = parseTables(choice?.message.content ?? '', { partial: truncated });
    if ('problem' in parsed)
      throw new InvalidInputError(`The model's answer could not be read: ${parsed.problem}`);
    // Replace this page's earlier tables (a retry), keep everything in file and page order.
    const fresh = parsed.tables.map((raw) =>
      toTable(raw, {
        id: uid('table'),
        fileId: page.ref.fileId,
        fileName: page.ref.fileName,
        pageNumber: page.ref.pageNumber,
        pageCount: page.ref.pageCount,
      }),
    );
    const last = fresh.at(-1);
    if (truncated && last) last.notes = [last.notes, CUT_OFF_NOTE].filter(Boolean).join('\n');
    page.found = fresh.length;
    page.truncated = truncated;
    const order = pages.map((candidate) => candidate.key);
    const rank = (table: ExtractedTable): number =>
      order.indexOf(`${table.fileId}:${table.firstPage}`);
    tables = [
      ...tables.filter(
        (table) => !(table.fileId === page.ref.fileId && table.firstPage === page.ref.pageNumber),
      ),
      ...fresh,
    ].sort((a, b) => rank(a) - rank(b));
  };

  /** The plan of the Find tables press that is going or was last (null before beginRun accepted a press). */
  let pressed: string[] | null = null;

  const run = async (signal: AbortSignal, keys?: string[]): Promise<void> => {
    if (!keys) pressed = null;
    // Everything the run uses is read here, once.
    const began = readForm();
    active = began;
    try {
      await perform(signal, keys, began);
    } finally {
      active = null;
    }
  };

  const perform = async (
    signal: AbortSignal,
    keys: string[] | undefined,
    began: Began,
  ): Promise<void> => {
    const refs = keys ? [] : docs.selection();
    if (!keys && refs.length === 0) {
      ui.status(docs.files().length ? 'Choose at least one page.' : 'Add an image or a PDF first.');
      return;
    }
    const planned = keys
      ? pages.filter((page) => keys.includes(page.key)).map((page) => page.ref)
      : refs;
    if (planned.length === 0) return;
    if (!keys) {
      // A new read replaces the tables: ask before it throws away edits nothing has exported.
      const replaceIt = await ui.confirmDiscard({
        what: 'the tables you edited',
        isDirty: () => unsaved && tables.length > 0,
        title: 'Replace your edits?',
        confirmLabel: 'Find tables again',
      });
      if (!replaceIt) return;
    }

    const model = ctx.model().model;
    const info = model ? await ctx.models.get(model).catch(() => undefined) : undefined;
    const supported = info?.supportedParameters ?? [];
    const maxCompletionTokens = info?.maxCompletionTokens ?? null;
    const batchMode: BatchMode = { mode: outputMode(supported), supported };
    const startMode = batchMode.mode;
    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): the tables, their edits and
    // the list of failed pages stay exactly as they were.
    const handle = await ctx.beginRun(
      {
        title: batchTitle(
          planned.map((ref) => ref.fileName),
          { retry: keys !== undefined },
        ),
        // What this press reads, as it was when pressed (a retry books only its own pages).
        estimateUsd: model ? await estimateFor(planned, model, began) : null,
        prompt: began.instructions,
        settings: began.settings,
      },
      signal,
    );
    if (!keys) pressed = planned.map((ref) => `${ref.fileId}:${ref.pageNumber}`);

    // The run is on: only now replace (or reset) what it reads. Only a read that replaces the tables makes an
    // earlier Undo stale: a retry fills pages that had no tables.
    if (!keys) extraction += 1;
    let batch: PageState[];
    if (keys) {
      batch = pages.filter((page) => keys.includes(page.key));
    } else {
      pages = refs.map((ref) => ({
        key: `${ref.fileId}:${ref.pageNumber}`,
        ref,
        status: 'queued',
        error: null,
        failure: null,
        found: 0,
        truncated: false,
      }));
      tables = [];
      failures.clear();
      unsaved = false;
      batch = pages;
      renderTables();
    }
    for (const page of batch) {
      page.status = 'queued';
      page.error = null;
      page.failure = null;
      page.truncated = false;
      failures.delete(page.key);
    }
    reading = true;
    renderSummary();
    try {
      const outcome = await runItems({
        items: batch,
        concurrency: began.concurrency,
        signal: handle.signal,
        work: (page) => readPage(handle, page, batchMode, began, maxCompletionTokens),
        onItem: ({ item: page, status, error, failure }) => {
          page.status = status;
          if (status === 'failed') {
            page.error = failure?.text ?? userMessage(error);
            page.failure = failure ?? null;
            failures.set(page.key, error);
          }
          if (status === 'running' || status === 'queued') return;
          renderTables();
          renderSummary();
          const done = pages.filter((item) => item.status === 'done').length;
          // A counter, not a status per page: a long PDF would flood a screen reader.
          ui.progress(`Read ${done} of ${plural(pages.length, 'page')}`);
          void handle.checkpoint({ output: () => tablesMarkdown(tables) }).catch(() => undefined);
        },
      });
      // Strict outputs can be refused mid-batch (no provider serves them): say that the rest came in JSON mode.
      ui.status(
        `${batchSummary(outcome, 'page')} · ${tables.length ? describeTables(tables) : 'no tables found'}${
          batchMode.mode === startMode
            ? ''
            : ' · Strict answers were not available for this model, so JSON mode was used.'
        }`,
      );
      if (tables.length === 0) announce('No tables found on these pages.');
      await handle.finish({
        output: tablesMarkdown(tables),
        meta: {
          pages: pages.length,
          tables: tables.length,
          failed: pages.filter((page) => page.status !== 'done').length,
          cutOff: pages.filter((page) => page.truncated).length,
          mode: batchMode.mode,
        },
      });
    } catch (error) {
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await handle.fail(error);
      throw error;
    } finally {
      reading = false;
      renderSummary();
    }
  };

  // A replay after an error covers only the pages without a result, so a fatal error part-way never pays twice;
  // a press the run refused (nothing began) is replayed as the whole press.
  const isDone = (key: string): boolean =>
    pages.some((page) => page.key === key && page.status === 'done');
  const unfinished = pendingOnly<string>(isDone, () => pressed ?? []);
  const runner = ui.runner<string[]>({
    label: 'Find tables',
    icon: 'table',
    run,
    replayArg: (arg) => (arg === undefined && pressed === null ? undefined : unfinished(arg)),
  });
  // The Retry button follows Run (busy, disabled by this tool or the framework).
  const gate = retryGate(runner);
  renderSummary();

  return {
    getState: () => ({ prompt: prompt.value, settings: formSettings() }),
    applyState({ prompt: text, settings: state }) {
      prompt.value = text;
      if (typeof state['charts'] === 'boolean') charts.checked = state['charts'];
      if (typeof state['textHint'] === 'boolean') textHint.checked = state['textHint'];
      if (IMAGE_SIZES.includes(state['maxSide'] as (typeof IMAGE_SIZES)[number]))
        size.value = String(state['maxSide']);
      if (CONCURRENCY.includes(state['concurrency'] as (typeof CONCURRENCY)[number]))
        concurrency.value = String(state['concurrency']);
      void ui.refreshEstimate();
    },
    estimate: (model) => estimateFor(docs.selection(), model, readForm()),
    onFiles: (files) => void docs.add(files),
    onReceive: (items) => {
      const files = items.flatMap((item) =>
        item.kind === 'file' ? [new File([item.blob], item.name, { type: item.blob.type })] : [],
      );
      if (files.length > 0) void docs.add(files);
    },
    sample: async () => {
      prompt.value = 'Keep the currency in the headers.';
      const page = await textImage(
        'sample-table.png',
        'Quarterly revenue (EUR thousands)',
        [
          'Region      Q1     Q2     Q3     Q4',
          'North      120    135    150    170',
          'South       98    101    110    125',
          'East        75     80     92    101',
          'West       143    150    149    160',
        ],
        { mono: true },
      );
      if (page) await docs.add([page]);
      void ui.refreshEstimate();
    },
  };
}
