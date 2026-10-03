/**
 * Table extractor: finds the tables (and, optionally, charts as their data series) on the selected pages, one
 * structured request per page in a small pool, and shows each as an editable grid: cells, headers, rows and
 * columns, merging a table that continues on the next page, deleting one. Exports CSV (a ZIP for several),
 * an Excel workbook with a sheet per table, Markdown, and TSV for pasting into a spreadsheet. One run per
 * Run press; its output is the tables as Markdown.
 */
import { ApiError, errorCode, InvalidInputError, userMessage } from '../../core/errors';
import { runPool } from '../../core/pool';
import { abortError } from '../../core/util';
import type { RunHandle } from '../../core/types';
import { copyText } from '../../ui/clipboard';
import { documentInput, type PageRef, textImage } from '../../ui/components/document-input';
import { emptyState } from '../../ui/components/empty-state';
import { type ExportFormat, exportMenu } from '../../ui/components/export-menu';
import { h, replace } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented, needsAction } from '../../ui/feedback/errors';
import { toast } from '../../ui/feedback/toast';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { ToolContext, ToolInstance } from '../../ui/tool/index';
import { csvZip, tableCsv, tablesMarkdown, tablesWorkbook, tableStem, tableTsv } from './export';
import { tableCard } from './grid';
import {
  canMerge,
  describeTables,
  type ExtractedTable,
  mergeTables,
  outputMode,
  pageRequest,
  parseTables,
  toTable,
} from './tables';

interface PageState {
  key: string;
  ref: PageRef;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  error: string | null;
  found: number;
}

const IMAGE_SIZES = [1024, 1600, 2048] as const;
const CONCURRENCY = [1, 2, 3] as const;

