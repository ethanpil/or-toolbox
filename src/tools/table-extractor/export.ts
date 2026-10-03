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

function rows(table: ExtractedTable, numbers = false): ExportRow[] {
  const numeric = numbers ? numericColumns(table) : [];
  return table.rows.map((row) =>
    Object.fromEntries(
      table.headers.map((_, c) => {
        const text = row[c] ?? '';
        return [`c${c}`, numeric[c] ? (cellNumber(text) ?? text) : text];
      }),
    ),
  );
}

export function tableCsv(table: ExtractedTable): string {
  return toCsv(rows(table), columns(table));
}

/** Tab-separated, for the clipboard (formulas defused, header row first). */
export function tableTsv(table: ExtractedTable): string {
  return toTsv(rows(table), columns(table));
}

export function tablesMarkdown(tables: readonly ExtractedTable[]): string {
  return tables
    .map((table) => {
      const where = [table.fileName, pagesLabel(table)].filter(Boolean).join(', ');
      const parts = [
        `## ${table.title}`,
        `*${where}*`,
        toMarkdownTable(rows(table), columns(table)),
      ];
      if (table.notes.trim()) parts.push(table.notes.trim());
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
      name: table.title || `Table ${index + 1}`,
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
