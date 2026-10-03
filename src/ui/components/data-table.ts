/**
 * `dataTable()`: the scaffold every table here shares. A scroller (`table-responsive position-relative`, because a
 * `.visually-hidden` caption or header is absolutely positioned and would otherwise escape the overflow and widen
 * the page on phones) that is a focusable `region` with a name (so keyboard users can scroll it), a `<table>`
 * with an optional visually hidden caption, column headers with `scope="col"`, and body rows whose first cell is
 * a row header (`th scope="row"`). Columns from `numericFrom` on are right-aligned, header and cells alike.
 *
 * ```ts
 * dataTable({
 *   scrollerLabel: 'Usage by model',
 *   head: ['Model', 'Requests', 'Cost'],
 *   numericFrom: 1,
 *   rows: [['openai/gpt-6', '3', '$0.02']],
 * });
 * ```
 *
 * `rows` takes cell lists (built into `<tr>`s here) or finished `<tr>`s; a page that re-renders its own rows,
 * or draws several `<tbody>`s, passes them as `body` (and `foot`) instead.
 */
import { type Child, h } from '../dom';

export interface DataTableOptions {
  /** The scroll region's accessible name. */
  scrollerLabel: string;
  /** A visually hidden caption. */
  caption?: string;
  head: readonly Child[];
  /** Body rows: a list of cells (the first is the row header), or a finished `<tr>`. */
  rows?: readonly (HTMLElement | readonly Child[])[];
  /** Your own `<tbody>` element(s), instead of `rows`. */
  body?: Child;
  foot?: Child;
  /** Index of the first right-aligned column. */
  numericFrom?: number;
  /** Classes of the `<table>`; default `table align-middle mb-0`. */
  class?: string;
  /** Classes of the scroller; default `table-responsive`. */
  scrollerClass?: string;
  testId?: string;
  /** `data-testid` of the rows built from cell lists. */
  rowTestId?: string;
  /** Classes of the row header cell built from a cell list; default `fw-normal`. */
  rowHeaderClass?: string;
  /** Extra classes of the other cells built from a cell list. */
  cellClass?: string;
}

export function dataTable(options: DataTableOptions): HTMLElement {
  const numericFrom = options.numericFrom ?? Infinity;
  const numeric = (index: number): string | false => index >= numericFrom && 'text-end';
  const row = (cells: readonly Child[]): HTMLElement =>
    h(
      'tr',
      { 'data-testid': options.rowTestId },
      cells.map((cell, index) =>
        index === 0
          ? h('th', { scope: 'row', class: options.rowHeaderClass ?? 'fw-normal' }, cell)
          : h('td', { class: [numeric(index), options.cellClass] }, cell),
      ),
    );
  return h(
    'div',
    {
      class: [options.scrollerClass ?? 'table-responsive', 'position-relative'],
      role: 'region',
      tabIndex: 0,
      'aria-label': options.scrollerLabel,
    },
    h(
      'table',
      { class: options.class ?? 'table align-middle mb-0', 'data-testid': options.testId },
      options.caption && h('caption', { class: 'visually-hidden' }, options.caption),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          options.head.map((label, index) =>
            h('th', { scope: 'col', class: [numeric(index)] }, label),
          ),
        ),
      ),
      options.body ??
        h(
          'tbody',
          null,
          (options.rows ?? []).map((cells) => (cells instanceof HTMLElement ? cells : row(cells))),
        ),
      options.foot,
    ),
  );
}
