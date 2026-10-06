/**
 * Data extractor: structured fields out of invoices, receipts and other documents, in bulk. A schema (preset or
 * built by the user) becomes a strict JSON Schema where the model supports structured outputs (JSON mode plus
 * validation and one repair request otherwise); every document (or page) is one request in a small pool; the
 * answers land in a review grid where they can be corrected; exports read the corrected values. One run per
 * batch, its output the JSON of the results (checkpointed as documents finish).
 */
import type { ChatRequest, ChatResponse } from '../../core/api/types';
import { InvalidInputError, isOutcomeUnknown, userMessage } from '../../core/errors';
import { toJsonBlob } from '../../core/export/table';
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
import { focusKey, h, replace } from '../../ui/dom';
import { confirmDialog, promptDialog } from '../../ui/feedback/dialogs';
import { isStop, presentError } from '../../ui/feedback/errors';
import { openModal } from '../../ui/feedback/modal';
import { toast } from '../../ui/feedback/toast';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { batchSummary, batchTitle, runItems } from '../../ui/tool/batch';
import type { ToolContext, ToolInstance, ToolSnapshot } from '../../ui/tool/index';
import { retryGate } from '../../ui/tool/retry-gate';
import { pendingOnly } from '../../ui/tool/runner';
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
  responseRefusal,
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
import { progressBar } from '../../ui/components/progress-bar';

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
  /** The saved set used last time (`options.schema`), when it still exists. */
  const rememberedSet =
    typeof options['schema'] === 'string' && options['schema'].startsWith('saved:')
      ? saved.find((schema) => `saved:${schema.id}` === options['schema'])
      : undefined;
  /** Where the fields came from: `preset:<id>`, `saved:<id>` or `custom`. */
  let source = rememberedSet ? `saved:${rememberedSet.id}` : `preset:${initialPreset.id}`;
  let dirty = false;

  const builder = schemaBuilder({
    onChange: () => {
      dirty = true;
      renderSchemaBar();
      void ui.refreshEstimate();
    },
  });
  builder.setFields(rememberedSet?.fields ?? initialPreset.fields);

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

  /**
   * Takes a stored list in (after a change here or in another tab). The set in use that is gone stays in the form
   * as Custom fields, so the picker never shows nothing.
   */
  const setSaved = (list: SavedSchema[]): void => {
    saved = list;
    if (source.startsWith('saved:') && !savedOf(source)) source = 'custom';
    renderSchemaBar();
  };

  /**
   * Changes the stored list as a read-modify-write under the key's lock, so a save in another tab is never
   * overwritten by the list this tab read earlier. Resolves false (and says why) when it could not be stored.
   */
  const changeSaved = async (change: (list: SavedSchema[]) => SavedSchema[]): Promise<boolean> => {
    try {
      const next = await ctx.state.update<unknown>(STATE_KEY, (current) =>
        change(readSaved(current)),
      );
      setSaved(readSaved(next));
      return true;
    } catch (error) {
      void presentError(error);
      return false;
    }
  };

  // Saved sets change here and in other tabs: read them again (our own writes compare equal and stop there).
  ctx.bus.on('tool-state-changed', (event) => {
    if (event.tool !== ctx.manifest.id || event.key !== STATE_KEY) return;
    void ctx.state
      .get<unknown>(STATE_KEY)
      .then((value) => setSaved(readSaved(value)))
      .catch(() => undefined);
  });

  /** A source the picker can show: a preset or saved set that exists, else Custom. */
  const knownSource = (value: unknown): string => {
    if (typeof value !== 'string') return 'custom';
    if (value.startsWith('preset:')) return presetById(value.slice(7)) ? value : 'custom';
    return value.startsWith('saved:') && savedOf(value) ? value : 'custom';
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
    ctx.options.set(
      value.startsWith('preset:') ? { preset: value.slice(7), schema: value } : { schema: value },
    );
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
    let schema!: SavedSchema;
    const stored = await changeSaved((list) => {
      const existing = list.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
      schema = {
        id: existing?.id ?? uid('schema'),
        name: name.trim(),
        fields: builder.fields(),
      };
      return existing
        ? list.map((item) => (item.id === existing.id ? schema : item))
        : [...list, schema];
    });
    if (!stored) return;
    source = `saved:${schema.id}`;
    dirty = false;
    ctx.options.set({ schema: source });
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
    await changeSaved((list) =>
      list.map((item) => (item.id === schema.id ? { ...item, name: name.trim() } : item)),
    );
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
    source = 'custom';
    ctx.options.set({ schema: source });
    if (!(await changeSaved((list) => list.filter((item) => item.id !== schema.id)))) {
      source = `saved:${schema.id}`;
      ctx.options.set({ schema: source });
      renderSchemaBar();
      return;
    }
    toast({ message: `Deleted “${schema.name}”.` });
  }

  /**
   * What the extraction that is going on began with, read once when Extract was pressed. Nothing read per document
   * may change what a document costs or says (the image size, the PDF text hint, the instructions, the fields), so
   * the estimate and every request come from this, never from the form.
   */
  interface Began {
    fields: FieldDef[];
    instructions: string;
    textHint: boolean;
    maxSide: number;
    perPage: boolean;
    concurrency: number;
    /** `getState().settings` of that moment, for History. */
    settings: ToolSnapshot['settings'];
  }
  let active: Began | null = null;
  /** The form's settings: the state Prompts and History keep (`getState().settings`). */
  const formSettings = (): ToolSnapshot['settings'] => ({
    schema: source,
    fields: builder.fields(),
    perPage: perPage.checked,
    textHint: textHint.checked,
    maxSide: Number(size.value),
    concurrency: Number(concurrency.value),
  });

  // --- input zone -----------------------------------------------------------------------------------------
  const docs = documentInput({
    accept: ctx.manifest.accepts,
    maxSide: () => active?.maxSide ?? (Number(size.value) || 1600),
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
      `For PDFs where every page is its own document (a scanned stack of receipts). Otherwise a PDF is read as one document, ${MAX_PAGES_PER_REQUEST} pages to a request: a longer one becomes one row for every ${MAX_PAGES_PER_REQUEST} pages.`,
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

  /** Corrections made since the values were last exported (or the grid was last filled). */
  let unsaved = false;
  let releaseHold: (() => void) | null = null;
  /** Corrected values are unsaved work: leaving the page asks first, until they are exported. */
  const syncHold = (): void => {
    const dirty = unsaved && results.some((doc) => doc.edited.length > 0);
    if (dirty && !releaseHold) releaseHold = ui.holdWork('Corrected values not exported yet');
    else if (!dirty && releaseHold) {
      releaseHold();
      releaseHold = null;
    }
  };

  const grid = reviewGrid({
    fields: () => gridFields,
    onEdit: () => {
      unsaved = true;
      renderSummary();
    },
    onRetry: (doc) => retry([doc.key]),
    onSource: (doc) => void showSource(doc),
    bindRetry: (button) => gate.bind(button),
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
  const progress = progressBar({
    label: 'Documents extracted',
    hidden: true,
    testId: 'de-progress',
  });
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
      progress.element,
      empty,
      gridBox,
    ),
  );

  let reading = false;

  /** Building a file is what saves the corrections: from then on they are exported. */
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

  const formats = (): ExportFormat[] => {
    const fields = gridFields;
    const tables = tableFields(fields);
    return exporting([
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
    ]);
  };

  const menu = exportMenu({
    formats: formats(),
    filename: stem,
    disabled: true,
    testId: 'de-export',
  });
  exportSlot.append(menu);
  let menuFields = gridFields;
  let menuDisabled = true;

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
    progress.element.hidden = total === 0 || !reading;
    progress.update(
      done.length + failed.length,
      total,
      `${done.length + failed.length} of ${plural(total, 'document')}`,
    );
    // The formats change with the batch's fields only; the menu is updated in place (an open one stays open).
    if (menuFields !== gridFields || menuDisabled !== (done.length === 0)) {
      menuFields = gridFields;
      menuDisabled = done.length === 0;
      menu.update({ formats: formats(), disabled: menuDisabled });
    }
    syncHold();
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
  const planUnits = (onePerPage: boolean): Unit[] => {
    const refs = docs.selection();
    if (onePerPage)
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

  const estimateFor = (
    plan: readonly Unit[],
    model: string,
    began: Pick<Began, 'fields' | 'textHint' | 'maxSide'>,
  ): Promise<number | null> => {
    if (plan.length === 0) return Promise.resolve(null);
    let promptTokens = 0;
    let completionTokens = 0;
    for (const unit of plan) {
      const tokens = estimateDocumentTokens(began.fields, unit.refs.length, {
        maxSide: began.maxSide,
        // Each PDF page whose own text goes along (a page image has none).
        hintPages: began.textHint ? unit.refs.filter((ref) => ref.kind === 'pdf').length : 0,
      });
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
    began: Began,
    maxCompletionTokens: number | null,
  ): ChatRequest =>
    buildRequest(
      run.model,
      began.fields,
      { fileName: doc.fileName, pages },
      {
        instructions: began.instructions,
        mode: batch.mode,
        textHint: began.textHint,
        supported: batch.supported,
        maxCompletionTokens,
      },
    );

  /** A model that declined (or a filter that blocked it) did not read the document: no parsing, no repair. */
  const refuse = (answer: ChatResponse): void => {
    const refusal = responseRefusal(answer);
    if (refusal) throw new InvalidInputError(`The model did not answer: ${refusal}`);
  };

  const extractOne = async (
    run: RunHandle,
    unit: Unit,
    doc: DocResult,
    batch: BatchMode,
    began: Began,
    maxCompletionTokens: number | null,
  ): Promise<void> => {
    const pages: PageInput[] = [];
    for (const ref of unit.refs) pages.push(await docs.loadPage(ref));
    let body = requestFor(run, doc, pages, batch, began, maxCompletionTokens);
    let first: ChatResponse;
    try {
      first = await ctx.api.chat(body, { run });
    } catch (error) {
      // No provider serves the strict request: carry on (this document and the rest) in JSON mode.
      if (body.response_format?.type !== 'json_schema' || !isUnsupportedStrict(error)) throw error;
      if (batch.mode === 'schema') batch.mode = fallbackMode(batch.supported);
      body = requestFor(run, doc, pages, batch, began, maxCompletionTokens);
      first = await ctx.api.chat(body, { run });
    }
    refuse(first);
    const answer = first.choices[0]?.message.content ?? '';
    let parsed = parseAnswer(began.fields, answer);
    if (!parsed.ok) {
      const second = await ctx.api.chat(repairRequest(body, answer, parsed.problem), { run });
      refuse(second);
      parsed = parseAnswer(began.fields, second.choices[0]?.message.content ?? '');
      if (!parsed.ok)
        throw new InvalidInputError(`The model's answer could not be read: ${parsed.problem}`);
    }
    doc.values = parsed.result.values;
    doc.issues = parsed.result.issues;
    doc.edited = [];
  };

  /** The error each failed document ended with, for its Retry (a request that may have been billed asks first). */
  const failures = new Map<string, unknown>();

  /** Extracts `keys` again (a Retry); the runner's own Retry after a refusal repeats the same documents. */
  function retry(keys: string[]): void {
    if (keys.length === 0) return;
    const errors = keys.flatMap((key) => (failures.has(key) ? [failures.get(key)] : []));
    void gate.retryFailed(
      errors.find((error) => isOutcomeUnknown(error)) ?? errors[0],
      keys,
      'Extracting cannot start now.',
    );
  }

  /** The form as it is now, as a snapshot a run can hold on to (a retry keeps the fields the grid has). */
  const readForm = (keys: boolean): Began => {
    const fields = keys ? gridFields : builder.fields();
    return {
      fields,
      instructions: prompt.value,
      textHint: textHint.checked,
      maxSide: Number(size.value),
      perPage: perPage.checked,
      concurrency: Number(concurrency.value) || 3,
      settings: { ...formSettings(), fields },
    };
  };

  /** The plan of the Extract press that is going or was last (null before beginRun accepted a press). */
  let pressed: string[] | null = null;

  const run = async (signal: AbortSignal, keys?: string[]): Promise<void> => {
    if (!keys) pressed = null;
    // Everything the run uses is read here, once.
    const began = readForm(keys !== undefined);
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
      plan = planUnits(began.perPage);
      if (plan.length === 0) {
        ui.status(docs.files().length ? 'Choose at least one page.' : 'Add a document first.');
        return;
      }
      // A new extraction replaces the grid: ask before it throws away corrections nothing has saved.
      const replaceIt = await ui.confirmDiscard({
        what: 'the corrections you made in the grid',
        isDirty: () => unsaved && results.some((doc) => doc.edited.length > 0),
        title: 'Replace your corrections?',
        confirmLabel: 'Extract again',
      });
      if (!replaceIt) return;
    }

    const model = ctx.model().model;
    const info = model ? await ctx.models.get(model).catch(() => undefined) : undefined;
    const supported = info?.supportedParameters ?? [];
    const maxCompletionTokens = info?.maxCompletionTokens ?? null;
    const batchMode: BatchMode = { mode: outputMode(supported), supported };
    const startMode = batchMode.mode;
    // Refused before anything was sent (no key, locked, free-only, budget, Cancel): the grid, its corrections and
    // the statuses stay exactly as they were.
    const runHandle = await ctx.beginRun(
      {
        title: batchTitle(
          plan.map((unit) => unit.refs[0]!.fileName),
          { retry: keys !== undefined },
        ),
        // What this press extracts, as it was when pressed (a retry books only its own documents).
        estimateUsd: model ? await estimateFor(plan, model, began) : null,
        prompt: began.instructions,
        settings: began.settings,
      },
      signal,
    );
    if (!keys) pressed = plan.map((unit) => unit.key);

    // The run is on: only now replace (or reset) what it extracts.
    if (!keys) {
      gridFields = began.fields;
      failures.clear();
      unsaved = false;
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
        failure: null,
      }));
      grid.render(results);
    }
    const docOf = (unit: Unit): DocResult | undefined =>
      results.find((candidate) => candidate.key === unit.key);
    const batch = plan.flatMap((unit) => docOf(unit) ?? []);
    const retryHadFocus = retryFailed.contains(document.activeElement);
    for (const doc of batch) {
      doc.status = 'queued';
      doc.error = null;
      doc.failure = null;
      failures.delete(doc.key);
      grid.update(doc);
    }
    reading = true;
    renderSummary();
    // "Retry failed" hides while reading: keep keyboard focus on the first document it retries.
    if (retryHadFocus && batch[0]) focusKey(grid.element, `source:${batch[0].key}`);

    try {
      const outcome = await runItems({
        items: plan,
        concurrency: began.concurrency,
        signal: runHandle.signal,
        work: async (unit) => {
          const doc = docOf(unit);
          if (doc) await extractOne(runHandle, unit, doc, batchMode, began, maxCompletionTokens);
        },
        onItem: ({ item, status, error, failure }) => {
          const doc = docOf(item);
          if (!doc) return;
          doc.status = status;
          if (status === 'failed') {
            doc.error = failure?.text ?? userMessage(error);
            doc.failure = failure ?? null;
            failures.set(doc.key, error);
          }
          grid.update(doc);
          renderSummary();
          if (status === 'running' || status === 'queued') return;
          // A counter, not a status per document: hundreds of them would flood a screen reader.
          ui.progress(
            `Extracted ${results.filter((entry) => entry.status === 'done').length} of ${plural(results.length, 'document')}`,
          );
          void runHandle.checkpoint({ output: json }).catch(() => undefined);
        },
      });
      // Strict outputs can be refused mid-batch (no provider serves them): say that the rest came in JSON mode.
      ui.status(
        batchMode.mode === startMode
          ? batchSummary(outcome, 'document')
          : `${batchSummary(outcome, 'document')} · Strict answers were not available for this model, so JSON mode was used.`,
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

  // A replay after an error covers only the documents without a result, so a fatal error part-way never pays
  // twice; a press the run refused (nothing began) is replayed as the whole press.
  const isDone = (key: string): boolean =>
    results.some((doc) => doc.key === key && doc.status === 'done');
  const unfinished = pendingOnly<string>(isDone, () => pressed ?? []);
  const runner = ui.runner<string[]>({
    label: 'Extract',
    icon: 'braces',
    run,
    replayArg: (arg) => (arg === undefined && pressed === null ? undefined : unfinished(arg)),
  });
  // Retry buttons follow Run (busy, disabled by this tool or the framework).
  const gate = retryGate(runner);
  gate.bind(retryFailed);
  renderSchemaBar();
  renderSummary();

  const getState = (): ToolSnapshot => ({ prompt: prompt.value, settings: formSettings() });

  return {
    getState,
    applyState({ prompt: text, settings }) {
      prompt.value = text;
      const fields = readFields(settings['fields']);
      if (fields) {
        builder.setFields(fields);
        source = knownSource(settings['schema']);
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
    estimate: (model) => estimateFor(planUnits(perPage.checked), model, readForm(false)),
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
