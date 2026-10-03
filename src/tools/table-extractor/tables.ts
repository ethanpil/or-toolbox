/**
 * Table extractor's pure half: the request for one page, reading the model's tables, and the edits the grid
 * makes (cells, rows, columns, headers, merging a table that continues on the next page). Edits that change the
 * shape return a new table; the grid swaps it in.
 */
import type { ChatRequest } from '../../core/api/types';
import { isRecord, parseJsonSafe } from '../../core/util';

export interface ExtractedTable {
  id: string;
  title: string;
  kind: 'table' | 'chart';
  fileId: string;
  fileName: string;
  /** Pages the table spans (more than one after a merge). */
  firstPage: number;
  lastPage: number;
  /** Pages in its file. */
  pageCount: number;
  headers: string[];
  rows: string[][];
  notes: string;
}

/** What the model returns for one page. */
export interface RawTable {
  title: string;
  kind: 'table' | 'chart';
  headers: string[];
  rows: string[][];
  notes: string;
}

export type OutputMode = 'schema' | 'json' | 'prompt';

export function outputMode(supportedParameters: readonly string[]): OutputMode {
  if (supportedParameters.includes('structured_outputs')) return 'schema';
  if (supportedParameters.includes('response_format')) return 'json';
  return 'prompt';
}

/** Strict structured-output schema of one page's answer. */
export const TABLES_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tables: {
      type: 'array',
      description: 'Every table on the page, top to bottom; an empty list when there is none.',
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The caption or heading; a short description when there is none.',
          },
          kind: { type: 'string', enum: ['table', 'chart'] },
          headers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column headers, left to right.',
          },
          rows: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description:
              'Data rows; every row has one cell per header, empty strings for empty cells.',
          },
          notes: {
            type: 'string',
            description: 'Footnotes, units or remarks; empty when there are none.',
          },
        },
        required: ['title', 'kind', 'headers', 'rows', 'notes'],
        additionalProperties: false,
      },
    },
  },
  required: ['tables'],
  additionalProperties: false,
};

export function systemPrompt(options: {
  charts: boolean;
  mode: OutputMode;
  instructions: string;
}): string {
  const lines = [
    'You find tables in a page image and transcribe them exactly.',
    'For every table: its title, its column headers and every data row, with each cell copied as printed (numbers, signs, units and currency symbols included). Merged cells: repeat the value in each cell it spans. Multi-line headers: join the lines with a space. Keep the row order. Leave out page headers, footers and running text.',
    options.charts
      ? 'Also turn every chart into a table (kind "chart"): the first column holds the categories or x values, then one column per data series, with the values read from the chart as precisely as you can; say in notes that the values are read from a chart.'
      : 'Ignore charts and figures.',
    'If a table continues from the previous page without its header row, use the column headers it would have, or empty strings.',
    'Answer with a JSON object {"tables": [...]}; an empty list when the page has no table.',
  ];
  if (options.mode !== 'schema')
    lines.push(`The JSON Schema of the answer:\n${JSON.stringify(TABLES_SCHEMA)}`);
  if (options.instructions.trim())
    lines.push(`Extra instructions from the user: ${options.instructions.trim()}`);
  return lines.join('\n\n');
}

export function pageRequest(
  model: string,
  page: {
    fileName: string;
    pageNumber: number;
    pageCount: number;
    imageDataUrl: string;
    text?: string;
  },
  options: { charts: boolean; mode: OutputMode; instructions: string; textHint: boolean },
): ChatRequest {
  const hint = options.textHint ? (page.text ?? '').trim().slice(0, 6000) : '';
  const body: ChatRequest = {
    model,
    messages: [
      { role: 'system', content: systemPrompt(options) },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Page ${page.pageNumber} of ${page.pageCount} of “${page.fileName}”.` +
              (hint
                ? `\n\nThe PDF's own text for this page (may be out of order; trust the image):\n${hint}`
                : ''),
          },
          { type: 'image_url', image_url: { url: page.imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: 16_000,
  };
  if (options.mode === 'schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'tables', strict: true, schema: TABLES_SCHEMA },
    };
    body.provider = { require_parameters: true };
  } else if (options.mode === 'json') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

const cellString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
};

