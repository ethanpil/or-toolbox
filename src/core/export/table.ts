/**
 * Plain-text table formats: CSV, TSV, a Markdown table, and JSON.
 *
 * Rows are objects; columns say which keys to write and what to call them.
 * Cell values are written as text the same way in every format (see
 * `cellText`), so a table looks the same whichever format the user picks.
 */

/** One table row: values by column key. */
export type ExportRow = Record<string, unknown>;

/** A column: a key (also used as the header), or a key with its own header text. */
export type ExportColumn = string | { key: string; header?: string };

export interface ResolvedColumn {
  key: string;
  header: string;
}

export function resolveColumns(columns: readonly ExportColumn[]): ResolvedColumn[] {
  return columns.map((column) =>
    typeof column === 'string'
      ? { key: column, header: column }
      : { key: column.key, header: column.header ?? column.key },
  );
}

/**
 * A value as text: `null`/`undefined` and non-finite numbers are empty,
 * booleans are `true`/`false`, dates are ISO 8601 in UTC, and objects and
 * arrays are JSON.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular, or holding a BigInt: say what it is rather than fail the whole export.
    return Object.prototype.toString.call(value);
  }
}

export interface DelimitedOptions {
  /** Write the column headers first. Default true. */
  header?: boolean;
}

export interface CsvOptions extends DelimitedOptions {
  /**
   * Start the file with a UTF-8 byte order mark, which makes Excel read it as
   * UTF-8 instead of the system code page. Default false.
   */
  bom?: boolean;
  /**
   * Defuse spreadsheet formulas: a text cell starting with `=`, `+`, `-`, `@`,
   * tab or CR (unless it is a plain number) gets a leading apostrophe, so
   * Excel shows it instead of running it. Use for text taken from untrusted
   * documents. Default false, which writes values exactly as they are.
   */
  formulaSafe?: boolean;
}

function delimited(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  delimiter: string,
  newline: string,
  needsQuotes: RegExp,
  prepare: (text: string, isString: boolean) => string,
  header: boolean,
): string {
  const resolved = resolveColumns(columns);
  const quote = (text: string): string =>
    needsQuotes.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  const lines: string[] = [];
  if (header) {
    lines.push(resolved.map((column) => quote(prepare(column.header, true))).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      resolved
        .map((column) => {
          const value = row[column.key];
          return quote(prepare(cellText(value), typeof value === 'string'));
        })
        .join(delimiter),
    );
  }
  return lines.join(newline);
}

/** The UTF-8 byte order mark as a character; written out so no invisible character sits in the source. */
const BOM = String.fromCharCode(0xfeff);

/** A formula starter that is not just a signed number. */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d[\d.,]*$/;

/**
 * RFC 4180 CSV: comma-separated, CRLF between records, fields containing a
 * comma, quote, CR or LF in double quotes with quotes doubled. No trailing newline.
 */
export function toCsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  options: CsvOptions = {},
): string {
  const safe = options.formulaSafe ?? false;
  const body = delimited(
    rows,
    columns,
    ',',
    '\r\n',
    /[",\r\n]/,
    (text, isString) =>
      safe && isString && FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text,
    options.header ?? true,
  );
  return options.bom ? BOM + body : body;
}

/**
 * Tab-separated text, as pasted into spreadsheets: LF between records, and a
 * field containing a tab, quote, CR or LF in double quotes with quotes doubled
 * (what Excel itself writes to the clipboard).
 */
export function toTsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  options: DelimitedOptions = {},
): string {
  return delimited(rows, columns, '\t', '\n', /["\t\r\n]/, (text) => text, options.header ?? true);
}

/** A GitHub-flavoured Markdown table. `|` and `\` are escaped and line breaks become `<br>`. */
export function toMarkdownTable(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
): string {
  const resolved = resolveColumns(columns);
  if (resolved.length === 0) return '';
  const escape = (text: string): string =>
    text
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n|\r/g, '<br>');
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(resolved.map((column) => escape(column.header))),
    line(resolved.map(() => '---')),
    ...rows.map((row) => line(resolved.map((column) => escape(cellText(row[column.key]))))),
  ].join('\n');
}

/** JSON as a Blob (`application/json`), two-space indented by default. */
export function toJsonBlob(value: unknown, space: number | string = 2): Blob {
  return new Blob([JSON.stringify(value, null, space)], { type: 'application/json' });
}
