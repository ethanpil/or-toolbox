/**
 * Data extractor: structured fields out of invoices, receipts and other documents, in bulk. A schema (preset or
 * built by the user) becomes a strict JSON Schema where the model supports structured outputs (JSON mode plus
 * validation and one repair request otherwise); every document (or page) is one request in a small pool; the
 * answers land in a review grid where they can be corrected; exports read the corrected values. One run per
 * batch, its output the JSON of the results (checkpointed as documents finish).
 */
import type { ChatRequest, ChatResponse } from '../../core/api/types';
import { ApiError, errorCode, InvalidInputError, userMessage } from '../../core/errors';
import { toJsonBlob } from '../../core/export/table';
import { runPool } from '../../core/pool';
import { abortError } from '../../core/util';
import type { RunHandle } from '../../core/types';
import { isRecord } from '../../core/util';
import {
  documentInput,
  type PageInput,
  type PageRef,
  textImage,
} from '../../ui/components/document-input';
import { emptyState } from '../../ui/components/empty-state';
import { type ExportFormat, exportMenu } from '../../ui/components/export-menu';
import { imageViewer } from '../../ui/components/image-viewer';
import { h, replace } from '../../ui/dom';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { announce } from '../../ui/feedback/announce';
import { isStop, markPresented, needsAction, presentError } from '../../ui/feedback/errors';
import { openModal } from '../../ui/feedback/modal';
import { toast } from '../../ui/feedback/toast';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { Runner, ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/index';
import { schemaBuilder } from './builder';
import {
  buildRequest,
  estimateDocumentTokens,
  fallbackMode,
  isUnsupportedStrict,
  MAX_PAGES_PER_REQUEST,
  type OutputMode,
  outputMode,
  parseAnswer,
  repairRequest,
} from './extract';
import {
  type DocResult,
  documentsCsv,
  flattenedCsv,
  jsonResults,
  lineItemsCsv,
  tableFields,
  workbook,
} from './export';
import { DEFAULT_PRESET, presetById, PRESETS } from './presets';
import { reviewGrid } from './review';
import { type FieldDef, fieldLabel, readFields } from './schema';

interface SavedSchema {
  id: string;
  name: string;
  fields: FieldDef[];
}

interface Unit {
  key: string;
  refs: PageRef[];
}

const STATE_KEY = 'schemas';
const IMAGE_SIZES = [1024, 1600, 2048] as const;
const CONCURRENCY = [1, 2, 3] as const;

function readSaved(value: unknown): SavedSchema[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['name'] !== 'string')
      return [];
    const fields = readFields(item['fields']);
    return fields ? [{ id: item['id'], name: item['name'], fields }] : [];
  });
}

function isFatal(error: unknown): boolean {
  if (needsAction(error)) return true;
  const code = errorCode(error);
  if (code === 'invalid-key' || code === 'no-key' || code === 'locked') return true;
  return error instanceof ApiError && (error.status === 401 || error.status === 402);
}

