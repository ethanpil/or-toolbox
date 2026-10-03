// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cellText, toCsv, toJsonBlob, toMarkdownTable, toTsv } from './table';

const columns = ['name', { key: 'note', header: 'Note' }];

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
    const csv = toCsv(
      [
        { name: 'a', note: 'b' },
        { name: 'c', note: 'd' },
      ],
      columns,
    );
    expect(csv).toBe('name,Note\r\na,b\r\nc,d');
  });

  it('quotes fields with commas, quotes and line breaks (RFC 4180)', () => {
    const csv = toCsv(
      [
        { name: 'Smith, John', note: 'He said "hi"' },
        { name: 'two\nlines', note: 'cr\rhere' },
        { name: ' padded ', note: '' },
      ],
      columns,
    );
    expect(csv).toBe(
      ['name,Note', '"Smith, John","He said ""hi"""', '"two\nlines","cr\rhere"', ' padded ,'].join(
        '\r\n',
      ),
    );
  });

  it('quotes headers too', () => {
    expect(toCsv([], [{ key: 'a', header: 'Total, EUR' }])).toBe('"Total, EUR"');
  });

  it('writes empty cells for missing keys, null and undefined, and typed values as text', () => {
    const csv = toCsv(
      [{ n: 1, ok: false, when: new Date('2026-01-02T00:00:00Z'), gone: null }],
      ['n', 'ok', 'when', 'gone', 'missing'],
    );
    expect(csv.split('\r\n')[1]).toBe('1,false,2026-01-02T00:00:00.000Z,,');
  });

  it('can start with a byte order mark and can leave out the header', () => {
    const rows = [{ name: 'é' }];
    expect(toCsv(rows, ['name'], { bom: true })).toBe('﻿name\r\né');
    expect(toCsv(rows, ['name'], { header: false })).toBe('é');
    expect(new TextEncoder().encode(toCsv(rows, ['name'], { bom: true })).slice(0, 3)).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf]),
    );
  });

  it('defuses formulas only when asked, and never for numbers or plain numeric text', () => {
    const rows = [
      { a: '=1+1', b: '-12.50', c: -5, d: '+1 555 0100', e: '@SUM(A1)', f: 'ok', g: '\tx' },
    ];
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    expect(toCsv(rows, keys, { header: false })).toBe('=1+1,-12.50,-5,+1 555 0100,@SUM(A1),ok,\tx');
    expect(toCsv(rows, keys, { header: false, formulaSafe: true })).toBe(
      "'=1+1,-12.50,-5,'+1 555 0100,'@SUM(A1),ok,'\tx",
    );
  });

  it('writes just the header for no rows', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
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
