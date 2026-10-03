import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addRow,
  canMerge,
  cellNumber,
  describeTables,
  type ExtractedTable,
  mergeTables,
  numericColumns,
  outputMode,
  pageRequest,
  parseTables,
  rectangular,
  removeColumn,
  removeRow,
  renameHeader,
  setCell,
  toTable,
} from './tables';

const table = (extra: Partial<ExtractedTable> = {}): ExtractedTable => ({
  id: 't1',
  title: 'Revenue',
  kind: 'table',
  fileId: 'f',
  fileName: 'report.pdf',
  firstPage: 2,
  lastPage: 2,
  pageCount: 5,
  headers: ['Region', 'Q1', 'Q2'],
  rows: [
    ['North', '120', '135'],
    ['South', '98', '101'],
  ],
  notes: '',
  ...extra,
});

describe('requests', () => {
  it('asks for strict structured tables where supported, JSON mode otherwise', () => {
    const page = {
      fileName: 'r.pdf',
      pageNumber: 2,
      pageCount: 5,
      imageDataUrl: 'data:,',
      text: 'North 120',
    };
    const strict = pageRequest('m', page, {
      charts: true,
      mode: 'schema',
      instructions: '',
      textHint: true,
    });
    expect(strict.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'tables', strict: true },
    });
    expect(strict.provider).toEqual({ require_parameters: true });
    expect(strict.messages[0]!.content).toMatch(/turn every chart into a table/);
    expect(JSON.stringify(strict.messages[1])).toContain('North 120');
    const json = pageRequest('m', page, {
      charts: false,
      mode: 'json',
      instructions: 'Only 2025',
      textHint: false,
    });
    expect(json.response_format).toEqual({ type: 'json_object' });
    expect(json.messages[0]!.content).toMatch(/Ignore charts/);
    expect(json.messages[0]!.content).toMatch(/"additionalProperties":false/);
    expect(json.messages[0]!.content).toMatch(/Only 2025$/);
    expect(outputMode(['structured_outputs'])).toBe('schema');
    expect(outputMode([])).toBe('prompt');
  });
});

describe('parseTables', () => {
  it('reads two tables, as strings, skipping empty ones', () => {
    const parsed = parseTables(
      JSON.stringify({
        tables: [
          {
            title: 'A',
            kind: 'table',
            headers: ['x', 'y'],
            rows: [
              ['1', 2],
              [null, 'z'],
            ],
            notes: '',
          },
          {
            title: 'B',
            kind: 'chart',
            headers: ['Year', 'Sales'],
            rows: [['2025', '10']],
            notes: 'Read from a chart',
          },
          { title: 'Empty', headers: [], rows: [] },
        ],
      }),
    );
    expect(parsed).toEqual({
      tables: [
        {
          title: 'A',
          kind: 'table',
          headers: ['x', 'y'],
          rows: [
            ['1', '2'],
            ['', 'z'],
          ],
          notes: '',
        },
        {
          title: 'B',
          kind: 'chart',
          headers: ['Year', 'Sales'],
          rows: [['2025', '10']],
          notes: 'Read from a chart',
        },
      ],
    });
  });

  it('accepts a bare list, a fenced answer, and says when nothing is usable', () => {
    expect(parseTables('```json\n[{"headers":["a"],"rows":[["1"]]}]\n```')).toMatchObject({
      tables: [{ headers: ['a'] }],
    });
    expect(parseTables('{"tables": []}')).toEqual({ tables: [] });
    expect(parseTables('nope')).toEqual({ problem: 'The answer was not valid JSON.' });
    expect(parseTables('{"x":1}')).toEqual({ problem: 'The answer had no "tables" list.' });
  });

  it('squares off ragged tables and names missing headers', () => {
    expect(rectangular(['a', ''], [['1'], ['1', '2', '3']])).toEqual({
      headers: ['a', 'Column 2', 'Column 3'],
      rows: [
        ['1', '', ''],
        ['1', '2', '3'],
      ],
    });
    const made = toTable(
      { title: '', kind: 'table', headers: ['a'], rows: [['1'], ['']], notes: '' },
      { id: 'x', fileId: 'f', fileName: 'p.png', pageNumber: 1, pageCount: 1, index: 3 },
    );
    expect(made.title).toBe('Table 3');
    expect(made.rows).toEqual([['1']]);
  });
});

