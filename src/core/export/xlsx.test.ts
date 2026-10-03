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
    expect(sanitizeSheetName('')).toBe('Sheet 1');
    expect(sanitizeSheetName("''")).toBe('Sheet 1');
    expect(sanitizeSheetName('History')).toBe('History_');
    expect(sanitizeSheetName('x'.repeat(40))).toBe('x'.repeat(31));
  });

  it('numbers the fallback by position, and keeps it unique', () => {
    const taken = new Set<string>();
    expect(sanitizeSheetName('Sheet 1', taken)).toBe('Sheet 1');
    expect(sanitizeSheetName('', taken)).toBe('Sheet 2');
    expect(sanitizeSheetName('', taken)).toBe('Sheet 3');
    expect(sanitizeSheetName('', taken, 1)).toBe('Sheet 1 (2)');
  });

  it('removes characters XML cannot hold before anything else', () => {
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    expect(sanitizeSheetName(`a${NUL}b${ESC}c`)).toBe('abc');
    expect(sanitizeSheetName(`${NUL}${ESC}`)).toBe('Sheet 1');
    expect(sanitizeSheetName('tab\there\nnew')).toBe('tab here new');
    expect(sanitizeSheetName(`lone${String.fromCharCode(0xd83d)}surrogate`)).toBe('lonesurrogate');
  });

  it('cuts to 31 characters first, then drops the apostrophes that ends up at the edges', () => {
    expect(sanitizeSheetName(`${'x'.repeat(30)}''`)).toBe('x'.repeat(30));
    expect(sanitizeSheetName(`'${'x'.repeat(29)}'y`)).toBe('x'.repeat(29));
    expect(sanitizeSheetName("it's fine")).toBe("it's fine");
  });

  it('checks uniqueness on the final names, after cutting and cleaning', () => {
    const taken = new Set<string>();
    const a = sanitizeSheetName(`${'x'.repeat(31)}A`, taken);
    const b = sanitizeSheetName(`${'x'.repeat(31)}B`, taken);
    expect(a).toBe('x'.repeat(31));
    expect(b).toBe(`${'x'.repeat(27)} (2)`);
    expect(sanitizeSheetName('Ab/', taken)).toBe('Ab_');
    expect(sanitizeSheetName('AB_', taken)).toBe('AB_ (2)');
    expect(sanitizeSheetName('history', taken)).toBe('history_');
    expect(sanitizeSheetName('HISTORY_', taken)).toBe('HISTORY_ (2)');
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
    expect(xml).toMatch(/<c r="B5" t="s">/); // NaN is never written as a number
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

  /** The cells of the first data row (row 2) of a one-column workbook, as `[type attribute, value]`. */
  async function cellsOf(values: unknown[], type: 'number' | 'date'): Promise<string[]> {
    const files = await open(
      await toXlsx([
        { name: 'T', columns: [{ key: 'v', type }], rows: values.map((v) => ({ v })) },
      ]),
    );
    const xml = files['xl/worksheets/sheet1.xml'] ?? '';
    const strings = [
      ...(files['xl/sharedStrings.xml'] ?? '').matchAll(/<t[^>]*>([^<]*)<\/t>/g),
    ].map((m) => m[1] ?? '');
    return values.map((_, i) => {
      const cell = new RegExp(`<c r="A${i + 2}"([^>]*)><v>([^<]*)</v></c>`).exec(xml);
      if (!cell) return 'none';
      return cell[1]?.includes('t="s"') ? `text:${strings[Number(cell[2])]}` : `value:${cell[2]}`;
    });
  }

  it('writes NaN and infinities as text, never as numbers', async () => {
    expect(await cellsOf([Number.NaN, Infinity, -Infinity, 5], 'number')).toEqual([
      'text:NaN',
      'text:Infinity',
      'text:-Infinity',
      'value:5',
    ]);
  });

  it("converts only canonical decimal strings in a 'number' column", async () => {
    const cells = await cellsOf(
      [
        '0',
        '5',
        '-5',
        '0.5',
        '-0.25',
        '1.50',
        '123456789012345',
        '1234567.12345678',
        '007',
        '00.5',
        '+5',
        '.5',
        '5.',
        '1e5',
        '1,234',
        ' 5',
        '5 ',
        '0x10',
        '1234567890123456',
        '0.1234567890123456',
        '-',
        '',
      ],
      'number',
    );
    expect(cells).toEqual([
      'value:0',
      'value:5',
      'value:-5',
      'value:0.5',
      'value:-0.25',
      'value:1.5',
      'value:123456789012345',
      'value:1234567.12345678', // 15 digits
      'text:007', // leading zeros are an identifier, not a number
      'text:00.5',
      'text:+5',
      'text:.5',
      'text:5.',
      'text:1e5',
      'text:1,234',
      'text: 5',
      'text:5 ',
      'text:0x10',
      'text:1234567890123456', // 16 digits would lose precision
      'text:0.1234567890123456',
      'text:-',
      'none',
    ]);
  });

  it("converts only real calendar dates in a 'date' column", async () => {
    const cells = await cellsOf(
      [
        '2026-03-05',
        '2024-02-29',
        '2026-02-29',
        '2026-02-31',
        '2026-04-31',
        '2026-13-01',
        '2026-00-10',
        '2026-03-00',
        '2026-03-05T10:30',
        '2026-03-05T24:00:00',
        '2026-03-05T10:60:00',
        '2026-03-05T10:30:61',
        '2026-03-05T10:30:00+05:30',
        '2026-03-05 10:30:00',
        '2026-3-5',
      ],
      'date',
    );
    expect(cells).toEqual([
      'value:46086',
      'value:45351',
      'text:2026-02-29',
      'text:2026-02-31',
      'text:2026-04-31',
      'text:2026-13-01',
      'text:2026-00-10',
      'text:2026-03-00',
      expect.stringMatching(/^value:46086\.4375$/),
      'text:2026-03-05T24:00:00',
      'text:2026-03-05T10:60:00',
      'text:2026-03-05T10:30:61',
      expect.stringMatching(/^value:46086\.20/), // 05:00 UTC
      'value:46086.4375',
      'text:2026-3-5',
    ]);
  });

  it('keeps literal _xHHHH_ sequences literal, in cells and sheet names', async () => {
    const files = await open(
      await toXlsx([
        {
          name: 'a_x0041_b',
          columns: ['_x0042_'],
          rows: [{ _x0042_: 'x_x0043_y _X0044_ _x00G0_' }],
        },
      ]),
    );
    const strings = files['xl/sharedStrings.xml'] ?? '';
    // Excel reads _xHHHH_ as an escaped character, so each underscore that starts one is itself escaped.
    expect(strings).toContain('<t>_x005F_x0042_</t>');
    expect(strings).toContain('<t>x_x005F_x0043_y _x005F_X0044_ _x00G0_</t>');
    expect(files['xl/workbook.xml']).toContain('name="a_x005F_x0041_b"');
  });

  it('needs at least one sheet', async () => {
    await expect(toXlsx([])).rejects.toThrow(/at least one sheet/);
  });
});
