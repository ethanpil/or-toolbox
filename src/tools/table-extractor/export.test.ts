import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  csvEntries,
  csvZip,
  tableCsv,
  tablesMarkdown,
  tablesWorkbook,
  tableStem,
  tableTsv,
  xlsxSheets,
} from './export';
import type { ExtractedTable } from './tables';

const table = (extra: Partial<ExtractedTable> = {}): ExtractedTable => ({
  id: 't1',
  title: 'Quarterly revenue',
  kind: 'table',
  fileId: 'f',
  fileName: 'report.pdf',
  firstPage: 2,
  lastPage: 2,
  pageCount: 5,
  headers: ['Region', 'Q1'],
  rows: [
    ['=SUM(A1:A9)', '1,200'],
    ['South\tWest', '-5'],
  ],
  notes: 'EUR thousands',
  ...extra,
});

describe('Table extractor exports', () => {
  it('writes CSV and TSV with formulas defused', () => {
    expect(tableCsv(table()).split('\r\n')).toEqual([
      '\uFEFFRegion,Q1',
      '\'=SUM(A1:A9),"1,200"',
      'South\tWest,-5',
    ]);
    expect(tableTsv(table()).split('\n')).toEqual([
      'Region\tQ1',
      "'=SUM(A1:A9)\t1,200",
      '"South\tWest"\t-5',
    ]);
  });

  it('writes Markdown with titles, where each table came from, and notes', () => {
    const markdown = tablesMarkdown([table(), table({ title: 'Costs', pageCount: 1, notes: '' })]);
    expect(markdown).toContain('## Quarterly revenue\n\n*report.pdf, page 2*\n\n| Region | Q1 |');
    expect(markdown).toContain('EUR thousands');
    expect(markdown).toContain('## Costs\n\n*report.pdf*');
  });

  it('names one CSV per table for the ZIP', async () => {
    const tables = [
      table(),
      table({ id: 't2', title: 'Résumé / 2025?' }),
      table({ id: 't3', title: '' }),
    ];
    expect(csvEntries(tables).map((entry) => entry.name)).toEqual([
      '1-quarterly-revenue.csv',
      '2-resume-2025.csv',
      '3-table.csv',
    ]);
    expect(tableStem(table(), 4)).toBe('4-quarterly-revenue');
    const zip = unzipSync(new Uint8Array(await (await csvZip(tables)).arrayBuffer()));
    expect(Object.keys(zip)).toEqual([
      '1-quarterly-revenue.csv',
      '2-resume-2025.csv',
      '3-table.csv',
    ]);
    expect(strFromU8(zip['1-quarterly-revenue.csv']!)).toContain("'=SUM(A1:A9)");
  });

  it('writes a sheet per table, sanitised names, numeric columns as numbers', async () => {
    const tables = [
      table(),
      table({ id: 't2', title: 'Revenue: [draft] / 2025 — a very long title indeed' }),
    ];
    expect(xlsxSheets(tables)[0]?.columns).toEqual([
      { key: 'c0', header: 'Region' },
      { key: 'c1', header: 'Q1', type: 'number' },
    ]);
    expect(xlsxSheets(tables)[0]?.rows[0]).toEqual({ c0: '=SUM(A1:A9)', c1: 1200 });
    const files = unzipSync(new Uint8Array(await (await tablesWorkbook(tables)).arrayBuffer()));
    const workbook = strFromU8(files['xl/workbook.xml']!);
    expect(workbook).toContain('<sheet name="Quarterly revenue" sheetId="1"');
    expect(workbook).toContain('<sheet name="Revenue_ _draft_ _ 2025 — a ver" sheetId="2"');
    expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).toContain('<c r="B2"><v>1200</v></c>');
  });

  it('never turns identifier-like values into numbers in the workbook', () => {
    const ids = table({
      headers: ['Code'],
      rows: [
        ['007'],
        ['02134'],
        ['12345678901234567890'],
        ['+15551234567'],
        ['1.50'],
        ['$1.50'],
        ['(4.00)'],
        ['$007'],
        ['42'],
        ['1,200'],
        ['$12'],
        ['(4)'],
      ],
    });
    const [sheet] = xlsxSheets([ids]);
    expect(sheet?.rows.map((row) => row['c0'])).toEqual([
      // Plain digits go to the core writer as text; its canonical check decides (007 stays text there).
      '007',
      '02134',
      '12345678901234567890',
      '+15551234567',
      '1.50',
      // Formatted values: a number only when nothing written is lost (no trailing or leading zeros).
      '$1.50',
      '(4.00)',
      '$007',
      '42',
      1200,
      12,
      -4,
    ]);
  });

  it('escapes titles, file names and notes in Markdown, and names untitled tables', () => {
    const markdown = tablesMarkdown([
      table({ title: 'Revenue\n# by *region* | 2025', fileName: 'q*1*|draft.pdf' }),
      table({ title: '', notes: '# not a heading\n| not a row' }),
    ]);
    expect(markdown).toContain(
      '## Revenue \\# by \\*region\\* \\| 2025\n\n*q\\*1\\*\\|draft.pdf, page 2*',
    );
    expect(markdown).toContain('## Table 2\n\n');
    expect(markdown).toContain('\\# not a heading\n\\| not a row');
  });
});