describe('grid edits', () => {
  it('edits cells and headers in place', () => {
    const t = table();
    setCell(t, 1, 2, '102');
    expect(t.rows[1]).toEqual(['South', '98', '102']);
    renameHeader(t, 0, ' Area ');
    expect(t.headers[0]).toBe('Area');
    renameHeader(t, 1, '   ');
    expect(t.headers[1]).toBe('Column 2');
    setCell(t, 9, 0, 'ignored');
    expect(t.rows).toHaveLength(2);
  });

  it('adds and removes rows and columns without touching the original', () => {
    const t = table();
    const more = addRow(t);
    expect(more.rows).toHaveLength(3);
    expect(more.rows[2]).toEqual(['', '', '']);
    expect(t.rows).toHaveLength(2);
    expect(addRow(t, 0).rows[0]).toEqual(['', '', '']);
    expect(removeRow(t, 0).rows).toEqual([['South', '98', '101']]);
    const wider = addColumn(t);
    expect(wider.headers).toEqual(['Region', 'Q1', 'Q2', 'Column 4']);
    expect(wider.rows[0]).toEqual(['North', '120', '135', '']);
    expect(addColumn(t, 1).headers).toEqual(['Region', 'Column 4', 'Q1', 'Q2']);
    expect(removeColumn(t, 1)).toMatchObject({
      headers: ['Region', 'Q2'],
      rows: [
        ['North', '135'],
        ['South', '101'],
      ],
    });
    const one = removeColumn(removeColumn(t, 0), 0);
    expect(removeColumn(one, 0)).toBe(one); // the last column stays
  });

  it('merges a table that continues on the next page', () => {
    const first = table();
    const repeated = table({
      id: 't2',
      firstPage: 3,
      lastPage: 3,
      rows: [['East', '75', '80']],
      notes: 'EUR',
    });
    expect(canMerge(first, repeated)).toBe(true);
    expect(canMerge(first, table({ id: 't3', firstPage: 4, lastPage: 4 }))).toBe(false);
    expect(canMerge(first, table({ id: 't4', fileId: 'other', firstPage: 3, lastPage: 3 }))).toBe(
      false,
    );
    expect(canMerge(first, undefined)).toBe(false);

    const merged = mergeTables(first, repeated);
    expect(merged).toMatchObject({ id: 't1', firstPage: 2, lastPage: 3, notes: 'EUR' });
    expect(merged.rows.map((row) => row[0])).toEqual(['North', 'South', 'East']);

    // A continuation without a header row: its "headers" are really its first data row.
    const headless = table({
      id: 't5',
      firstPage: 3,
      lastPage: 3,
      headers: ['West', '143', '150'],
      rows: [['Central', '60', '61']],
    });
    expect(mergeTables(first, headless).rows.map((row) => row[0])).toEqual([
      'North',
      'South',
      'West',
      'Central',
    ]);
    // Generated names ("Column 1", …) are not data.
    const unnamed = table({
      id: 't6',
      firstPage: 3,
      lastPage: 3,
      headers: ['Column 1', 'Column 2', 'Column 3'],
      rows: [['X', '1', '2']],
    });
    expect(mergeTables(first, unnamed).rows).toHaveLength(3);
  });
});

describe('numbers', () => {
  it.each([
    ['120', 120],
    ['-3', -3],
    ['1,234.5', 1234.5],
    ['$12', 12],
    ['(4.00)', -4],
    ['+7', 7],
  ])('reads %j as a number', (text, value) => {
    expect(cellNumber(text)).toBe(value);
  });

  it.each(['', 'abc', '12%', '1,23', '1.2.3', '=1+1'])('leaves %j as text', (text) => {
    expect(cellNumber(text)).toBeNull();
  });

  it('finds numeric columns and counts', () => {
    expect(numericColumns(table())).toEqual([false, true, true]);
    expect(numericColumns(table({ rows: [['a', '', 'x']] }))).toEqual([false, false, false]);
    expect(describeTables([table(), table()])).toBe('2 tables · 4 rows');
    expect(describeTables([table({ rows: [['a', 'b', 'c']] })])).toBe('1 table · 1 row');
  });
});
