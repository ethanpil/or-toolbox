/**
 * The review grid: one row per document, every field an editable, validated cell; missing required fields and
 * values that need a look are flagged; tables of line items open under their row; corrections are written back
 * into the document's values, which is what every export reads.
 *
 * Rows are redrawn one at a time (a document finishing never disturbs a cell being edited in another row), and
 * text typed but not yet committed survives a redraw of its own row.
 */
import { h } from '../../ui/dom';
import { setFieldError } from '../../ui/feedback/field-error';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import type { DocResult } from './export';
import {
  type ColumnDef,
  type FieldDef,
  fieldLabel,
  isEmpty,
  normalizeValue,
  type Value,
  valueText,
} from './schema';

export interface ReviewGridOptions {
  fields: () => readonly FieldDef[];
  /** A cell was corrected (the document's values are already updated). */
  onEdit: (doc: DocResult) => void;
  onRetry: (doc: DocResult) => void;
  onSource: (doc: DocResult) => void;
}

export interface ReviewGrid {
  readonly element: HTMLElement;
  /** Draws every row (a new batch, or a changed schema). */
  render(docs: readonly DocResult[]): void;
  /** Redraws one document's rows. */
  update(doc: DocResult): void;
}

const STATUS: Record<DocResult['status'], [string, string]> = {
  queued: ['Waiting', 'text-bg-secondary'],
  running: ['Extracting…', 'text-bg-info'],
  done: ['Done', 'text-bg-success'],
  failed: ['Failed', 'text-bg-danger'],
  stopped: ['Not run', 'text-bg-secondary'],
};

/** Applies a new value to a field (or a table cell) and recomputes its issue. */
export function applyEdit(
  doc: DocResult,
  definition: FieldDef | ColumnDef,
  key: string,
  text: string,
  options: { required: boolean; set: (value: Value) => void },
): string | null {
  const { value, issue } = normalizeValue(definition, text);
  options.set(value);
  const problem = issue ?? (options.required && isEmpty(value) ? 'Required, but not found.' : null);
  if (problem) doc.issues[key] = problem;
  else delete doc.issues[key];
  if (!doc.edited.includes(key)) doc.edited.push(key);
  return problem;
}

