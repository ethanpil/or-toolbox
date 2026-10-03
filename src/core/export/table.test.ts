// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cellText, toCsv, toJsonBlob, toMarkdownTable, toTsv } from './table';

const columns = ['name', { key: 'note', header: 'Note' }];
const BOM = String.fromCharCode(0xfeff);

/** `toCsv` without the byte order mark, which is on by default. */
const csv = (
  rows: Parameters<typeof toCsv>[0],
  cols: Parameters<typeof toCsv>[1],
  options: Parameters<typeof toCsv>[2] = {},
): string => toCsv(rows, cols, { bom: false, ...options });

describe('cellText', () => {
  it('writes every kind of value as text', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText('x')).toBe('x');
    expect(cellText(12.5)).toBe('12.5');
    expect(cellText(Number.NaN)).toBe('');
    expect(cellText(Infinity)).toBe('');
    expect(cellText(true)).toBe('true');
    expect(cellText(10n)).toBe('10');
    expect(cellText(new Date('2026-03-05T10:00:00Z'))).toBe('2026-03-05T10:00:00.000Z');
    expect(cellText(new Date('nope'))).toBe('');
    expect(cellText({ a: [1, 2] })).toBe('{"a":[1,2]}');
  });
});

describe('toCsv', () => {
  it('writes a header and rows separated by CRLF, with no trailing newline', () => {
    const out = csv(
      [
        { name: 'a', note: 'b' },
        { name: 'c', note: 'd' },
      ],
      columns,
    );
    expect(out).toBe('name,Note\r\na,b\r\nc,d');
  });

  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    const out = csv(
      [
        { name: 'Smith, John', note: 'He said "hi"' },
        { name: 'two\nlines', note: 'cr\rhere' },
        { name: ' padded ', note: '' },
      ],
      columns,
    );
    expect(out).toBe(
      ['name,Note', '"Smith, John","He said ""hi"""', '"two\nlines","cr\rhere"', ' padded ,'].join(
        '\r\n',
      ),
    );
  });

  it('quotes headers too', () => {
    expect(csv([], [{ key: 'a', header: 'Total, EUR' }])).toBe('"Total, EUR"');
  });

  it('writes empty cells for missing keys, null and undefined, and typed values as text', () => {
    const out = csv(
      [{ n: 1, ok: false, when: new Date('2026-01-02T00:00:00Z'), gone: null }],
      ['n', 'ok', 'when', 'gone', 'missing'],
    );
    expect(out.split('\r\n')[1]).toBe('1,false,2026-01-02T00:00:00.000Z,,');
  });

  it('starts with a UTF-8 byte order mark unless told not to, so Excel reads accents right', () => {
    const rows = [{ name: 'é' }];
    expect(toCsv(rows, ['name'])).toBe(`${BOM}name\r\né`);
    expect(new TextEncoder().encode(toCsv(rows, ['name'])).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
    expect(toCsv(rows, ['name'], { bom: false })).toBe('name\r\né');
    expect(toCsv(rows, ['name'], { bom: false, header: false })).toBe('é');
  });

  it('writes just the header for no rows', () => {
    expect(csv([], ['a', 'b'])).toBe('a,b');
  });
});

describe('formula defusing', () => {
  const dangerous = [
    '=1+1',
    '+cmd|calc',
    '-2+3',
    '@SUM(A1)',
    '\t=1',
    '\r=1',
    '=HYPERLINK("x","y")',
  ];

  it('is on by default: text that a spreadsheet would run starts with an apostrophe', () => {
    for (const text of dangerous) {
      const row = csv([{ a: text }], ['a'], { header: false });
      expect(row.replace(/^"|"$/g, '').startsWith("'")).toBe(true);
    }
    expect(csv([{ a: '=1+1' }], ['a'], { header: false })).toBe("'=1+1");
    expect(toTsv([{ a: '=1+1' }], ['a'], { header: false })).toBe("'=1+1");
  });

  it('applies to headers as well', () => {
    expect(csv([], [{ key: 'a', header: '=bad' }])).toBe("'=bad");
  });

  it('leaves numbers alone: typed, or text in any ordinary written form', () => {
    const plain = [
      '-5',
      '+5',
      '-5.5',
      '-.5',
      '-$5.00',
      '-€1,234.56',
      '-£ 5',
      '+1,234.56',
      '(5.00)',
      '5%',
      '-5%',
      '1,234.56',
      '-1e5',
      '0',
    ];
    for (const text of plain) {
      expect(csv([{ a: text }], ['a'], { header: false }).replace(/^"|"$/g, ''), text).toBe(text);
    }
    expect(csv([{ a: -5 }], ['a'], { header: false })).toBe('-5');
  });

  it('leaves phone numbers and other digits-only text as written: they cannot call anything', () => {
    for (const text of [
      '+44 20 7946 0958',
      '+1 (555) 010-9999',
      '-0 12/34',
      '+49.30.1234',
      '--5',
      '-',
    ]) {
      expect(csv([{ a: text }], ['a'], { header: false }).replace(/^"|"$/g, ''), text).toBe(text);
      expect(toTsv([{ a: text }], ['a'], { header: false }), text).toBe(text);
    }
  });

  it('still defuses text that only starts like a number', () => {
    for (const text of [
      '-5+3',
      '-5 USD',
      '+',
      '-$',
      '-5%+1',
      '-1,2,3x',
      '-5\n=1',
      '+44 20 7946 0958|cmd',
      '-1!A1',
      '+"1"',
      "-'1'",
      '-2*3',
    ]) {
      const row = csv([{ a: text }], ['a'], { header: false }).replace(/^"|"$/g, '');
      expect(row.startsWith("'"), text).toBe(true);
    }
  });

  it('can be turned off, and then writes values exactly as they are', () => {
    expect(csv([{ a: '=1+1' }], ['a'], { header: false, formulaSafe: false })).toBe('=1+1');
    expect(toTsv([{ a: '=1+1' }], ['a'], { header: false, formulaSafe: false })).toBe('=1+1');
  });

  it('leaves ordinary text alone, and quoting still works with the apostrophe', () => {
    expect(csv([{ a: 'ok', b: '=a,b' }], ['a', 'b'], { header: false })).toBe('ok,"\'=a,b"');
  });
});

describe('toTsv', () => {
  it('separates with tabs and quotes only what needs it', () => {
    const tsv = toTsv(
      [
        { name: 'a\tb', note: 'say "x"' },
        { name: 'plain, with comma', note: 'two\nlines' },
      ],
      columns,
    );
    expect(tsv).toBe(
      ['name\tNote', '"a\tb"\t"say ""x"""', 'plain, with comma\t"two\nlines"'].join('\n'),
    );
  });
});

describe('toMarkdownTable', () => {
  it('builds a GFM table and escapes pipes, backslashes and line breaks', () => {
    const md = toMarkdownTable(
      [
        { name: 'a|b', note: 'x\ny\\z' },
        { name: 1, note: null },
      ],
      columns,
    );
    expect(md).toBe(
      ['| name | Note |', '| --- | --- |', '| a\\|b | x<br>y\\\\z |', '| 1 |  |'].join('\n'),
    );
  });

  it('returns an empty string without columns', () => {
    expect(toMarkdownTable([{ a: 1 }], [])).toBe('');
  });
});

describe('toJsonBlob', () => {
  it('serialises with two-space indentation', async () => {
    const blob = toJsonBlob({ a: [1, { b: 2 }] });
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{\n  "a": [\n    1,\n    {\n      "b": 2\n    }\n  ]\n}');
    expect(await toJsonBlob([1], 0).text()).toBe('[1]');
  });
});
