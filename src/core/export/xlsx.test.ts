// @vitest-environment node
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { sanitizeSheetName, toXlsx } from './xlsx';

async function open(blob: Blob): Promise<Record<string, string>> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

describe('sanitizeSheetName', () => {
  it('replaces characters Excel forbids and trims quotes', () => {
    expect(sanitizeSheetName('Sheet/1:2')).toBe('Sheet_1_2');
    expect(sanitizeSheetName('[a]*b?\\c')).toBe('_a__b__c');
    expect(sanitizeSheetName("'quoted'")).toBe('quoted');
  });

  it('never returns an empty or reserved name, or one over 31 characters', () => {
    expect(sanitizeSheetName('')).toBe('Sheet');
    expect(sanitizeSheetName("''")).toBe('Sheet');
    expect(sanitizeSheetName('History')).toBe('History_');
    expect(sanitizeSheetName('x'.repeat(40))).toBe('x'.repeat(31));
  });

  it('makes names unique ignoring case, within 31 characters', () => {
    const taken = new Set<string>();
    expect(sanitizeSheetName('A', taken)).toBe('A');
    expect(sanitizeSheetName('a', taken)).toBe('a (2)');
    expect(sanitizeSheetName('a', taken)).toBe('a (3)');
    const long = 'x'.repeat(31);
    expect(sanitizeSheetName(long, taken)).toBe(long);
    const second = sanitizeSheetName(long, taken);
    expect(second).toBe(`${'x'.repeat(27)} (2)`);
    expect(second).toHaveLength(31);
  });
});

describe('toXlsx', () => {
  const sheet = {
    name: 'Items',
    columns: [
      'name',
      { key: 'amount', header: 'Amount', type: 'number' as const },
      { key: 'when', type: 'date' as const },
      'ok',
    ],
    rows: [
      { name: 'Tom & Jerry', amount: 12.5, when: new Date(Date.UTC(2026, 2, 5)), ok: true },
      { name: 'x', amount: '7.25', when: '2026-03-06', ok: false },
      { name: 'y', amount: 'n/a', when: 'garbage', ok: null },
      { name: null, amount: Number.NaN, when: '2026-03-07T10:30:00', ok: undefined },
    ],
  };

  it('writes numbers as numbers, dates as dates, booleans as booleans and text as text', async () => {
    const blob = await toXlsx([sheet]);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const files = await open(blob);
    const xml = files['xl/worksheets/sheet1.xml'] ?? '';

    expect(xml).toContain('<c r="B2"><v>12.5</v></c>');
    expect(xml).toMatch(/<c r="C2"[^>]*><v>46086<\/v>/); // 2026-03-05
    expect(xml).toMatch(/<c r="D2" t="b"><v>1<\/v>/);

    expect(xml).toContain('<c r="B3"><v>7.25</v></c>'); // numeric text in a number column
    expect(xml).toMatch(/<c r="C3"[^>]*><v>46087<\/v>/); // ISO date text in a date column
    expect(xml).toMatch(/<c r="D3" t="b"><v>0<\/v>/);

    expect(xml).toMatch(/<c r="B4" t="s">/); // does not parse: stays text
    expect(xml).toMatch(/<c r="C4" t="s">/);
    expect(xml).not.toContain('r="D4"');

    expect(xml).not.toContain('r="A5"'); // null
    expect(xml).not.toContain('r="B5"'); // NaN
    expect(xml).toMatch(/<c r="C5"[^>]*><v>46088\.4375<\/v>/); // date-time without a zone: UTC
    expect(xml).not.toContain('r="D5"');

    const strings = files['xl/sharedStrings.xml'] ?? '';
    for (const text of ['Tom &amp; Jerry', 'Amount', 'n/a', 'garbage'])
      expect(strings).toContain(`<t>${text}</t>`);
  });

  it('formats dates, bolds and freezes the header, and sizes the columns', async () => {
    const files = await open(await toXlsx([sheet]));
    const xml = files['xl/worksheets/sheet1.xml'] ?? '';
    expect(xml).toContain('ySplit="1"');
    expect(xml).toMatch(/<col min="1" max="1" width="13"/); // "Tom & Jerry" is 11 characters, plus 2
    const styles = files['xl/styles.xml'] ?? '';
    expect(styles).toContain('<b/>');
    expect(styles).toContain('formatCode="yyyy-mm-dd"');
    expect(styles).toContain('formatCode="yyyy-mm-dd hh:mm:ss"');
  });

  it('applies a number format and an explicit width', async () => {
    const files = await open(
      await toXlsx([
        {
          name: 'N',
          columns: [{ key: 'v', format: '#,##0.00', width: 20 }],
          rows: [{ v: 1234.5 }],
        },
      ]),
    );
    expect(files['xl/styles.xml']).toContain('formatCode="#,##0.00"');
    expect(files['xl/worksheets/sheet1.xml']).toMatch(/<col min="1" max="1" width="20"/);
  });

  it('writes one worksheet per sheet, with valid unique names', async () => {
    const files = await open(
      await toXlsx([
        { name: 'Sheet/1:2', columns: ['a'], rows: [{ a: 1 }] },
        { name: 'sheet_1_2', columns: ['a'], rows: [] },
        { name: 'History', columns: [], rows: [] },
      ]),
    );
    const workbook = files['xl/workbook.xml'] ?? '';
    expect(workbook).toContain('name="Sheet_1_2"');
    expect(workbook).toContain('name="sheet_1_2 (2)"');
    expect(workbook).toContain('name="History_"');
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        'xl/worksheets/sheet1.xml',
        'xl/worksheets/sheet2.xml',
        'xl/worksheets/sheet3.xml',
      ]),
    );
  });

  it("stores objects as JSON text, cuts text to Excel's cell limit, and never writes formulas", async () => {
    const files = await open(
      await toXlsx([
        {
          name: 'T',
          columns: ['a', 'b', 'c'],
          rows: [{ a: { x: 1 }, b: 'y'.repeat(40000), c: '=SUM(A1:A2)' }],
        },
      ]),
    );
    const strings = files['xl/sharedStrings.xml'] ?? '';
    expect(strings).toContain('<t>{"x":1}</t>');
    expect(strings).toContain(`<t>${'y'.repeat(32767)}</t>`);
    expect(strings).toContain('<t>=SUM(A1:A2)</t>');
    expect(files['xl/worksheets/sheet1.xml']).not.toContain('<f>');
  });

  it('needs at least one sheet', async () => {
    await expect(toXlsx([])).rejects.toThrow(/at least one sheet/);
  });
});
