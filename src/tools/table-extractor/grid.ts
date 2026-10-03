/**
 * One editable table: title, header cells, data cells, add/remove rows and columns, merge with the table that
 * continues on the next page, delete, copy as TSV.
 *
 * Typing edits the table in place on every keystroke (`input`), so a click elsewhere (Download, Add row, Merge)
 * or a redraw never loses text; renames update every label of the card in place. Shape changes hand a new table
 * to `onReplace`, and the tool redraws that card (focus kept by data-focus-key).
 *
 * The grid is one Tab stop: the arrow keys move between its cells and buttons (left and right only when the
 * caret is at the edge of the text), so a big table is not hundreds of Tab presses to get past.
 */
import { h } from '../../ui/dom';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icon';
import { uid } from '../../ui/id';
import { tableTitle } from './export';
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

export interface TableCard {
  readonly element: HTMLElement;
  readonly table: ExtractedTable;
  /** Adds or removes "Merge with next page" without redrawing the card. */
  setCanMerge(value: boolean): void;
  /** The table's place in the list moved: names that use it (`Table 3`) follow. */
  setPosition(position: number): void;
}

/** The control that is the grid's Tab stop, per table, so a redrawn card keeps it. */
const tabStops = new Map<string, string>();

export function tableCard(table: ExtractedTable, options: TableCardOptions): TableCard {
  let position = options.position;
  const name = (): string => tableTitle(table, position);
  const key = (suffix: string): string => `${table.id}:${suffix}`;
  /** Label updates, run after a rename (title or header) so every name stays current. */
  const labels: (() => void)[] = [];
  const labelled = <T extends HTMLElement>(element: T, update: (element: T) => void): T => {
    update(element);
    labels.push(() => update(element));
    return element;
  };
  const relabel = (): void => {
    for (const update of labels) update();
  };

  const meta = h('span', { class: 'small text-body-secondary', 'data-testid': 'te-table-meta' });
  meta.textContent = [
    table.fileName,
    pagesLabel(table),
    `${plural(table.rows.length, 'row')} × ${plural(table.headers.length, 'column')}`,
  ]
    .filter(Boolean)
    .join(' · ');

  /** An icon button named by `label` (which says which table). */
  const iconButton = (
    label: () => string,
    iconName: string,
    focusKey: string,
    onClick: () => void,
    testId: string,
  ): HTMLButtonElement =>
    labelled(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
          'data-focus-key': key(focusKey),
          'data-testid': testId,
          onclick: onClick,
        },
        icon(iconName),
      ),
      (button) => {
        button.setAttribute('aria-label', label());
        button.title = label();
      },
    );

  /** A button with visible text; the table's name follows it for screen readers (`Add row to Revenue`). */
  const textButton = (
    text: string,
    joiner: string,
    iconName: string,
    focusKey: string,
    onClick: () => void,
    testId: string,
  ): HTMLButtonElement => {
    const suffix = labelled(h('span', { class: 'visually-hidden' }), (span) => {
      span.textContent = `${joiner}${name()}`;
    });
    return h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
        'data-focus-key': key(focusKey),
        'data-testid': testId,
        onclick: onClick,
      },
      icon(iconName),
      h('span', null, text, suffix),
    );
  };

  const title = labelled(
    h('input', {
      type: 'text',
      class: 'form-control form-control-sm fw-semibold',
      value: table.title,
      'data-focus-key': key('title'),
      'data-testid': 'te-title',
      oninput: () => {
        table.title = title.value;
        relabel();
      },
      onchange: () => {
        table.title = title.value.trim();
        relabel();
      },
    }),
    (element) => element.setAttribute('aria-label', `Title of table ${position}`),
  );

  const headerCells = table.headers.map((header, c) => {
    const input = labelled(
      h('input', {
        type: 'text',
        class: 'form-control form-control-sm fw-semibold',
        value: header,
        'data-focus-key': key(`h:${c}`),
        'data-testid': 'te-header',
        oninput: () => {
          table.headers[c] = input.value;
        },
        onchange: () => {
          renameHeader(table, c, input.value);
          input.value = table.headers[c] ?? '';
          relabel();
        },
      }),
      (element) => element.setAttribute('aria-label', `Header of column ${c + 1}, ${name()}`),
    );
    return h('th', { scope: 'col' }, input);
  });

  // Remove-column buttons sit in their own row of plain cells, so they are no part of any column's header.
  const removeColumnCells =
    table.headers.length > 1
      ? table.headers.map((_, c) =>
          h(
            'td',
            { class: 'text-center py-0' },
            iconButton(
              () => `Remove column ${table.headers[c] || `${c + 1}`} of ${name()}`,
              'x-lg',
              `rmcol:${c}`,
              () => options.onReplace(removeColumn(table, c), key(`h:${Math.max(0, c - 1)}`)),
              'te-remove-column',
            ),
          ),
        )
      : null;

  const body = table.rows.map((row, r) =>
    h(
      'tr',
      { 'data-testid': 'te-row' },
      h('th', { scope: 'row', class: 'or-grid-narrow text-body-secondary' }, String(r + 1)),
      table.headers.map((_, c) => {
        const input = labelled(
          h('input', {
            type: 'text',
            class: 'form-control form-control-sm',
            value: row[c] ?? '',
            'data-focus-key': key(`c:${r}:${c}`),
            'data-testid': 'te-cell',
            oninput: () => setCell(table, r, c, input.value),
          }),
          (element) =>
            element.setAttribute(
              'aria-label',
              `${table.headers[c] || `Column ${c + 1}`}, row ${r + 1}, ${name()}`,
            ),
        );
        return h('td', null, input);
      }),
      h(
        'td',
        { class: 'or-grid-narrow' },
        iconButton(
          () => `Remove row ${r + 1} of ${name()}`,
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

  const hintId = uid('te-grid-hint');
  const grid = labelled(
    h(
      'table',
      { class: 'table table-sm or-grid', 'aria-describedby': hintId },
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
            iconButton(
              () => `Add a column to ${name()}`,
              'plus-lg',
              'addcol',
              () => options.onReplace(addColumn(table), key(`h:${table.headers.length}`)),
              'te-add-column',
            ),
          ),
        ),
        removeColumnCells ? h('tr', null, h('td'), removeColumnCells, h('td')) : null,
      ),
      h('tbody', null, body),
    ),
    (element) => element.setAttribute('aria-label', name()),
  );
  rovingGrid(grid, table.id);

  const mergeButton = textButton(
    'Merge with next page',
    ': ',
    'arrows-collapse',
    'merge',
    () => options.onMerge(table),
    'te-merge',
  );
  const deleteButton = textButton(
    'Delete table',
    ' ',
    'trash',
    'delete',
    () => options.onDelete(table),
    'te-delete',
  );
  const setCanMerge = (value: boolean): void => {
    if (!value) mergeButton.remove();
    else if (!mergeButton.isConnected || mergeButton.nextElementSibling !== deleteButton)
      deleteButton.before(mergeButton);
  };

  const element = h(
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
        'p',
        { id: hintId, class: 'visually-hidden' },
        'Use the arrow keys to move between cells; Tab leaves the table.',
      ),
      h('div', { class: 'table-responsive position-relative' }, grid),
      table.notes
        ? h('p', { class: 'small text-body-secondary mb-0 text-break' }, table.notes)
        : null,
      h(
        'div',
        { class: 'd-flex flex-wrap gap-2' },
        textButton(
          'Add row',
          ' to ',
          'plus-lg',
          'addrow',
          () => options.onReplace(addRow(table), key(`c:${table.rows.length}:0`)),
          'te-add-row',
        ),
        textButton(
          'Copy for a spreadsheet',
          ': ',
          'clipboard',
          'copy',
          () => options.onCopy(table),
          'te-copy',
        ),
        options.canMerge ? mergeButton : null,
        deleteButton,
      ),
    ),
  );
  return {
    element,
    table,
    setCanMerge,
    setPosition(next) {
      if (next === position) return;
      position = next;
      relabel();
    },
  };
}