export function reviewGrid(options: ReviewGridOptions): ReviewGrid {
  let docs: readonly DocResult[] = [];
  const expanded = new Set<string>();
  /** Typed but not yet committed cell text, by focus key. */
  const drafts = new Map<string, string>();

  const head = h('thead');
  const body = h('tbody');
  const captionId = uid('review-caption');
  const table = h(
    'table',
    {
      class: 'table table-sm align-middle or-grid',
      'aria-describedby': captionId,
      'data-testid': 'de-grid',
    },
    h(
      'caption',
      { id: captionId, class: 'visually-hidden' },
      'Extracted data, one row per document',
    ),
    head,
    body,
  );
  const element = h('div', { class: 'table-responsive position-relative' }, table);

  const feedbackFor = (input: HTMLElement): HTMLElement => {
    let feedback = input.parentElement?.querySelector<HTMLElement>(':scope > .invalid-feedback');
    if (!feedback) {
      feedback = h('div', { class: 'invalid-feedback' });
      input.after(feedback);
    }
    return feedback;
  };

  /** An editable cell for one value; `commit` gets the text when the user leaves or changes it. */
  const editor = (
    definition: FieldDef | ColumnDef,
    value: unknown,
    label: string,
    focusKey: string,
    issue: string | undefined,
    commit: (text: string, input: HTMLInputElement | HTMLSelectElement) => void,
  ): HTMLElement => {
    const draft = drafts.get(focusKey);
    let input: HTMLInputElement | HTMLSelectElement;
    const type = definition.type;
    if (type === 'boolean' || type === 'enum') {
      const options = type === 'boolean' ? ['Yes', 'No'] : ((definition as FieldDef).options ?? []);
      const current = valueText(value);
      input = h(
        'select',
        { class: 'form-select form-select-sm', 'aria-label': label, 'data-focus-key': focusKey },
        h('option', { value: '' }, '—'),
        options.map((option) => h('option', { value: option }, option)),
        current && !options.includes(current) ? h('option', { value: current }, current) : null,
      );
      input.value = current;
      input.addEventListener('change', () => commit(input.value, input));
    } else {
      const text = h('input', {
        type: 'text',
        class: 'form-control form-control-sm',
        value: draft ?? valueText(value),
        'aria-label': label,
        'data-focus-key': focusKey,
        inputMode: type === 'number' || type === 'currency' ? 'decimal' : 'text',
      });
      text.addEventListener('input', () => drafts.set(focusKey, text.value));
      text.addEventListener('change', () => {
        drafts.delete(focusKey);
        commit(text.value, text);
      });
      input = text;
    }
    const wrapper = h('div', { class: 'or-grid-cell' }, input);
    if (issue) {
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      const feedback = h('div', { class: 'invalid-feedback', id: uid('cell-issue') }, issue);
      input.setAttribute('aria-describedby', feedback.id);
      wrapper.append(feedback);
    }
    return wrapper;
  };

  const commitField = (doc: DocResult, field: FieldDef) => (text: string, input: HTMLElement) => {
    const problem = applyEdit(doc, field, field.name, text, {
      required: field.required,
      set: (value) => {
        doc.values[field.name] = value;
      },
    });
    setFieldError(input, feedbackFor(input), problem);
    options.onEdit(doc);
    refreshIssues(doc);
  };

  const commitCell =
    (doc: DocResult, field: FieldDef, row: number, column: ColumnDef) =>
    (text: string, input: HTMLElement) => {
      const items = doc.values[field.name];
      if (!Array.isArray(items)) return;
      const item = items[row];
      if (typeof item !== 'object' || item === null) return;
      const problem = applyEdit(doc, column, `${field.name}[${row}].${column.name}`, text, {
        required: false,
        set: (value) => {
          item[column.name] = value;
        },
      });
      setFieldError(input, feedbackFor(input), problem);
      options.onEdit(doc);
      refreshIssues(doc);
    };

  const issueCount = (doc: DocResult): number => Object.keys(doc.issues).length;

  const issuesBadge = (doc: DocResult): HTMLElement => {
    if (doc.status !== 'done') return h('span', { class: 'text-body-secondary' }, '—');
    const count = issueCount(doc);
    return count === 0
      ? h('span', { class: 'badge text-bg-success', 'data-testid': 'de-issues' }, 'OK')
      : h(
          'span',
          { class: 'badge text-bg-warning', 'data-testid': 'de-issues' },
          `${count} to check`,
        );
  };

  const refreshIssues = (doc: DocResult): void => {
    const cell = body.querySelector<HTMLElement>(
      `tr[data-doc-key="${doc.key}"] [data-issues-cell]`,
    );
    cell?.replaceChildren(issuesBadge(doc));
  };

  const detailId = (doc: DocResult, field: FieldDef): string =>
    `de-detail-${doc.key}-${field.name}`.replace(/[^\w-]/g, '_');

  const mainRow = (doc: DocResult, fields: readonly FieldDef[]): HTMLElement => {
    const [statusText, statusClass] = STATUS[doc.status];
    const label = `document ${doc.index}`;
    const done = doc.status === 'done';
    return h(
      'tr',
      { 'data-testid': 'de-row', dataset: { docKey: doc.key, status: doc.status } },
      h('th', { scope: 'row', class: 'or-grid-narrow' }, String(doc.index)),
      h(
        'td',
        { class: 'or-grid-narrow' },
        h(
          'div',
          { class: 'd-flex align-items-center gap-1' },
          h(
            'span',
            { class: `badge ${statusClass}`, 'data-testid': 'de-status', title: doc.error ?? '' },
            statusText,
          ),
          doc.status === 'failed' || doc.status === 'stopped'
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-primary',
                  'aria-label': `Retry ${label}`,
                  title: doc.error ?? 'Retry',
                  'data-focus-key': `retry:${doc.key}`,
                  'data-testid': 'de-retry',
                  onclick: () => options.onRetry(doc),
                },
                icon('arrow-clockwise'),
              )
            : null,
        ),
        doc.error ? h('div', { class: 'small text-danger-emphasis text-wrap' }, doc.error) : null,
      ),
      h(
        'td',
        { class: 'or-grid-narrow' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-link p-0 text-start d-inline-flex align-items-center gap-1',
            'aria-label': `Show the source of ${label}: ${doc.fileName}, ${plural(doc.pages.length, 'page')} ${doc.pages.join(', ')}`,
            'data-focus-key': `source:${doc.key}`,
            'data-testid': 'de-source',
            onclick: () => options.onSource(doc),
          },
          icon('file-earmark-image'),
          h('span', { class: 'text-truncate d-inline-block or-grid-source' }, doc.fileName),
          doc.pageCount > 1
            ? h('span', { class: 'text-body-secondary' }, `p. ${doc.pages.join(', ')}`)
            : null,
        ),
      ),
      fields.map((field) => {
        if (!done) return h('td', { class: 'text-body-secondary' }, '');
        const fieldName = fieldLabel(field.name);
        if (field.type === 'table') {
          const items = doc.values[field.name];
          const count = Array.isArray(items) ? items.length : 0;
          const key = `${doc.key}:${field.name}`;
          const open = expanded.has(key);
          const tableIssues =
            Object.keys(doc.issues).some((issue) => issue.startsWith(`${field.name}[`)) ||
            doc.issues[field.name] !== undefined;
          return h(
            'td',
            null,
            h(
              'button',
              {
                type: 'button',
                class: [
                  'btn btn-sm d-inline-flex align-items-center gap-1',
                  tableIssues ? 'btn-outline-warning' : 'btn-outline-secondary',
                ],
                'aria-expanded': String(open),
                'aria-controls': detailId(doc, field),
                'aria-label': `${fieldName} of ${label}: ${plural(count, 'row')}`,
                'data-focus-key': `expand:${key}`,
                'data-testid': 'de-expand',
                onclick: () => {
                  if (open) expanded.delete(key);
                  else expanded.add(key);
                  update(doc);
                },
              },
              icon(open ? 'chevron-up' : 'chevron-down'),
              plural(count, 'row'),
            ),
          );
        }
        return h(
          'td',
          null,
          editor(
            field,
            doc.values[field.name],
            `${fieldName}, ${label}`,
            `cell:${doc.key}:${field.name}`,
            doc.issues[field.name],
            commitField(doc, field),
          ),
        );
      }),
      h('td', { class: 'or-grid-narrow', 'data-issues-cell': '' }, issuesBadge(doc)),
    );
  };

  const detailRows = (doc: DocResult, fields: readonly FieldDef[]): HTMLElement[] =>
    fields
      .filter(
        (field) =>
          field.type === 'table' &&
          expanded.has(`${doc.key}:${field.name}`) &&
          doc.status === 'done',
      )
      .map((field) => {
        const columns = field.columns ?? [];
        const items = Array.isArray(doc.values[field.name])
          ? (doc.values[field.name] as Record<string, unknown>[])
          : [];
        const label = `${fieldLabel(field.name)} of document ${doc.index}`;
        const addItem = (): void => {
          const next = Array.isArray(doc.values[field.name])
            ? [...(doc.values[field.name] as Record<string, unknown>[])]
            : [];
          next.push(Object.fromEntries(columns.map((column) => [column.name, null])));
          doc.values[field.name] = next;
          if (!doc.edited.includes(field.name)) doc.edited.push(field.name);
          delete doc.issues[field.name];
          options.onEdit(doc);
          update(doc, `item:${doc.key}:${field.name}:${next.length - 1}:0`);
        };
        const removeItem = (row: number): void => {
          const next = items.filter((_, index) => index !== row);
          doc.values[field.name] = next;
          // Cell issues are keyed by row: drop this row's, shift the later ones up.
          for (const key of Object.keys(doc.issues)) {
            const match = new RegExp(`^${field.name}\\[(\\d+)\\]\\.(.+)$`).exec(key);
            if (!match) continue;
            const index = Number(match[1]);
            const issue = doc.issues[key]!;
            delete doc.issues[key];
            if (index > row) doc.issues[`${field.name}[${index - 1}].${match[2]}`] = issue;
            else if (index < row) doc.issues[key] = issue;
          }
          if (field.required && next.length === 0)
            doc.issues[field.name] = 'Required, but not found.';
          if (!doc.edited.includes(field.name)) doc.edited.push(field.name);
          options.onEdit(doc);
          update(doc, `add:${doc.key}:${field.name}`);
        };
        return h(
          'tr',
          { class: 'or-grid-detail', dataset: { detailFor: doc.key }, 'data-testid': 'de-detail' },
          h(
            'td',
            { colSpan: fields.length + 4, id: detailId(doc, field) },
            h(
              'div',
              { class: 'vstack gap-2 p-1' },
              h('div', { class: 'fw-semibold small' }, label),
              h(
                'div',
                { class: 'table-responsive position-relative' },
                h(
                  'table',
                  {
                    class: 'table table-sm mb-0 or-grid',
                    'aria-label': label,
                    'data-testid': 'de-items',
                  },
                  h(
                    'thead',
                    null,
                    h(
                      'tr',
                      null,
                      h('th', { scope: 'col', class: 'or-grid-narrow' }, '#'),
                      columns.map((column) => h('th', { scope: 'col' }, fieldLabel(column.name))),
                      h(
                        'th',
                        { scope: 'col', class: 'or-grid-narrow' },
                        h('span', { class: 'visually-hidden' }, 'Remove'),
                      ),
                    ),
                  ),
                  h(
                    'tbody',
                    null,
                    items.map((item, row) =>
                      h(
                        'tr',
                        { 'data-testid': 'de-item' },
                        h('th', { scope: 'row', class: 'or-grid-narrow' }, String(row + 1)),
                        columns.map((column, c) =>
                          h(
                            'td',
                            null,
                            editor(
                              column,
                              item[column.name],
                              `${fieldLabel(column.name)}, row ${row + 1}, ${label}`,
                              `item:${doc.key}:${field.name}:${row}:${c}`,
                              doc.issues[`${field.name}[${row}].${column.name}`],
                              commitCell(doc, field, row, column),
                            ),
                          ),
                        ),
                        h(
                          'td',
                          { class: 'or-grid-narrow' },
                          h(
                            'button',
                            {
                              type: 'button',
                              class: 'btn btn-sm btn-outline-secondary',
                              'aria-label': `Remove row ${row + 1} of ${label}`,
                              'data-focus-key': `remove:${doc.key}:${field.name}:${row}`,
                              onclick: () => removeItem(row),
                            },
                            icon('trash'),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              h(
                'div',
                null,
                h(
                  'button',
                  {
                    type: 'button',
                    class:
                      'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
                    'data-focus-key': `add:${doc.key}:${field.name}`,
                    'data-testid': 'de-add-item',
                    onclick: addItem,
                  },
                  icon('plus-lg'),
                  'Add row',
                ),
              ),
            ),
          ),
        );
      });

  const rowsOf = (doc: DocResult): HTMLElement[] => {
    const fields = options.fields();
    return [mainRow(doc, fields), ...detailRows(doc, fields)];
  };

  function update(doc: DocResult, focusKey?: string): void {
    const main = body.querySelector<HTMLElement>(`tr[data-doc-key="${doc.key}"]`);
    if (!main) return;
    const old = [main, ...body.querySelectorAll<HTMLElement>(`tr[data-detail-for="${doc.key}"]`)];
    const active = document.activeElement;
    const keyed = old.some((row) => row.contains(active))
      ? (active?.closest('[data-focus-key]')?.getAttribute('data-focus-key') ?? null)
      : null;
    const fresh = rowsOf(doc);
    main.before(...fresh);
    for (const row of old) row.remove();
    const wanted = focusKey ?? keyed;
    if (wanted) {
      [...body.querySelectorAll<HTMLElement>('[data-focus-key]')]
        .find((candidate) => candidate.getAttribute('data-focus-key') === wanted)
        ?.focus();
    }
  }

  return {
    element,
    render(next) {
      docs = next;
      const fields = options.fields();
      for (const key of [...drafts.keys()])
        if (!docs.some((doc) => key.includes(`:${doc.key}:`))) drafts.delete(key);
      head.replaceChildren(
        h(
          'tr',
          null,
          h('th', { scope: 'col', class: 'or-grid-narrow' }, '#'),
          h('th', { scope: 'col', class: 'or-grid-narrow' }, 'Status'),
          h('th', { scope: 'col', class: 'or-grid-narrow' }, 'Source'),
          fields.map((field) =>
            h(
              'th',
              { scope: 'col', title: field.description },
              fieldLabel(field.name),
              field.required
                ? [
                    h('span', { class: 'text-danger-emphasis', 'aria-hidden': 'true' }, ' *'),
                    h('span', { class: 'visually-hidden' }, ' (required)'),
                  ]
                : null,
            ),
          ),
          h('th', { scope: 'col', class: 'or-grid-narrow' }, 'Check'),
        ),
      );
      body.replaceChildren(...docs.flatMap(rowsOf));
    },
    update: (doc) => update(doc),
  };
}
