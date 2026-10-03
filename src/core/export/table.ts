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
  /**
   * Defuse spreadsheet formulas. Text taken from documents can be anything,
   * and Excel, Sheets and LibreOffice run a cell that starts with `=`, `+`,
   * `-`, `@`, tab or carriage return as a formula (`=HYPERLINK(...)`, DDE).
   * With this on, such a text cell gets a leading apostrophe, so the
   * spreadsheet shows it instead of running it. Cells that are plain numbers
   * (`-5`, `+1,234.56`, `-$5.00`, `5%`) are left alone, and so are phone-like
   * codes made only of digits, spaces, brackets, dots, slashes and dashes
   * (`+44 20 7946 0958`), and numbers that are not text. Default true; turn it
   * off for data you trust, to write values exactly as they are.
   */
  formulaSafe?: boolean;
}

export interface CsvOptions extends DelimitedOptions {
  /**
   * Start the file with a UTF-8 byte order mark, which makes Excel read it as
   * UTF-8 instead of the system code page (accents and CJK come out as
   * garbage without it). Other readers ignore or skip it. Default true.
   */
  bom?: boolean;
}

function delimited(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  delimiter: string,
  newline: string,
  needsQuotes: RegExp,
  options: DelimitedOptions,
): string {
  const resolved = resolveColumns(columns);
  const safe = options.formulaSafe ?? true;
  const quote = (text: string, isString: boolean): string => {
    const defused = safe && isString ? defuseFormula(text) : text;
    return needsQuotes.test(defused) ? `"${defused.replace(/"/g, '""')}"` : defused;
  };
  const lines: string[] = [];
  if (options.header ?? true) {
    lines.push(resolved.map((column) => quote(column.header, true)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(
      resolved
        .map((column) => {
          const value = row[column.key];
          return quote(cellText(value), typeof value === 'string');
        })
        .join(delimiter),
    );
  }
  return lines.join(newline);
}

/** The UTF-8 byte order mark as a character; written out so no invisible character sits in the source. */
const BOM = String.fromCharCode(0xfeff);

/** Characters that make a spreadsheet read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * A whole cell that is a number as people write one: optional sign, optional
 * currency symbol, digits with thousands separators or a decimal part,
 * optional exponent or percent. Nothing else may follow, so `-5+cmd|...`
 * does not qualify.
 */
const WRITTEN_NUMBER =
  /^[+-]? ?[$€£¥]? ?(?=\.?\d)(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?%?$/;

/**
 * Digits with spaces, brackets, dots, slashes and dashes after an optional sign: phone numbers such as
 * "+44 20 7946 0958" and codes like "-0 12/34". A spreadsheet may read some as arithmetic, but without letters,
 * quotes, `|`, `!` or `@` they cannot call a function, reach another cell or start a program, so they are written
 * as they are rather than with an apostrophe the reader would see.
 */
const DIGITS_ONLY = /^[+-]?[\d\s()./-]+$/;

/** Prefixes an apostrophe to text a spreadsheet would run, unless it is a number or a phone-like code. */
function defuseFormula(text: string): string {
  const harmless = WRITTEN_NUMBER.test(text) || DIGITS_ONLY.test(text);
  return FORMULA_START.test(text) && !harmless ? `'${text}` : text;
}

/**
 * RFC 4180 CSV: comma-separated, CRLF between records, fields containing a
 * comma, quote, CR or LF in double quotes with quotes doubled. No trailing
 * newline. Starts with a byte order mark and defuses formulas unless told not
 * to (see the options).
 */
export function toCsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  options: CsvOptions = {},
): string {
  const body = delimited(rows, columns, ',', '\r\n', /[",\r\n]/, options);
  return (options.bom ?? true) ? BOM + body : body;
}

/**
 * Tab-separated text, as pasted into spreadsheets: LF between records, and a
 * field containing a tab, quote, CR or LF in double quotes with quotes doubled
 * (what Excel itself writes to the clipboard). Defuses formulas like `toCsv`.
 */
export function toTsv(
  rows: readonly ExportRow[],
  columns: readonly ExportColumn[],
  options: DelimitedOptions = {},
): string {
  return delimited(rows, columns, '\t', '\n', /["\t\r\n]/, options);
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
