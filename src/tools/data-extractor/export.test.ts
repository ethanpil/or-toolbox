import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  type DocResult,
  documentsCsv,
  documentTable,
  flattenedCsv,
  jsonResults,
  lineItemsCsv,
  workbook,
  workbookSheets,
} from './export';
import { presetById } from './presets';
import { normalizeRecord } from './schema';

const fields = presetById('invoice')!.fields;
const lineItems = fields.find((field) => field.name === 'line_items')!;

function doc(
  index: number,
  raw: Record<string, unknown>,
  extra: Partial<DocResult> = {},
): DocResult {
  const { values, issues } = normalizeRecord(fields, raw);
  return {
    key: `k${index}`,
    index,
    fileId: `f${index}`,
    fileName: `receipt-${index}.png`,
    pages: [1],
    pageCount: 1,
    status: 'done',
    values,
    issues,
    edited: [],
    error: null,
    ...extra,
  };
}

const docs = [
  doc(1, {
    vendor_name: '=HYPERLINK("http://evil","click")',
    invoice_date: '2026-10-01',
    total: 12.5,
    line_items: [
      { description: 'Tea', quantity: 2, unit_price: 2.5, amount: 5 },
      { description: '-cmd|calc', quantity: 1, unit_price: 7.5, amount: 7.5 },
    ],
  }),
  doc(2, {
    vendor_name: 'Bakery, "Le Pain"',
    invoice_date: '2026-10-02',
    total: -3,
    line_items: [],
  }),
  doc(3, {}, { status: 'failed', error: 'Mocked error' }),
];

describe('Data extractor exports', () => {
  it('has one row per extracted document, keyed by number, file and pages', () => {
    const table = documentTable(fields, docs);
    expect(table.rows).toHaveLength(2);
    expect(table.columns.map((column) => column.header)).toEqual([
      'Document',
      'File',
      'Pages',
      'vendor_name',
      'vendor_address',
      'invoice_number',
      'invoice_date',
      'due_date',
      'currency',
      'subtotal',
      'tax',
      'total',
      'payment_method',
    ]);
    expect(table.columns.find((column) => column.header === 'total')).toMatchObject({
      type: 'number',
      format: '#,##0.00',
    });
    expect(table.columns.find((column) => column.header === 'invoice_date')).toMatchObject({
      type: 'date',
    });
  });

  it('defuses formulas in CSV and quotes what needs quoting', () => {
    const csv = documentsCsv(fields, docs);
    expect(csv.startsWith('\uFEFFDocument,File,Pages,vendor_name')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""click"")"`);
    expect(csv).toContain('"Bakery, ""Le Pain"""');
    expect(csv).toContain(',-3,'); // a negative number is a number, not a formula
    expect(csv).not.toContain('receipt-3.png');

    const items = lineItemsCsv(lineItems, docs);
    expect(items.split('\r\n')).toEqual([
      '\uFEFFDocument,File,description,quantity,unit_price,amount',
      '1,receipt-1.png,Tea,2,2.5,5',
      "1,receipt-1.png,'-cmd|calc,1,7.5,7.5",
    ]);
  });

  it('flattens to one row per line item, keeping documents without items', () => {
    const lines = flattenedCsv(fields, docs).split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(
      /,payment_method,line_items\.description,line_items\.quantity,line_items\.unit_price,line_items\.amount$/,
    );
    expect(lines[1]).toMatch(/,Tea,2,2\.5,5$/);
    expect(lines[3]).toMatch(/^2,receipt-2\.png,1,/);
  });

  it('builds a workbook with Documents and Line items sheets that Excel can read', async () => {
    expect(workbookSheets(fields, docs).map((sheet) => sheet.name)).toEqual([
      'Documents',
      'Line items',
    ]);
    const blob = await workbook(fields, docs);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const text = (name: string): string => strFromU8(files[name]!);
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
    expect(text('xl/workbook.xml')).toContain('<sheet name="Documents" sheetId="1" r:id="rId1"/>');
    expect(text('xl/workbook.xml')).toContain('<sheet name="Line items" sheetId="2" r:id="rId2"/>');
    const sheet1 = text('xl/worksheets/sheet1.xml');
    // Totals are numeric cells (no t="s"), dates are date-formatted serials, text is shared strings.
    expect(sheet1).toMatch(/<c r="L2" s="\d+"><v>12.5<\/v><\/c>/);
    expect(sheet1).toMatch(/<c r="L3" s="\d+"><v>-3<\/v><\/c>/);
    expect(sheet1).toMatch(/<c r="G2" s="\d+"><v>46296<\/v><\/c>/); // 2026-10-01
    expect(sheet1).toMatch(/<c r="D2" t="s"><v>\d+<\/v><\/c>/);
    expect(text('xl/styles.xml')).toContain('formatCode="yyyy-mm-dd"');
    // XLSX cells are never formulas: the text is kept as written.
    expect(text('xl/sharedStrings.xml')).toContain('<t>=HYPERLINK("http://evil","click")</t>');
    expect(text('xl/worksheets/sheet2.xml')).toMatch(/<c r="A3"><v>1<\/v><\/c>/);
  });

  it('writes the run output as JSON per extracted document', () => {
    const output = jsonResults(docs) as { document: number; data: Record<string, unknown> }[];
    expect(output).toHaveLength(2);
    expect(output[0]).toMatchObject({
      document: 1,
      file: 'receipt-1.png',
      pages: [1],
      data: { total: 12.5 },
    });
  });
});
