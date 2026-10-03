/**
 * The Data extractor's results as files: JSON, CSV (documents, one CSV per table field, or flattened with one
 * row per line item) and an Excel workbook ("Documents" plus one sheet per table field, keyed by document
 * number). Everything goes through src/core/export, so CSV formula defusal applies. What is exported is the
 * review grid's current values, corrections included.
 */
import { toCsv, type ExportColumn, type ExportRow } from '../../core/export/table';
import type { XlsxColumn, XlsxSheet } from '../../core/export/xlsx';
import { type ColumnType, type FieldDef, type FieldType, fieldLabel, type Value } from './schema';

export type DocStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/** One row of the review grid: a document (or a page, in "one per page" mode). */
export interface DocResult {
  key: string;
  /** 1-based, the document key in exports. */
  index: number;
  fileId: string;
  fileName: string;
  pages: number[];
  pageCount: number;
  status: DocStatus;
  values: Record<string, Value>;
  /** By field name, or `field[row].column` for a table cell. */
  issues: Record<string, string>;
  /** Cells the user corrected, same keys as `issues`. */
  edited: string[];
  error: string | null;
}

/** "1, 3-4" style page list for a cell. */
export function pagesText(pages: readonly number[]): string {
  return pages.join(', ');
}

const exportable = (docs: readonly DocResult[]): DocResult[] =>
  docs.filter((doc) => doc.status === 'done');

const scalarFields = (fields: readonly FieldDef[]): FieldDef[] =>
  fields.filter((field) => field.type !== 'table');
export const tableFields = (fields: readonly FieldDef[]): FieldDef[] =>
  fields.filter((field) => field.type === 'table');

/** A value as it goes into a table cell: lists joined with "; ", tables left out. */
function cell(value: Value | undefined): unknown {
  if (Array.isArray(value))
    return value.every((item) => typeof item === 'string') ? value.join('; ') : null;
  return value ?? null;
}

const KEY_COLUMNS = ['Document', 'File', 'Pages'];

function keyRow(doc: DocResult): ExportRow {
  return { Document: doc.index, File: doc.fileName, Pages: pagesText(doc.pages) };
}

function xlsxType(type: FieldType | ColumnType): Pick<XlsxColumn, 'type' | 'format'> {
  if (type === 'currency') return { type: 'number', format: '#,##0.00' };
  if (type === 'number') return { type: 'number' };
  if (type === 'date') return { type: 'date' };
  return {};
}

/** One row per document, the non-table fields as columns. */
export function documentTable(
  fields: readonly FieldDef[],
  docs: readonly DocResult[],
): { columns: XlsxColumn[]; rows: ExportRow[] } {
  const scalars = scalarFields(fields);
  return {
    columns: [
      ...KEY_COLUMNS.map((key) => ({ key, header: key })),
      ...scalars.map((field) => ({
        key: `f:${field.name}`,
        header: field.name,
        ...xlsxType(field.type),
      })),
    ],
    rows: exportable(docs).map((doc) => ({
      ...keyRow(doc),
      ...Object.fromEntries(
        scalars.map((field) => [`f:${field.name}`, cell(doc.values[field.name])]),
      ),
    })),
  };
}

/** One row per line of a table field, keyed by the document number. */
export function lineItemTable(
  field: FieldDef,
  docs: readonly DocResult[],
): { columns: XlsxColumn[]; rows: ExportRow[] } {
  const columns = field.columns ?? [];
  const rows: ExportRow[] = [];
  for (const doc of exportable(docs)) {
    const items = doc.values[field.name];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      rows.push({
        Document: doc.index,
        File: doc.fileName,
        ...Object.fromEntries(
          columns.map((column) => [`c:${column.name}`, item[column.name] ?? null]),
        ),
      });
    }
  }
  return {
    columns: [
      { key: 'Document', header: 'Document' },
      { key: 'File', header: 'File' },
      ...columns.map((column) => ({
        key: `c:${column.name}`,
        header: column.name,
        ...xlsxType(column.type),
      })),
    ],
    rows,
  };
}

/** The documents with their table fields flattened: one row per line of the first table field. */
export function flattenedTable(
  fields: readonly FieldDef[],
  docs: readonly DocResult[],
): { columns: XlsxColumn[]; rows: ExportRow[] } {
  const base = documentTable(fields, docs);
  const table = tableFields(fields)[0];
  if (!table) return base;
  const columns = table.columns ?? [];
  const rows: ExportRow[] = [];
  const done = exportable(docs);
  base.rows.forEach((row, index) => {
    const items = done[index]?.values[table.name];
    const list = Array.isArray(items)
      ? items.filter((item) => typeof item === 'object' && item !== null)
      : [];
    if (list.length === 0) rows.push(row);
    for (const item of list) {
      rows.push({
        ...row,
        ...Object.fromEntries(
          columns.map((column) => [`t:${column.name}`, item[column.name] ?? null]),
        ),
      });
    }
  });
  return {
    columns: [
      ...base.columns,
      ...columns.map((column) => ({
        key: `t:${column.name}`,
        header: `${table.name}.${column.name}`,
        ...xlsxType(column.type),
      })),
    ],
    rows,
  };
}

const csvColumns = (columns: readonly XlsxColumn[]): ExportColumn[] =>
  columns.map((column) => ({ key: column.key, header: column.header ?? column.key }));

export function documentsCsv(fields: readonly FieldDef[], docs: readonly DocResult[]): string {
  const table = documentTable(fields, docs);
  return toCsv(table.rows, csvColumns(table.columns));
}

export function lineItemsCsv(field: FieldDef, docs: readonly DocResult[]): string {
  const table = lineItemTable(field, docs);
  return toCsv(table.rows, csvColumns(table.columns));
}

export function flattenedCsv(fields: readonly FieldDef[], docs: readonly DocResult[]): string {
  const table = flattenedTable(fields, docs);
  return toCsv(table.rows, csvColumns(table.columns));
}

/** The workbook's sheets: "Documents", then one per table field ("Line items" for `line_items`). */
export function workbookSheets(
  fields: readonly FieldDef[],
  docs: readonly DocResult[],
): XlsxSheet[] {
  return [
    { name: 'Documents', ...documentTable(fields, docs) },
    ...tableFields(fields).map((field) => ({
      name: fieldLabel(field.name),
      ...lineItemTable(field, docs),
    })),
  ];
}

export async function workbook(
  fields: readonly FieldDef[],
  docs: readonly DocResult[],
): Promise<Blob> {
  const { toXlsx } = await import('../../core/export/xlsx');
  return toXlsx(workbookSheets(fields, docs));
}

/** The run output and the JSON export: one entry per extracted document. */
export function jsonResults(docs: readonly DocResult[]): unknown[] {
  return exportable(docs).map((doc) => ({
    document: doc.index,
    file: doc.fileName,
    pages: doc.pages,
    data: doc.values,
    ...(Object.keys(doc.issues).length ? { issues: doc.issues } : {}),
  }));
}
