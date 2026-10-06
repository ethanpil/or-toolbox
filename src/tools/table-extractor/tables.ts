/**
 * Table extractor's pure half: the request for one page, reading the model's tables, and the edits the grid
 * makes (cells, rows, columns, headers, merging a table that continues on the next page). Edits that change the
 * shape return a new table; the grid swaps it in.
 */
import type { OutputMode } from '../../core/api/structured-output';
import type { ChatRequest } from '../../core/api/types';
import { imageTokens } from '../../core/models/estimate';
import { outputCap } from '../../core/tokens';
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
  /**
   * The headers as the model read them, one per column ('' for a column added by hand): renaming a header in
   * the grid keeps them, so a repeated header row on the next page is still recognised when merging.
   */
  sourceHeaders?: string[];
}

/** What the model returns for one page. */
export interface RawTable {
  title: string;
  kind: 'table' | 'chart';
  headers: string[];
  rows: string[][];
  notes: string;
}

/** The longest text layer sent per page, in characters. */
export const TEXT_HINT_CHARS = 6000;
/** The answer's cap: a big table is many tokens. */
export const MAX_ANSWER_TOKENS = 16_000;

/**
 * Tokens for `pages` page images at `maxSide` px, `hintPages` of them with their PDF text, and a long answer each:
 * dense tables are most of what a page costs.
 */
export function estimateTokens(plan: { pages: number; hintPages: number; maxSide: number }): {
  promptTokens: number;
  completionTokens: number;
} {
  return {
    promptTokens:
      plan.pages * (300 + imageTokens(plan.maxSide)) +
      plan.hintPages * Math.ceil(TEXT_HINT_CHARS / 4),
    completionTokens: plan.pages * 2500,
  };
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
  options: {
    charts: boolean;
    mode: OutputMode;
    instructions: string;
    textHint: boolean;
    /**
     * The model's `supported_parameters`. With strict outputs the request asks OpenRouter to route only to
     * endpoints that honour every parameter sent, so a parameter the model lacks (say `temperature`) would leave
     * no endpoint at all: only supported ones are sent. Unknown (omitted): all are sent.
     */
    supported?: readonly string[];
    /** The model's own output cap (`ModelInfo.maxCompletionTokens`): `max_tokens` never exceeds it. */
    maxCompletionTokens?: number | null;
  },
): ChatRequest {
  const hint = options.textHint ? (page.text ?? '').trim().slice(0, TEXT_HINT_CHARS) : '';
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
  };
  const supports = (parameter: string): boolean =>
    !options.supported || options.supported.includes(parameter);
  if (supports('temperature')) body.temperature = 0;
  if (supports('max_tokens')) {
    body.max_tokens = Math.min(MAX_ANSWER_TOKENS, outputCap(options.maxCompletionTokens));
  }
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

/**
 * A JSON answer cut off at the length limit, cut back to the end of its last complete array or object and closed,
 * so it parses: the tables and rows finished before the cut are kept, a half-written row is not. Null when not
 * even one array or object was finished.
 */
export function closeTruncatedJson(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  let best: string | null = null;
  for (let i = start; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') {
      closers.pop();
      best = text.slice(start, i + 1) + [...closers].reverse().join('');
      if (closers.length === 0) return best;
    }
  }
  return best;
}

const headerKey = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One table's headers and rows. Rows given as objects are matched to the headers by key (case and spacing
 * ignored), not by the order of their values; a key no header names becomes a new column, and without headers
 * the keys are the headers.
 */
function readRows(item: Record<string, unknown>): { headers: string[]; rows: string[][] } {
  const headers = Array.isArray(item['headers']) ? item['headers'].map(cellString) : [];
  const raw: unknown[] = Array.isArray(item['rows']) ? item['rows'] : [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    for (const key of Object.keys(row)) {
      if (!headers.some((header) => headerKey(header) === headerKey(key))) headers.push(key.trim());
    }
  }
  const rows = raw.map((row) => {
    if (Array.isArray(row)) return row.map(cellString);
    if (!isRecord(row)) return [cellString(row)];
    const keys = Object.keys(row);
    return headers.map((header) => {
      const key = keys.find((candidate) => headerKey(candidate) === headerKey(header));
      return key === undefined ? '' : cellString(row[key]);
    });
  });
  return { headers, rows };
}

/**
 * Reads one page's answer. `{ tables }`, a bare list, or one table object are accepted. With `partial` (the answer
 * hit the length limit) an answer that does not parse is cut back to its last complete row (`salvaged`).
 */
export function parseTables(
  text: string,
  options: { partial?: boolean } = {},
): { tables: RawTable[]; salvaged?: boolean } | { problem: string } {
  let data = findJson(text);
  let salvaged = false;
  if (data === undefined && options.partial) {
    const closed = closeTruncatedJson(text);
    if (closed !== null) {
      try {
        data = parseJsonSafe(closed);
        salvaged = true;
      } catch {
        // still unreadable
      }
    }
    if (data === undefined) return { tables: [], salvaged: true };
  }
  if (data === undefined) return { problem: 'The answer was not valid JSON.' };
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['tables'])
      ? data['tables']
      : isRecord(data) && Array.isArray(data['rows'])
        ? [data]
        : null;
  if (!list) {
    return salvaged ? { tables: [], salvaged } : { problem: 'The answer had no "tables" list.' };
  }
  const tables: RawTable[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const { headers, rows } = readRows(item);
    if (headers.length === 0 && rows.length === 0) continue;
    tables.push({
      title: cellString(item['title']),
      kind: item['kind'] === 'chart' ? 'chart' : 'table',
      headers,
      rows,
      notes: cellString(item['notes']),
    });
  }
  return salvaged ? { tables, salvaged } : { tables };
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
  },
): ExtractedTable {
  const { headers, rows } = rectangular(raw.headers, raw.rows);
  return {
    id: source.id,
    // An untitled table stays untitled: it is shown as "Table N" by its place in the list (`tableTitle`), which
    // the order the pages answer in must not decide.
    title: raw.title,
    kind: raw.kind,
    fileId: source.fileId,
    fileName: source.fileName,
    firstPage: source.pageNumber,
    lastPage: source.pageNumber,
    pageCount: source.pageCount,
    headers,
    rows: rows.filter((row) => row.some((cell) => cell !== '')),
    notes: raw.notes,
    sourceHeaders: headers.map((_, i) => raw.headers[i] ?? ''),
  };
}