function isFatal(error: unknown): boolean {
  if (needsAction(error)) return true;
  const code = errorCode(error);
  if (code === 'invalid-key' || code === 'no-key' || code === 'locked') return true;
  return error instanceof ApiError && (error.status === 401 || error.status === 402);
}

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

  // --- input zone -----------------------------------------------------------------------------------------
  const docs = documentInput({
    accept: ctx.manifest.accepts,
    maxSide: () => Number(size.value) || 2048,
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

  const summary = h('div', {
    class: 'small text-body-secondary me-auto',
    'data-testid': 'te-summary',
  });
  const exportSlot = h('span', { class: 'd-inline-block' });
  const failedBox = h('div', { hidden: true, 'data-testid': 'te-failed' });
  const list = h('div', { class: 'vstack gap-3', 'data-testid': 'te-tables' });
  const empty = emptyState({
    icon: 'table',
    title: 'No tables yet',
    text: 'Add pages and press Find tables. Every table appears here as a grid you can edit before exporting.',
    compact: true,
    testId: 'te-empty',
  });
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': 'Pages read',
      'aria-valuemin': '0',
      hidden: true,
      'data-testid': 'te-progress',
    },
    progressBar,
  );
  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h('div', { class: 'd-flex flex-wrap align-items-center gap-2' }, summary, exportSlot),
      progress,
      failedBox,
      empty,
      list,
    ),
  );

  const stem = (): string => {
    const first = tables[0]?.fileName ?? docs.files()[0]?.name;
    return first ? `${first.replace(/\.[^.]+$/, '')}-tables` : 'tables';
  };

  const formats = (): ExportFormat[] => {
    const single = tables.length === 1 ? tables[0] : undefined;
    return [
      single
        ? {
            label: 'CSV',
            extension: 'csv',
            icon: 'filetype-csv',
            filename: () => tableStem(single, 1),
            build: () => new Blob([tableCsv(single)], { type: 'text/csv' }),
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
    ];
  };

  const renderSummary = (): void => {
    const done = pages.filter((page) => page.status === 'done').length;
    const failed = pages.filter((page) => page.status === 'failed' || page.status === 'stopped');
    summary.textContent =
      pages.length === 0 && tables.length === 0
        ? ''
        : `${describeTables(tables)} · ${done} of ${plural(pages.length, 'page')} read`;
    empty.hidden = tables.length > 0 || reading;
    progress.hidden = !reading;
    progress.setAttribute('aria-valuemax', String(pages.length));
    progress.setAttribute('aria-valuenow', String(done + failed.length));
    progressBar.style.width = pages.length
      ? `${Math.round(((done + failed.length) / pages.length) * 100)}%`
      : '0%';
    failedBox.hidden = reading || failed.length === 0;
    replace(
      failedBox,
      failed.length === 0
        ? null
        : h(
            'div',
            { class: 'alert alert-warning d-flex flex-wrap align-items-center gap-2 mb-0' },
            icon('exclamation-triangle'),
            h(
              'span',
              { class: 'me-auto' },
              `${plural(failed.length, 'page')} not read: `,
              failed
                .map(
                  (page) =>
                    `${page.ref.fileName} p. ${page.ref.pageNumber}${page.error ? ` (${page.error})` : ''}`,
                )
                .join('; '),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-sm btn-warning',
                'data-focus-key': 'retry-failed',
                'data-testid': 'te-retry-failed',
                onclick: () => retry(failed.map((page) => page.key)),
              },
              'Retry',
            ),
          ),
    );
    replace(
      exportSlot,
      exportMenu({
        formats: formats(),
        filename: stem,
        disabled: tables.length === 0,
        testId: 'te-export',
      }),
    );
  };

  const focusKey = (key: string | undefined): void => {
    if (!key) return;
    [...list.querySelectorAll<HTMLElement>('[data-focus-key]')]
      .find((candidate) => candidate.getAttribute('data-focus-key') === key)
      ?.focus();
  };

  /** Draws every table; `focus` names the control to focus afterwards. */
  const renderTables = (focus?: string): void => {
    replace(
      list,
      tables.map((table, index) =>
        tableCard(table, {
          position: index + 1,
          canMerge: canMerge(table, tables[index + 1]),
          onReplace: (next, key) => {
            tables = tables.map((candidate) => (candidate.id === table.id ? next : candidate));
            renderTables(key);
            renderSummary();
          },
          onDelete: (gone) => {
            const at = tables.indexOf(gone);
            tables = tables.filter((candidate) => candidate !== gone);
            renderTables();
            renderSummary();
            const neighbour = tables[Math.min(at, tables.length - 1)];
            focusKey(neighbour ? `${neighbour.id}:title` : undefined);
            toast({
              message: `Deleted “${gone.title}”.`,
              action: {
                label: 'Undo',
                testId: 'toast-undo',
                onClick: () => {
                  tables = [...tables.slice(0, at), gone, ...tables.slice(at)];
                  renderTables(`${gone.id}:title`);
                  renderSummary();
                },
              },
            });
          },
          onMerge: (first) => {
            const at = tables.indexOf(first);
            const next = tables[at + 1];
            if (!next) return;
            const merged = mergeTables(first, next);
            tables = [...tables.slice(0, at), merged, ...tables.slice(at + 2)];
            renderTables(`${merged.id}:title`);
            renderSummary();
            announce(`Merged into “${merged.title}”: ${plural(merged.rows.length, 'row')}.`);
          },
          onCopy: (table) => {
            void copyText(tableTsv(table)).then((ok) =>
              toast(
                ok
                  ? { message: 'Copied. Paste it into a spreadsheet.', variant: 'success' }
                  : { message: 'Copying was blocked by the browser.', variant: 'warning' },
              ),
            );
          },
        }),
      ),
    );
    focusKey(focus);
  };

  // --- running --------------------------------------------------------------------------------------------
  const estimateFor = (count: number, model: string): Promise<number | null> =>
    count === 0
      ? Promise.resolve(null)
      : ctx.models.estimate({
          kind: 'tokens',
          model,
          promptTokens: count * 2600,
          completionTokens: count * 2500,
        });

  let retryKeys: string[] | null = null;
  const retry = (keys: string[]): void => {
    if (runner.busy || keys.length === 0) return;
    retryKeys = keys;
    void runner.trigger();
  };

  const readPage = async (
    run: RunHandle,
    page: PageState,
    mode: ReturnType<typeof outputMode>,
  ): Promise<void> => {
    const input = await docs.loadPage(page.ref);
    const body = pageRequest(run.model, input, {
      charts: charts.checked,
      mode,
      instructions: prompt.value,
      textHint: textHint.checked,
    });
    const response = await ctx.api.chat(body, { run });
    const parsed = parseTables(response.choices[0]?.message.content ?? '');
    if ('problem' in parsed)
      throw new InvalidInputError(`The model's answer could not be read: ${parsed.problem}`);
    // Replace this page's earlier tables (a retry), keep everything in file and page order.
    const fresh = parsed.tables.map((raw, index) =>
      toTable(raw, {
        id: uid('table'),
        fileId: page.ref.fileId,
        fileName: page.ref.fileName,
        pageNumber: page.ref.pageNumber,
        pageCount: page.ref.pageCount,
        index: tables.length + index + 1,
      }),
    );
    page.found = fresh.length;
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

  const run = async (signal: AbortSignal): Promise<void> => {
    const keys = retryKeys;
    retryKeys = null;
    let batch: PageState[];
    if (keys) {
      batch = pages.filter((page) => keys.includes(page.key));
    } else {
      const refs = docs.selection();
      if (refs.length === 0) {
        ui.status(
          docs.files().length ? 'Choose at least one page.' : 'Add an image or a PDF first.',
        );
        return;
      }
      pages = refs.map((ref) => ({
        key: `${ref.fileId}:${ref.pageNumber}`,
        ref,
        status: 'queued',
        error: null,
        found: 0,
      }));
      tables = [];
      batch = pages;
      renderTables();
    }
    for (const page of batch) {
      page.status = 'queued';
      page.error = null;
    }
    renderSummary();

    const model = ctx.model().model;
    const info = model ? await ctx.models.get(model).catch(() => undefined) : undefined;
    const mode = outputMode(info?.supportedParameters ?? []);
    const first = batch[0]!.ref.fileName;
    const files = new Set(batch.map((page) => page.ref.fileName));
    let handle: RunHandle;
    try {
      handle = await ctx.beginRun(
        {
          title: `${keys ? 'Retry: ' : ''}${first}${files.size > 1 ? ` and ${plural(files.size - 1, 'more file')}` : ''}`,
          ...(keys && model ? { estimateUsd: await estimateFor(batch.length, model) } : {}),
        },
        signal,
      );
    } catch (error) {
      for (const page of batch) page.status = 'stopped';
      renderSummary();
      throw error;
    }
    reading = true;
    renderSummary();
    let lastError = null as Error | null; // assigned inside the pool callbacks
    try {
      try {
        await runPool(
          batch,
          Number(concurrency.value) || 3,
          async (page) => {
            page.status = 'running';
            try {
              await readPage(handle, page, mode);
              page.status = 'done';
            } catch (error) {
              if (isStop(error) || handle.signal.aborted) {
                page.status = 'stopped';
                throw error;
              }
              page.status = 'failed';
              page.error = userMessage(error);
              lastError =
                error instanceof Error ? error : new InvalidInputError(userMessage(error));
              if (isFatal(error)) throw error;
            } finally {
              renderTables();
              renderSummary();
              const done = pages.filter((item) => item.status === 'done').length;
              ui.status(`Read ${done} of ${plural(pages.length, 'page')}`);
              void handle.checkpoint({ output: tablesMarkdown(tables) }).catch(() => undefined);
            }
          },
          handle.signal,
        );
      } finally {
        for (const page of batch)
          if (page.status === 'queued' || page.status === 'running') page.status = 'stopped';
      }
      if (handle.signal.aborted) {
        const reason: unknown = handle.signal.reason;
        throw reason instanceof Error ? reason : abortError('Stopped.');
      }
      const done = batch.filter((page) => page.status === 'done').length;
      if (done === 0 && lastError) {
        if (!needsAction(lastError)) markPresented(lastError);
        throw lastError;
      }
      ui.status(tables.length ? describeTables(tables) : 'No tables found');
      if (tables.length === 0) announce('No tables found on these pages.');
      await handle.finish({
        output: tablesMarkdown(tables),
        meta: {
          pages: pages.length,
          tables: tables.length,
          failed: pages.filter((page) => page.status !== 'done').length,
          mode,
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

  const runner = ui.runner({ label: 'Find tables', icon: 'table', run });
  renderSummary();

  const settings = () => ({
    charts: charts.checked,
    textHint: textHint.checked,
    maxSide: Number(size.value),
    concurrency: Number(concurrency.value),
  });

  return {
    getState: () => ({ prompt: prompt.value, settings: settings() }),
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
    estimate: (model) => estimateFor(docs.selection().length, model),
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