/** The JSON object in an answer: as it is, inside a code fence, or between the outermost braces. */
function findJson(text: string): unknown {
  const attempts = [text.trim()];
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) attempts.push(fenced[1].trim());
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(text.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      return parseJsonSafe(attempt);
    } catch {
      // next shape
    }
  }
  return undefined;
}

/** Reads one page's answer. `{ tables }`, a bare list, or one table object are accepted. */
export function parseTables(text: string): { tables: RawTable[] } | { problem: string } {
  const data = findJson(text);
  if (data === undefined) return { problem: 'The answer was not valid JSON.' };
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['tables'])
      ? data['tables']
      : isRecord(data) && Array.isArray(data['rows'])
        ? [data]
        : null;
  if (!list) return { problem: 'The answer had no "tables" list.' };
  const tables: RawTable[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const headers = Array.isArray(item['headers']) ? item['headers'].map(cellString) : [];
    const rows = Array.isArray(item['rows'])
      ? item['rows'].map((row) =>
          Array.isArray(row)
            ? row.map(cellString)
            : isRecord(row)
              ? Object.values(row).map(cellString)
              : [cellString(row)],
        )
      : [];
    if (headers.length === 0 && rows.length === 0) continue;
    tables.push({
      title: cellString(item['title']),
      kind: item['kind'] === 'chart' ? 'chart' : 'table',
      headers,
      rows,
      notes: cellString(item['notes']),
    });
  }
  return { tables };
}

/** `Column 3`, unless taken. */
function columnName(index: number, taken: readonly string[]): string {
  let name = `Column ${index + 1}`;
  for (let n = 2; taken.includes(name); n++) name = `Column ${index + 1} (${n})`;
  return name;
}

/** Makes every row as wide as the widest of headers and rows, naming new columns. */
export function rectangular(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): { headers: string[]; rows: string[][] } {
  const width = Math.max(1, headers.length, ...rows.map((row) => row.length));
  const named = Array.from({ length: width }, (_, i) => headers[i] ?? '');
  const filled = named.map((header, i) => header || columnName(i, named));
  return {
    headers: filled,
    rows: rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? '')),
  };
}

export function toTable(
  raw: RawTable,
  source: {
    id: string;
    fileId: string;
    fileName: string;
    pageNumber: number;
    pageCount: number;
    index: number;
  },
): ExtractedTable {
  const { headers, rows } = rectangular(raw.headers, raw.rows);
  return {
    id: source.id,
    title: raw.title || `Table ${source.index}`,
    kind: raw.kind,
    fileId: source.fileId,
    fileName: source.fileName,
    firstPage: source.pageNumber,
    lastPage: source.pageNumber,
    pageCount: source.pageCount,
    headers,
    rows: rows.filter((row) => row.some((cell) => cell !== '')),
    notes: raw.notes,
  };
}

// --- edits ------------------------------------------------------------------------------------------------

export function setCell(table: ExtractedTable, row: number, column: number, value: string): void {
  const target = table.rows[row];
  if (target && column >= 0 && column < table.headers.length) target[column] = value;
}

export function renameHeader(table: ExtractedTable, column: number, name: string): void {
  if (column >= 0 && column < table.headers.length)
    table.headers[column] = name.trim() || columnName(column, table.headers);
}

export function addRow(table: ExtractedTable, at = table.rows.length): ExtractedTable {
  const rows = [...table.rows];
  rows.splice(
    Math.max(0, Math.min(at, rows.length)),
    0,
    table.headers.map(() => ''),
  );
  return { ...table, rows };
}

