/**
 * Tables as files: CSV per table (a ZIP when there are several), one Excel workbook with a sheet per table,
 * Markdown, and TSV for pasting into a spreadsheet. Built on src/core/export, so CSV and TSV defuse formulas.
 * Numeric columns become number cells in the workbook.
 */
import {
  type ExportColumn,
  type ExportRow,
  toCsv,
  toMarkdownTable,
  toTsv,
} from '../../core/export/table';
import type { XlsxSheet } from '../../core/export/xlsx';
import type { ZipEntry } from '../../core/export/zip';
import { sanitizeFilename } from '../../core/files';
import { cellNumber, type ExtractedTable, numericColumns, pagesLabel } from './tables';

function columns(table: ExtractedTable): ExportColumn[] {
  return table.headers.map((header, c) => ({ key: `c${c}`, header }));
}

/** Excel keeps 15 significant digits; a longer number would be silently rounded. */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * A cell of a numeric column as it goes to the workbook. Plain digits (`42`, `007`, `1.50`, a 20-digit id) go on to
 * the core writer as written, and its canonical check decides: `42` and `1.50` (as 1.5) become numbers, `007` and
 * a 20-digit id stay text. A formatted number
 * (`1,200`, `$12`, `(4)`) becomes a number only when nothing written is lost either: no sign but a minus, no
 * leading zero, no trailing zero after the decimal mark, at most 15 significant digits. Phone numbers (`+1555…`)
 * and codes stay as written.
 */
export function workbookValue(text: string): string | number {
  const value = text.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value) || /^\+/.test(value.replace(/^\(/, ''))) return text;
  const number = cellNumber(value);
  if (number === null) return text;
  const digits = value.replace(/[^\d.]/g, '');
  const [whole = '', fraction = ''] = digits.split('.');
  const significant = `${whole}${fraction}`.replace(/^0+/, '');
  if (/^0\d/.test(whole) || /0$/.test(fraction) || significant.length > MAX_SIGNIFICANT_DIGITS)
    return text;
  return number;
}

function rows(table: ExtractedTable, numbers = false): ExportRow[] {
  const numeric = numbers ? numericColumns(table) : [];
  return table.rows.map((row) =>
    Object.fromEntries(
      table.headers.map((_, c) => {
        const text = row[c] ?? '';
        return [`c${c}`, numeric[c] ? workbookValue(text) : text];
      }),
    ),
  );
}

/** Text safe inside a Markdown line: one line, with the characters Markdown reads as syntax escaped. */
function inlineMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]#|<>~]/g, '\\$&');
}

/** A table's title, or `Table N` when it has none. */
export function tableTitle(table: ExtractedTable, position: number): string {
  return table.title.trim() || `Table ${position}`;
}

export function tableCsv(table: ExtractedTable): string {
  return toCsv(rows(table), columns(table));
}

/** Tab-separated, for the clipboard (formulas defused, header row first). */
export function tableTsv(table: ExtractedTable): string {
  return toTsv(rows(table), columns(table));
}

/** The tables as Markdown (export and run output): titles, file names and notes escaped so they stay text. */
export function tablesMarkdown(tables: readonly ExtractedTable[]): string {
  return tables
    .map((table, index) => {
      const where = [table.fileName, pagesLabel(table)].filter(Boolean).join(', ');
      const parts = [
        `## ${inlineMarkdown(tableTitle(table, index + 1))}`,
        `*${inlineMarkdown(where)}*`,
        toMarkdownTable(rows(table), columns(table)),
      ];
      const notes = table.notes.split(/\r?\n/).map(inlineMarkdown).filter(Boolean).join('\n');
      if (notes) parts.push(notes);
      return parts.join('\n\n');
    })
    .join('\n\n');
}

/** A file name stem for one table: `2-quarterly-revenue`. */
export function tableStem(table: ExtractedTable, position: number): string {
  const slug = table.title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return sanitizeFilename(`${position}-${slug || 'table'}`);
}

export function csvEntries(tables: readonly ExtractedTable[]): ZipEntry[] {
  return tables.map((table, index) => ({
    name: `${tableStem(table, index + 1)}.csv`,
    data: tableCsv(table),
  }));
}

export function xlsxSheets(tables: readonly ExtractedTable[]): XlsxSheet[] {
  return tables.map((table, index) => {
    const numeric = numericColumns(table);
    return {
      // toXlsx makes the name valid and unique (31 characters, no []:*?/\).
      name: tableTitle(table, index + 1),
      columns: table.headers.map((header, c) => ({
        key: `c${c}`,
        header,
        ...(numeric[c] ? { type: 'number' as const } : {}),
      })),
      rows: rows(table, true),
    };
  });
}

export async function tablesWorkbook(tables: readonly ExtractedTable[]): Promise<Blob> {
  const { toXlsx } = await import('../../core/export/xlsx');
  return toXlsx(xlsxSheets(tables));
}

export async function csvZip(tables: readonly ExtractedTable[]): Promise<Blob> {
  const { zipFiles } = await import('../../core/export/zip');
  return zipFiles(csvEntries(tables));
}