export async function setup(ctx: ToolContext): Promise<ToolInstance> {
  const { ui } = ctx;
  const options = ctx.options.get();
  let saved = readSaved(await ctx.state.get<unknown>(STATE_KEY).catch(() => undefined));
  const ids = {
    schema: uid('de-schema'),
    prompt: uid('de-prompt'),
    perPage: uid('de-per-page'),
    textHint: uid('de-text-hint'),
    size: uid('de-size'),
    concurrency: uid('de-concurrency'),
    fields: uid('de-fields'),
  };

  // --- schema ---------------------------------------------------------------------------------------------
  const initialPreset =
    presetById(typeof options['preset'] === 'string' ? options['preset'] : '') ??
    presetById(DEFAULT_PRESET)!;
  /** Where the fields came from: `preset:<id>`, `saved:<id>` or `custom`. */
  let source = `preset:${initialPreset.id}`;
  let dirty = false;

  const builder = schemaBuilder({
    onChange: () => {
      dirty = true;
      renderSchemaBar();
      void ui.refreshEstimate();
    },
  });
  builder.setFields(initialPreset.fields);

  const schemaSelect = h('select', {
    id: ids.schema,
    class: 'form-select',
    'data-testid': 'de-schema-select',
    onchange: () => void chooseSchema(schemaSelect.value),
  });
  const editedBadge = h(
    'span',
    { class: 'badge text-bg-warning', hidden: true, 'data-testid': 'de-schema-edited' },
    'Edited',
  );
  const summary = h('div', {
    class: 'small text-body-secondary text-break',
    'data-testid': 'de-schema-summary',
  });
  const builderBox = h('div', { id: ids.fields, hidden: true }, builder.element);
  const editToggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
      'aria-expanded': 'false',
      'aria-controls': ids.fields,
      'data-testid': 'de-edit-fields',
      onclick: () => setBuilderOpen(Boolean(builderBox.hidden)),
    },
    icon('pencil-square'),
    h('span', null, 'Edit fields'),
  );
  const setBuilderOpen = (open: boolean): void => {
    builderBox.hidden = !open;
    editToggle.setAttribute('aria-expanded', String(open));
    editToggle.lastElementChild!.textContent = open ? 'Hide fields' : 'Edit fields';
  };

  const savedOf = (value: string): SavedSchema | undefined =>
    value.startsWith('saved:') ? saved.find((schema) => `saved:${schema.id}` === value) : undefined;

  const renameButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-testid': 'de-schema-rename',
      onclick: () => void renameSchema(),
    },
    'Rename',
  );
  const deleteButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-secondary',
      'data-testid': 'de-schema-delete',
      onclick: () => void deleteSchema(),
    },
    'Delete',
  );

  function renderSchemaBar(): void {
    replace(
      schemaSelect,
      h(
        'optgroup',
        { label: 'Presets' },
        PRESETS.map((preset) => h('option', { value: `preset:${preset.id}` }, preset.name)),
      ),
      saved.length
        ? h(
            'optgroup',
            { label: 'Saved' },
            saved.map((schema) => h('option', { value: `saved:${schema.id}` }, schema.name)),
          )
        : null,
      source === 'custom' ? h('option', { value: 'custom' }, 'Custom') : null,
    );
    schemaSelect.value = source;
    editedBadge.hidden = !dirty;
    const isSaved = savedOf(source) !== undefined;
    renameButton.hidden = !isSaved;
    deleteButton.hidden = !isSaved;
    const fields = builder.fields();
    summary.textContent = `${plural(fields.length, 'field')}: ${fields.map((field) => fieldLabel(field.name)).join(', ')}`;
  }

  const persistSaved = async (): Promise<void> => {
    try {
      await ctx.state.set(STATE_KEY, saved);
    } catch (error) {
      void presentError(error);
    }
  };

  async function chooseSchema(value: string): Promise<void> {
    if (value === source) return;
    const fields = value.startsWith('preset:')
      ? presetById(value.slice(7))?.fields
      : savedOf(value)?.fields;
    if (!fields) return;
    if (dirty) {
      const replaceIt = await confirmDialog({
        title: 'Replace your edited fields?',
        message:
          'The fields you changed are not saved. Save them first with “Save as” to keep them.',
        confirmLabel: 'Replace',
        tone: 'warning',
      });
      if (!replaceIt) {
        renderSchemaBar();
        return;
      }
    }
    source = value;
    dirty = false;
    builder.setFields(fields);
    if (value.startsWith('preset:')) ctx.options.set({ preset: value.slice(7) });
    renderSchemaBar();
    void ui.refreshEstimate();
  }

  async function saveSchema(): Promise<void> {
    if (!builder.validate()) {
      setBuilderOpen(true);
      return;
    }
    const name = await promptDialog({
      title: 'Save fields',
      label: 'Name',
      value: savedOf(source)?.name ?? '',
      placeholder: 'For example: Supplier invoices',
      confirmLabel: 'Save',
      maxLength: 80,
    });
    if (!name?.trim()) return;
    const existing = saved.find(
      (schema) => schema.name.toLowerCase() === name.trim().toLowerCase(),
    );
    const schema: SavedSchema = {
      id: existing?.id ?? uid('schema'),
      name: name.trim(),
      fields: builder.fields(),
    };
    saved = existing
      ? saved.map((item) => (item === existing ? schema : item))
      : [...saved, schema];
    source = `saved:${schema.id}`;
    dirty = false;
    await persistSaved();
    renderSchemaBar();
    toast({ message: `Saved “${schema.name}”.`, variant: 'success' });
  }

  async function renameSchema(): Promise<void> {
    const schema = savedOf(source);
    if (!schema) return;
    const name = await promptDialog({
      title: 'Rename fields',
      label: 'Name',
      value: schema.name,
      confirmLabel: 'Rename',
      maxLength: 80,
    });
    if (!name?.trim()) return;
    schema.name = name.trim();
    await persistSaved();
    renderSchemaBar();
  }

  async function deleteSchema(): Promise<void> {
    const schema = savedOf(source);
    if (!schema) return;
    const sure = await confirmDialog({
      title: `Delete “${schema.name}”?`,
      message: 'The fields stay in the form until you choose others.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!sure) return;
    saved = saved.filter((item) => item !== schema);
    source = 'custom';
    await persistSaved();
    renderSchemaBar();
    toast({ message: `Deleted “${schema.name}”.` });
  }

  // --- input zone -----------------------------------------------------------------------------------------
  const docs = documentInput({
    accept: ctx.manifest.accepts,
    maxSide: () => Number(size.value) || 1600,
    onChange: () => void ui.refreshEstimate(),
    label: 'Drop invoices, receipts or other documents',
  });
  const prompt = h('textarea', {
    id: ids.prompt,
    class: 'form-control',
    rows: 2,
    placeholder: 'For example: amounts are in Swiss francs; ignore handwritten notes',
    'data-testid': 'tool-prompt',
  });

  ui.input.append(
    docs.element,
    h(
      'section',
      { class: 'vstack gap-2', 'aria-labelledby': `${ids.schema}-heading` },
      h('h3', { id: `${ids.schema}-heading`, class: 'h6 mb-0' }, 'What to extract'),
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h('label', { class: 'visually-hidden', htmlFor: ids.schema }, 'Fields to extract'),
        h('div', { class: 'flex-grow-1' }, schemaSelect),
        editedBadge,
      ),
      summary,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        editToggle,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            'data-testid': 'de-schema-save',
            onclick: () => void saveSchema(),
          },
          icon('floppy'),
          'Save as…',
        ),
        renameButton,
        deleteButton,
      ),
      builderBox,
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
  const switchInput = (
    id: string,
    checked: boolean,
    key: string,
    testId: string,
  ): HTMLInputElement => {
    const input = h('input', {
      id,
      type: 'checkbox',
      class: 'form-check-input',
      role: 'switch',
      checked,
      'data-testid': testId,
      onchange: () => {
        ctx.options.set({ [key]: input.checked });
        void ui.refreshEstimate();
      },
    });
    return input;
  };
  const perPage = switchInput(ids.perPage, options['perPage'] === true, 'perPage', 'de-per-page');
  const textHint = switchInput(
    ids.textHint,
    options['textHint'] !== false,
    'textHint',
    'de-text-hint',
  );
  const formSwitch = (input: HTMLInputElement, label: string, help: string): HTMLElement =>
    h(
      'div',
      { class: 'form-check form-switch' },
      input,
      h('label', { class: 'form-check-label', htmlFor: input.id }, label),
      h('div', { class: 'form-text mt-0' }, help),
    );
  ui.drawer.append(
    formSwitch(
      perPage,
      'One extraction per page',
      `For PDFs where every page is its own document (a scanned stack of receipts). Otherwise a file is one document (up to ${MAX_PAGES_PER_REQUEST} pages per request).`,
    ),
    formSwitch(
      textHint,
      "Send the PDF's own text along",
      'Helps with numbers and names where a PDF page carries text.',
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
    1600,
    'maxSide',
    (value) => `${value} px`,
  );
  const concurrency = select(
    ids.concurrency,
    CONCURRENCY,
    options['concurrency'],
    3,
    'concurrency',
    (value) => plural(value, 'document'),
  );
  ui.advanced('Images and speed').append(
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.size }, 'Page image size (longest side)'),
      size,
    ),
    h(
      'div',
      null,
      h('label', { class: 'form-label', htmlFor: ids.concurrency }, 'Documents at the same time'),
      concurrency,
    ),
  );

  // --- output zone ----------------------------------------------------------------------------------------
  let results: DocResult[] = [];
  let units = new Map<string, Unit>();
  /** The fields of the batch in the grid (the builder may change meanwhile). */
  let gridFields: FieldDef[] = builder.fields();

  const stem = (): string => {
    const first = results[0]?.fileName ?? docs.files()[0]?.name;
    return first && results.length <= 1
      ? `${first.replace(/\.[^.]+$/, '')}-data`
      : 'extracted-data';
  };

  const grid = reviewGrid({
    fields: () => gridFields,
    onEdit: () => {
      renderSummary();
    },
    onRetry: (doc) => retry([doc.key]),
    onSource: (doc) => void showSource(doc),
    retryBlocked: () => runBlocked(),
  });
  const gridBox = h('div', { hidden: true }, grid.element);
  const empty = emptyState({
    icon: 'braces',
    title: 'No data yet',
    text: 'Add documents, check the fields, and press Extract. One row per document appears here to review.',
    compact: true,
    testId: 'de-empty',
  });
  const summaryLine = h('div', {
    class: 'small text-body-secondary me-auto',
    'data-testid': 'de-summary',
  });
  const exportSlot = h('span', { class: 'd-inline-block' });
  const retryFailed = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1',
      hidden: true,
      'data-retry': '',
      'data-testid': 'de-retry-failed',
      onclick: () =>
        retry(
          results
            .filter((doc) => doc.status === 'failed' || doc.status === 'stopped')
            .map((doc) => doc.key),
        ),
    },
    icon('arrow-clockwise'),
    'Retry failed',
  );
  const progressBar = h('div', { class: 'progress-bar' });
  const progress = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-label': 'Documents extracted',
      'aria-valuemin': '0',
      hidden: true,
      'data-testid': 'de-progress',
    },
    progressBar,
  );
  ui.output.append(
    h(
      'div',
      { class: 'vstack gap-3' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        summaryLine,
        retryFailed,
        exportSlot,
      ),
      progress,
      empty,
      gridBox,
    ),
  );

  let reading = false;

  const formats = (): ExportFormat[] => {
    const fields = gridFields;
    const tables = tableFields(fields);
    return [
      {
        label: 'JSON',
        extension: 'json',
        icon: 'braces',
        build: () => toJsonBlob(jsonResults(results)),
      },
      {
        label: 'CSV: documents',
        extension: 'csv',
        icon: 'filetype-csv',
        filename: () => `${stem()}-documents`,
        build: () => new Blob([documentsCsv(fields, results)], { type: 'text/csv' }),
      },
      ...tables.map((table) => ({
        label: `CSV: ${fieldLabel(table.name).toLowerCase()}`,
        extension: 'csv',
        icon: 'filetype-csv',
        filename: () => `${stem()}-${table.name.replace(/_/g, '-')}`,
        build: () => new Blob([lineItemsCsv(table, results)], { type: 'text/csv' }),
      })),
      ...(tables.length
        ? [
            {
              label: `CSV: one row per ${fieldLabel(tables[0]!.name).toLowerCase().replace(/s$/, '')}`,
              extension: 'csv',
              icon: 'filetype-csv',
              filename: () => `${stem()}-flat`,
              build: () => new Blob([flattenedCsv(fields, results)], { type: 'text/csv' }),
            },
          ]
        : []),
      {
        label: 'Excel workbook',
        extension: 'xlsx',
        icon: 'file-earmark-excel',
        build: () => workbook(fields, results),
      },
    ];
  };

  function renderSummary(): void {
    const total = results.length;
    const done = results.filter((doc) => doc.status === 'done');
    const failed = results.filter((doc) => doc.status === 'failed' || doc.status === 'stopped');
    const toCheck = done.filter((doc) => Object.keys(doc.issues).length > 0).length;
    const edited = done.filter((doc) => doc.edited.length > 0).length;
    empty.hidden = total > 0;
    gridBox.hidden = total === 0;
    summaryLine.textContent =
      total === 0
        ? ''
        : [
            `${done.length} of ${plural(total, 'document')} extracted`,
            toCheck ? `${toCheck} to check` : '',
            edited ? `${edited} corrected` : '',
            failed.length ? `${failed.length} failed` : '',
          ]
            .filter(Boolean)
            .join(' · ');
    retryFailed.hidden = failed.length === 0 || reading;
    progress.hidden = total === 0 || !reading;
    progress.setAttribute('aria-valuemax', String(total));
    progress.setAttribute('aria-valuenow', String(done.length + failed.length));
    progressBar.style.width = total
      ? `${Math.round(((done.length + failed.length) / total) * 100)}%`
      : '0%';
    replace(
      exportSlot,
      exportMenu({
        formats: formats(),
        filename: stem,
        disabled: done.length === 0,
        testId: 'de-export',
      }),
    );
  }

  async function showSource(doc: DocResult): Promise<void> {
    const unit = units.get(doc.key);
    const refs = unit?.refs ?? [];
    if (refs.length === 0 || !docs.file(refs[0]!.fileId)) {
      toast({ variant: 'warning', message: 'That file is no longer in the list.' });
      return;
    }
    let current = refs[0]!;
    const viewer = imageViewer({
      alt: `${doc.fileName}, page ${current.pageNumber}`,
      testId: 'de-source-image',
    });
    const load = async (ref: PageRef): Promise<void> => {
      current = ref;
      try {
        viewer.setSource({
          blob: await docs.pageImage(ref),
          alt: `${doc.fileName}, page ${ref.pageNumber}`,
        });
      } catch (error) {
        void presentError(error);
      }
    };
    const modal = openModal({
      title: `Document ${doc.index}: ${doc.fileName}`,
      icon: 'file-earmark-image',
      size: 'lg',
      body: [
        refs.length > 1
          ? h(
              'div',
              { class: 'btn-group mb-2', role: 'group', 'aria-label': 'Pages' },
              refs.map((ref) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-sm btn-outline-secondary',
                    onclick: () => void load(ref),
                  },
                  `Page ${ref.pageNumber}`,
                ),
              ),
            )
          : null,
        viewer.element,
      ],
      footer: [
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-secondary me-auto',
            'data-testid': 'de-source-reveal',
            onclick: () => {
              modal.hide();
              void modal.closed.then(() => docs.reveal(current));
            },
          },
          'Show in the file list',
        ),
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', 'data-bs-dismiss': 'modal' },
          'Close',
        ),
      ],
      testId: 'de-source-dialog',
    });
    await load(current);
    await modal.closed;
    viewer.dispose();
  }

  // --- running --------------------------------------------------------------------------------------------
  const planUnits = (): Unit[] => {
    const refs = docs.selection();
    if (perPage.checked)
      return refs.map((ref) => ({ key: `${ref.fileId}:${ref.pageNumber}`, refs: [ref] }));
    const byFile = new Map<string, PageRef[]>();
    for (const ref of refs) byFile.set(ref.fileId, [...(byFile.get(ref.fileId) ?? []), ref]);
    const planned: Unit[] = [];
    for (const [fileId, pages] of byFile) {
      for (let start = 0; start < pages.length; start += MAX_PAGES_PER_REQUEST) {
        const chunk = pages.slice(start, start + MAX_PAGES_PER_REQUEST);
        planned.push({ key: `${fileId}:${chunk[0]!.pageNumber}`, refs: chunk });
      }
    }
    return planned;
  };

  const estimateFor = (plan: readonly Unit[], model: string): Promise<number | null> => {
    if (plan.length === 0) return Promise.resolve(null);
    const fields = builder.fields();
    let promptTokens = 0;
    let completionTokens = 0;
    for (const unit of plan) {
      const tokens = estimateDocumentTokens(fields, unit.refs.length);
      promptTokens += tokens.promptTokens;
      completionTokens += tokens.completionTokens;
    }
    return ctx.models.estimate({ kind: 'tokens', model, promptTokens, completionTokens });
  };

  const json = (): string => JSON.stringify(jsonResults(results), null, 2);

  /** The structured-output mode of the batch being extracted; strict mode can drop to JSON mode mid-batch. */
  interface BatchMode {
    mode: OutputMode;
    supported: readonly string[];
  }

  const requestFor = (
    run: RunHandle,
    doc: DocResult,
    pages: readonly PageInput[],
    batch: BatchMode,
  ): ChatRequest =>
    buildRequest(
      run.model,
      gridFields,
      { fileName: doc.fileName, pages },
      {
        instructions: prompt.value,
        mode: batch.mode,
        textHint: textHint.checked,
        supported: batch.supported,
      },
    );

  const extractOne = async (
    run: RunHandle,
    unit: Unit,
    doc: DocResult,
    batch: BatchMode,
  ): Promise<void> => {
    const pages: PageInput[] = [];
    for (const ref of unit.refs) pages.push(await docs.loadPage(ref));
    let body = requestFor(run, doc, pages, batch);
    let first: ChatResponse;
    try {
      first = await ctx.api.chat(body, { run });
    } catch (error) {
      // No provider serves the strict request: carry on (this document and the rest) in JSON mode.
      if (body.response_format?.type !== 'json_schema' || !isUnsupportedStrict(error)) throw error;
      if (batch.mode === 'schema') batch.mode = fallbackMode(batch.supported);
      body = requestFor(run, doc, pages, batch);
      first = await ctx.api.chat(body, { run });
    }
    const answer = first.choices[0]?.message.content ?? '';
    let parsed = parseAnswer(gridFields, answer);
    if (!parsed.ok) {
      const second = await ctx.api.chat(repairRequest(body, answer, parsed.problem), { run });
      parsed = parseAnswer(gridFields, second.choices[0]?.message.content ?? '');
      if (!parsed.ok)
        throw new InvalidInputError(`The model's answer could not be read: ${parsed.problem}`);
    }
    doc.values = parsed.result.values;
    doc.issues = parsed.result.issues;
    doc.edited = [];
  };

  /** The documents a Retry asks for; `run` takes them the moment the runner starts it (see `retry`). */
  let pendingRetry: string[] | null = null;

  /** Why Run cannot start now (busy, or disabled with a reason); null when it can. */
  function runBlocked(): string | null {
    if (runner.busy) return 'Wait until the current run ends.';
    if (runner.button.getAttribute('aria-disabled') !== 'true') return null;
    return (
      runner.element.querySelector('[data-testid="run-hint"]')?.textContent?.trim() ||
      'Extracting is not possible right now.'
    );
  }

  /** Brings every Retry button in line with the runner (Run disabled or busy disables them, with the reason). */
  const syncRetryButtons = (): void => {
    const reason = runBlocked();
    for (const button of ui.output.querySelectorAll<HTMLElement>('[data-retry]')) {
      button.setAttribute('aria-disabled', String(reason !== null));
      button.classList.toggle('disabled', reason !== null);
      button.title = reason ?? '';
    }
  };

  function retry(keys: string[]): void {
    const blocked = runBlocked();
    if (blocked) {
      announce(blocked);
      return;
    }
    if (keys.length === 0) return;
    pendingRetry = keys;
    void runner.trigger();
    // The runner calls `run` synchronously when it starts; if it did not start, these keys must not wait around to
    // turn a later Run press into a retry.
    pendingRetry = null;
  }

  const run = async (signal: AbortSignal): Promise<void> => {
    const keys = pendingRetry;
    pendingRetry = null;
    let plan: Unit[];
    if (keys) {
      plan = keys.flatMap((key) => units.get(key) ?? []);
      if (plan.length === 0) return;
    } else {
      if (!builder.validate()) {
        setBuilderOpen(true);
        ui.status('Fix the fields first.');
        return;
      }
      plan = planUnits();
      if (plan.length === 0) {
        ui.status(docs.files().length ? 'Choose at least one page.' : 'Add a document first.');
        return;
      }
    }

    const model = ctx.model().model;
    const info = model ? await ctx.models.get(model).catch(() => undefined) : undefined;
    const supported = info?.supportedParameters ?? [];
    const batchMode: BatchMode = { mode: outputMode(supported), supported };
    const firstFile = plan[0]!.refs[0]!.fileName;
    const files = new Set(plan.map((unit) => unit.refs[0]!.fileName));
    let runHandle: RunHandle;
    try {
      runHandle = await ctx.beginRun(
        {
          title: `${keys ? 'Retry: ' : ''}${firstFile}${files.size > 1 ? ` and ${plural(files.size - 1, 'more file')}` : ''}`,
          ...(keys && model ? { estimateUsd: await estimateFor(plan, model) } : {}),
        },
        signal,
      );
    } catch (error) {
      // Refused before anything was sent (no key, locked, free-only, budget, Cancel): the grid, its corrections and
      // the statuses stay exactly as they were. A refused retry offers to retry the same documents.
      if (keys && !isStop(error)) void presentError(error, { retry: () => retry(keys) });
      throw error;
    }

    // The run is on: only now replace (or reset) what it extracts.
    if (!keys) {
      gridFields = builder.fields();
      units = new Map(plan.map((unit) => [unit.key, unit]));
      results = plan.map((unit, index) => ({
        key: unit.key,
        index: index + 1,
        fileId: unit.refs[0]!.fileId,
        fileName: unit.refs[0]!.fileName,
        pages: unit.refs.map((ref) => ref.pageNumber),
        pageCount: unit.refs[0]!.pageCount,
        status: 'queued',
        values: {},
        issues: {},
        edited: [],
        error: null,
      }));
      grid.render(results);
    }
    const batch = results.filter((doc) => plan.some((unit) => unit.key === doc.key));
    const retryHadFocus = retryFailed.contains(document.activeElement);
    for (const doc of batch) {
      doc.status = 'queued';
      doc.error = null;
      grid.update(doc);
    }
    reading = true;
    renderSummary();
    // "Retry failed" hides while reading: keep keyboard focus on the first document it retries.
    if (retryHadFocus && batch[0]) {
      grid.element
        .querySelector<HTMLElement>(`[data-focus-key="source:${CSS.escape(batch[0].key)}"]`)
        ?.focus();
    }

    let lastError = null as Error | null; // assigned inside the pool callbacks
    try {
      try {
        await runPool(
          plan,
          Number(concurrency.value) || 3,
          async (unit) => {
            const doc = results.find((candidate) => candidate.key === unit.key);
            if (!doc) return;
            doc.status = 'running';
            grid.update(doc);
            try {
              await extractOne(runHandle, unit, doc, batchMode);
              doc.status = 'done';
            } catch (error) {
              if (isStop(error) || runHandle.signal.aborted) {
                doc.status = 'stopped';
                throw error;
              }
              doc.status = 'failed';
              doc.error = userMessage(error);
              lastError =
                error instanceof Error ? error : new InvalidInputError(userMessage(error));
              if (isFatal(error)) throw error;
            } finally {
              grid.update(doc);
              renderSummary();
              ui.status(
                `Extracted ${results.filter((item) => item.status === 'done').length} of ${plural(results.length, 'document')}`,
              );
              void runHandle.checkpoint({ output: json() }).catch(() => undefined);
            }
          },
          runHandle.signal,
        );
      } finally {
        for (const doc of batch) {
          if (doc.status === 'queued' || doc.status === 'running') {
            doc.status = 'stopped';
            grid.update(doc);
          }
        }
      }
      if (runHandle.signal.aborted) {
        const reason: unknown = runHandle.signal.reason;
        throw reason instanceof Error ? reason : abortError('Stopped.');
      }
      // Only this run's documents decide whether it failed: a retry whose documents all fail again fails.
      const done = batch.filter((doc) => doc.status === 'done').length;
      if (done === 0 && lastError) {
        // Every row already shows its error: the runner need not show it again (unless it needs an action).
        if (!needsAction(lastError)) markPresented(lastError);
        throw lastError;
      }
      ui.status(
        `Extracted ${plural(results.filter((doc) => doc.status === 'done').length, 'document')}`,
      );
      await runHandle.finish({
        output: json(),
        meta: {
          documents: results.length,
          failed: results.filter((doc) => doc.status !== 'done').length,
          mode: batchMode.mode,
        },
      });
    } catch (error) {
      ui.status(isStop(error) ? 'Stopped' : 'Failed');
      await runHandle.fail(error);
      throw error;
    } finally {
      reading = false;
      renderSummary();
    }
  };

  const runner: Runner = ui.runner({ label: 'Extract', icon: 'braces', run });
  // Run turning busy, disabled or enabled (by this tool or the framework) updates the Retry buttons.
  new MutationObserver(syncRetryButtons).observe(runner.element, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-disabled'],
  });
  renderSchemaBar();
  renderSummary();

  const getState = (): ToolSnapshot => ({
    prompt: prompt.value,
    settings: {
      schema: source,
      fields: builder.fields(),
      perPage: perPage.checked,
      textHint: textHint.checked,
      maxSide: Number(size.value),
      concurrency: Number(concurrency.value),
    },
  });

  return {
    getState,
    applyState({ prompt: text, settings }) {
      prompt.value = text;
      const fields = readFields(settings['fields']);
      if (fields) {
        builder.setFields(fields);
        source = typeof settings['schema'] === 'string' ? settings['schema'] : 'custom';
        dirty = false;
      }
      if (typeof settings['perPage'] === 'boolean') perPage.checked = settings['perPage'];
      if (typeof settings['textHint'] === 'boolean') textHint.checked = settings['textHint'];
      if (IMAGE_SIZES.includes(settings['maxSide'] as (typeof IMAGE_SIZES)[number]))
        size.value = String(settings['maxSide']);
      if (CONCURRENCY.includes(settings['concurrency'] as (typeof CONCURRENCY)[number])) {
        concurrency.value = String(settings['concurrency']);
      }
      renderSchemaBar();
      void ui.refreshEstimate();
    },
    estimate: (model) => estimateFor(planUnits(), model),
    onFiles: (files) => void docs.add(files),
    onReceive: (items) => {
      const files = items.flatMap((item) =>
        item.kind === 'file' ? [new File([item.blob], item.name, { type: item.blob.type })] : [],
      );
      if (files.length > 0) void docs.add(files);
    },
    sample: async () => {
      await chooseSchema(`preset:${DEFAULT_PRESET}`);
      prompt.value = 'Amounts are in euros.';
      const receipt = await textImage(
        'sample-receipt.png',
        'Café Lumière, Rue des Fleurs 12, Paris',
        [
          'Receipt 2026-0412        3 October 2026',
          '2 x Croissant        @ 2.20      4.40',
          '1 x Café crème       @ 3.80      3.80',
          'Subtotal                         8.20',
          'VAT 10%                          0.82',
          'Total EUR                        9.02',
          'Paid by card',
        ],
        { mono: true },
      );
      if (receipt) await docs.add([receipt]);
      void ui.refreshEstimate();
    },
  };
}