export function removeRow(table: ExtractedTable, row: number): ExtractedTable {
  return { ...table, rows: table.rows.filter((_, i) => i !== row) };
}

export function addColumn(table: ExtractedTable, at = table.headers.length): ExtractedTable {
  const index = Math.max(0, Math.min(at, table.headers.length));
  const headers = [...table.headers];
  headers.splice(index, 0, columnName(table.headers.length, table.headers));
  return {
    ...table,
    headers,
    rows: table.rows.map((row) => {
      const next = [...row];
      next.splice(index, 0, '');
      return next;
    }),
  };
}

export function removeColumn(table: ExtractedTable, column: number): ExtractedTable {
  if (table.headers.length <= 1) return table;
  return {
    ...table,
    headers: table.headers.filter((_, i) => i !== column),
    rows: table.rows.map((row) => row.filter((_, i) => i !== column)),
  };
}

const sameHeaders = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length &&
  a.every((header, i) => header.trim().toLowerCase() === (b[i] ?? '').trim().toLowerCase());
const isGenerated = (headers: readonly string[]): boolean =>
  headers.every((header, i) => header === columnName(i, []) || header === '');

/** True when `next` continues `table` on the following page of the same file. */
export function canMerge(table: ExtractedTable, next: ExtractedTable | undefined): boolean {
  return !!next && next.fileId === table.fileId && next.firstPage === table.lastPage + 1;
}

/**
 * Appends `next` to `table`. A repeated header row is dropped; a "header" that differs is really the first data
 * row of the continuation (the page had no header), so it is kept as a row.
 */
export function mergeTables(table: ExtractedTable, next: ExtractedTable): ExtractedTable {
  const continuation =
    sameHeaders(table.headers, next.headers) || isGenerated(next.headers) ? [] : [next.headers];
  const nextRows = next.rows.filter((row) => !sameHeaders(row, table.headers));
  const { headers, rows } = rectangular(table.headers, [
    ...table.rows,
    ...continuation,
    ...nextRows,
  ]);
  return {
    ...table,
    headers,
    rows,
    lastPage: next.lastPage,
    notes: [...new Set([table.notes, next.notes].map((note) => note.trim()).filter(Boolean))].join(
      '\n',
    ),
  };
}

// --- numbers ----------------------------------------------------------------------------------------------

/** A cell that is a number as printed (`1,234.5`, `-3`, `$12`, `(4.00)`), as a number; null otherwise. */
export function cellNumber(text: string): number | null {
  let value = text.trim();
  if (!value) return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  const match = /^([-+])?\s?[$€£¥]?\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/.exec(value);
  if (!match) return null;
  const number = Number(`${match[2]!.replace(/,/g, '')}${match[3] ?? ''}`);
  if (!Number.isFinite(number)) return null;
  return (match[1] === '-') !== negative ? -number : number;
}

/** Per column: true when it has values and every non-empty cell is a number. */
export function numericColumns(table: ExtractedTable): boolean[] {
  return table.headers.map((_, c) => {
    const cells = table.rows.map((row) => row[c] ?? '').filter((cell) => cell.trim() !== '');
    return cells.length > 0 && cells.every((cell) => cellNumber(cell) !== null);
  });
}

/** "3 tables · 42 rows", for the summary line. */
export function describeTables(tables: readonly ExtractedTable[]): string {
  const rows = tables.reduce((sum, table) => sum + table.rows.length, 0);
  return `${tables.length} ${tables.length === 1 ? 'table' : 'tables'} · ${rows} ${rows === 1 ? 'row' : 'rows'}`;
}

export function pagesLabel(
  table: Pick<ExtractedTable, 'firstPage' | 'lastPage' | 'pageCount'>,
): string {
  if (table.pageCount <= 1) return '';
  return table.firstPage === table.lastPage
    ? `page ${table.firstPage}`
    : `pages ${table.firstPage}–${table.lastPage}`;
}