/**
 * Makes a table's inputs and buttons one Tab stop (roving tabindex) and moves between them with the arrow keys:
 * up and down by row (same position in the row), left and right within a row, for text only from the edge of the
 * text so the caret still moves inside a cell.
 */
function rovingGrid(table: HTMLTableElement, id: string): void {
  const controls = (): HTMLElement[] => [...table.querySelectorAll<HTMLElement>('input, button')];
  const rows = (): HTMLElement[][] =>
    [...table.rows]
      .map((row) => [...row.querySelectorAll<HTMLElement>('input, button')])
      .filter((row) => row.length > 0);
  const makeStop = (target: HTMLElement): void => {
    for (const control of controls()) control.tabIndex = control === target ? 0 : -1;
    const focusKey = target.getAttribute('data-focus-key');
    if (focusKey) tabStops.set(id, focusKey);
  };
  const remembered = tabStops.get(id);
  const all = controls();
  makeStop(all.find((control) => control.getAttribute('data-focus-key') === remembered) ?? all[0]!);

  table.addEventListener('focusin', (event) => {
    if (event.target instanceof HTMLElement && controls().includes(event.target))
      makeStop(event.target);
  });
  table.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const grid = rows();
    const r = grid.findIndex((row) => row.includes(target));
    if (r < 0) return;
    const c = grid[r]!.indexOf(target);
    const text = target instanceof HTMLInputElement ? target : null;
    const atStart = !text || (text.selectionStart === 0 && text.selectionEnd === 0);
    const atEnd =
      !text ||
      (text.selectionStart === text.value.length && text.selectionEnd === text.value.length);
    let next: HTMLElement | undefined;
    if (event.key === 'ArrowUp' && r > 0) next = grid[r - 1]![Math.min(c, grid[r - 1]!.length - 1)];
    else if (event.key === 'ArrowDown' && r < grid.length - 1)
      next = grid[r + 1]![Math.min(c, grid[r + 1]!.length - 1)];
    else if (event.key === 'ArrowLeft' && atStart) next = grid[r]![c - 1];
    else if (event.key === 'ArrowRight' && atEnd) next = grid[r]![c + 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (next instanceof HTMLInputElement) next.select();
  });
}