// --- edits ------------------------------------------------------------------------------------------------

export function setCell(table: ExtractedTable, row: number, column: number, value: string): void {
  const target = table.rows[row];
  if (target && column >= 0 && column < table.headers.length) target[column] = value;
}

/** Renames a column; a blank name gets the generated one (`Column 3`), unless another column already has it. */
export function renameHeader(table: ExtractedTable, column: number, name: string): void {
  if (column < 0 || column >= table.headers.length) return;
  const others = table.headers.filter((_, i) => i !== column);
  table.headers[column] = name.trim() || columnName(column, others);
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

/** The headers the model gave, one per column (the current ones for a table made before they were kept). */
const sourceOf = (table: ExtractedTable): string[] =>
  table.headers.map((header, i) => table.sourceHeaders?.[i] ?? header);

export function addColumn(table: ExtractedTable, at = table.headers.length): ExtractedTable {
  const index = Math.max(0, Math.min(at, table.headers.length));
  const headers = [...table.headers];
  headers.splice(index, 0, columnName(table.headers.length, table.headers));
  const sourceHeaders = sourceOf(table);
  sourceHeaders.splice(index, 0, '');
  return {
    ...table,
    headers,
    sourceHeaders,
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
    sourceHeaders: sourceOf(table).filter((_, i) => i !== column),
    rows: table.rows.map((row) => row.filter((_, i) => i !== column)),
  };
}

/** A name the grid made up (`Column 3`, `Column 3 (2)`), or none: not a header anyone printed. */
const isGeneratedName = (header: string): boolean =>
  header.trim() === '' || /^Column \d+(?: \(\d+\))?$/.test(header.trim());

/** True when `next` continues `table` on the following page of the same file. */
export function canMerge(table: ExtractedTable, next: ExtractedTable | undefined): boolean {
  return !!next && next.fileId === table.fileId && next.firstPage === table.lastPage + 1;
}

/**
 * Where each of `names` goes among `table`'s columns, matching the current header or the one the model gave
 * (case and spacing ignored); -1 where none matches. Each column is matched once.
 */
function matchColumns(table: ExtractedTable, names: readonly string[]): number[] {
  const current = table.headers.map(headerKey);
  const source = sourceOf(table).map(headerKey);
  const used = new Set<number>();
  return names.map((name) => {
    const key = headerKey(name);
    if (isGeneratedName(name)) return -1;
    const index = current.findIndex((header, i) => !used.has(i) && header === key);
    const found =
      index >= 0 ? index : source.findIndex((header, i) => !used.has(i) && header === key);
    if (found >= 0) used.add(found);
    return found;
  });
}

/**
 * Appends `next` to `table`, for a table that continues on the next page.
 *
 * - Next's headers repeat this table's (matched by name, case and spacing ignored, also against the headers the
 *   model gave before a rename): that header row is dropped, and its columns are placed by name, so a
 *   continuation with fewer, more or reordered columns lines up (extra columns are added at the end).
 * - Next's headers are only generated or empty names: there was no header row; columns go by position.
 * - Otherwise its "headers" are really its first data row (the page had no header row): kept as a row.
 */
export function mergeTables(table: ExtractedTable, next: ExtractedTable): ExtractedTable {
  const named = next.headers.filter((header) => !isGeneratedName(header));
  const matches = matchColumns(table, next.headers);
  const matched = matches.filter((index) => index >= 0).length;
  const repeated = named.length > 0 && matched >= Math.ceil(named.length / 2);

  const headers = [...table.headers];
  const sourceHeaders = sourceOf(table);
  let place: number[];
  if (repeated) {
    // By name; a named column this table lacks is added; a generated one takes its position if free.
    const taken = new Set(matches.filter((index) => index >= 0));
    place = next.headers.map((header, i) => {
      if (matches[i]! >= 0) return matches[i]!;
      if (isGeneratedName(header) && i < headers.length && !taken.has(i)) {
        taken.add(i);
        return i;
      }
      headers.push(header.trim() || columnName(headers.length, headers));
      sourceHeaders.push(header);
      return headers.length - 1;
    });
  } else {
    place = next.headers.map((_, i) => i);
  }
  const width = Math.max(headers.length, ...place.map((index) => index + 1));
  const placed = (row: readonly string[]): string[] => {
    const out = Array.from({ length: width }, () => '');
    row.forEach((cell, i) => {
      const index = place[i] ?? i;
      if (index < width) out[index] = cell;
      else out.push(cell);
    });
    return out;
  };
  const headerRow = (row: readonly string[]): boolean =>
    row.length > 0 &&
    row.every((cell, i) => headerKey(cell) === headerKey(table.headers[i] ?? '\u0000'));
  const continuation = repeated || named.length === 0 ? [] : [next.headers];
  const incoming = [...continuation, ...next.rows.filter((row) => !headerRow(row))].map(placed);
  const squared = rectangular(headers, [...table.rows, ...incoming]);
  return {
    ...table,
    headers: squared.headers,
    sourceHeaders: squared.headers.map((_, i) => sourceHeaders[i] ?? ''),
    rows: squared.rows,
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
