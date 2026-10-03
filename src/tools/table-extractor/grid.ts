/**
 * One editable table: title, header cells, data cells, add/remove rows and columns, merge with the table that
 * continues on the next page, delete, copy as TSV. Typing edits the table in place (exports read it at click
 * time); shape changes hand a new table to `onReplace`, and the tool redraws (focus kept by data-focus-key).
 */
import { h } from '../../ui/dom';
import { icon } from '../../ui/icon';
import { plural } from '../../ui/format';
import {
  addColumn,
  addRow,
  type ExtractedTable,
  pagesLabel,
  removeColumn,
  removeRow,
  renameHeader,
  setCell,
} from './tables';

export interface TableCardOptions {
  position: number;
  canMerge: boolean;
  /** The table changed shape; `focusKey` is the control to focus once redrawn. */
  onReplace: (table: ExtractedTable, focusKey?: string) => void;
  onDelete: (table: ExtractedTable) => void;
  onMerge: (table: ExtractedTable) => void;
  onCopy: (table: ExtractedTable) => void;
}

export function tableCard(table: ExtractedTable, options: TableCardOptions): HTMLElement {
  const name = (): string => table.title || `Table ${options.position}`;
  const key = (suffix: string): string => `${table.id}:${suffix}`;
  const meta = h('span', { class: 'small text-body-secondary', 'data-testid': 'te-table-meta' });
  const renderMeta = (): void => {
    meta.textContent = [
      table.fileName,
      pagesLabel(table),
      `${plural(table.rows.length, 'row')} × ${plural(table.headers.length, 'column')}`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  renderMeta();

  const smallButton = (
    label: string,
    iconName: string,
    focusKey: string,
    onClick: () => void,
    testId?: string,
    text?: string,
  ): HTMLButtonElement =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        ...(text ? {} : { 'aria-label': label, title: label }),
        'data-focus-key': key(focusKey),
        ...(testId ? { 'data-testid': testId } : {}),
        onclick: onClick,
      },
      icon(iconName),
      text ?? null,
    );

  const title = h('input', {
    type: 'text',
    class: 'form-control form-control-sm fw-semibold',
    value: table.title,
    'aria-label': `Title of table ${options.position}`,
    'data-focus-key': key('title'),
    'data-testid': 'te-title',
    onchange: () => {
      table.title = title.value.trim();
    },
  });

  const headerCells = table.headers.map((header, c) => {
    const input = h('input', {
      type: 'text',
      class: 'form-control form-control-sm fw-semibold',
      value: header,
      'aria-label': `Header of column ${c + 1}, ${name()}`,
      'data-focus-key': key(`h:${c}`),
      'data-testid': 'te-header',
      onchange: () => {
        renameHeader(table, c, input.value);
        input.value = table.headers[c] ?? '';
      },
    });
    return h(
      'th',
      { scope: 'col' },
      h(
        'div',
        { class: 'd-flex gap-1' },
        input,
        table.headers.length > 1
          ? smallButton(
              `Remove column ${c + 1} of ${name()}`,
              'x-lg',
              `rmcol:${c}`,
              () => options.onReplace(removeColumn(table, c), key(`h:${Math.max(0, c - 1)}`)),
              'te-remove-column',
            )
          : null,
      ),
    );
  });

  const body = table.rows.map((row, r) =>
    h(
      'tr',
      { 'data-testid': 'te-row' },
      h('th', { scope: 'row', class: 'or-grid-narrow text-body-secondary' }, String(r + 1)),
      table.headers.map((header, c) => {
        const input = h('input', {
          type: 'text',
          class: 'form-control form-control-sm',
          value: row[c] ?? '',
          'aria-label': `${header || `Column ${c + 1}`}, row ${r + 1}, ${name()}`,
          'data-focus-key': key(`c:${r}:${c}`),
          'data-testid': 'te-cell',
          onchange: () => {
            setCell(table, r, c, input.value);
          },
        });
        return h('td', null, input);
      }),
      h(
        'td',
        { class: 'or-grid-narrow' },
        smallButton(
          `Remove row ${r + 1} of ${name()}`,
          'trash',
          `rmrow:${r}`,
          () => {
            const next = removeRow(table, r);
            options.onReplace(
              next,
              next.rows.length ? key(`rmrow:${Math.min(r, next.rows.length - 1)}`) : key('addrow'),
            );
          },
          'te-remove-row',
        ),
      ),
    ),
  );

  return h(
    'article',
    { class: 'card', 'data-testid': 'te-table', dataset: { tableId: table.id } },
    h(
      'div',
      { class: 'card-header vstack gap-1' },
      h(
        'div',
        { class: 'd-flex flex-wrap align-items-center gap-2' },
        h('div', { class: 'flex-grow-1' }, title),
        table.kind === 'chart' ? h('span', { class: 'badge text-bg-info' }, 'From a chart') : null,
      ),
      meta,
    ),
    h(
      'div',
      { class: 'card-body vstack gap-2 p-2' },
      h(
        'div',
        { class: 'table-responsive position-relative' },
        h(
          'table',
          { class: 'table table-sm or-grid', 'aria-label': name() },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h(
                'th',
                { scope: 'col', class: 'or-grid-narrow' },
                h('span', { class: 'visually-hidden' }, 'Row'),
              ),
              headerCells,
              h(
                'th',
                { scope: 'col', class: 'or-grid-narrow' },
                smallButton(
                  `Add a column to ${name()}`,
                  'plus-lg',
                  'addcol',
                  () => options.onReplace(addColumn(table), key(`h:${table.headers.length}`)),
                  'te-add-column',
                ),
              ),
            ),
          ),
          h('tbody', null, body),
        ),
      ),
      table.notes
        ? h('p', { class: 'small text-body-secondary mb-0 text-break' }, table.notes)
        : null,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        smallButton(
          'Add row',
          'plus-lg',
          'addrow',
          () => options.onReplace(addRow(table), key(`c:${table.rows.length}:0`)),
          'te-add-row',
          'Add row',
        ),
        smallButton(
          'Copy as TSV',
          'clipboard',
          'copy',
          () => options.onCopy(table),
          'te-copy',
          'Copy for a spreadsheet',
        ),
        options.canMerge
          ? smallButton(
              'Merge with the next table',
              'arrows-collapse',
              'merge',
              () => options.onMerge(table),
              'te-merge',
              'Merge with next page',
            )
          : null,
        smallButton(
          `Delete ${name()}`,
          'trash',
          'delete',
          () => options.onDelete(table),
          'te-delete',
          'Delete table',
        ),
      ),
    ),
  );
}
