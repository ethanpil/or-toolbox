/**
 * Excel workbooks (.xlsx) from tables.
 *
 * Written here rather than with write-excel-file, which is installed but
 * cannot be used under our Content Security Policy: it zips with fflate's
 * async API, which compresses any sheet over 160 KB in a worker built from a
 * `blob:` URL. `worker-src 'self'` blocks that worker, and fflate never reports
 * the failure, so the export hangs forever (seen with 4,000 rows). This
 * writer produces the same package (shared strings, a styles part, one sheet
 * part per sheet) with fflate's synchronous `zipSync`, loaded on use.
 *
 * Cell typing: numbers are written as numbers, booleans as booleans, `Date`
 * values as dates (their UTC clock time, so `new Date('2026-03-05')` shows as
 * 2026-03-05), everything else as text. A column can ask for `type: 'number'`
 * or `'date'` to convert numeric or ISO-date *strings* (what a model returns
 * in JSON); strings that do not parse stay text. Text is never taken for a
 * formula. The header row is bold and frozen, and column widths fit the content.
 */
import { cellText, type ExportRow } from './table';

export interface XlsxColumn {
  key: string;
  /** Header text. Defaults to the key. */
  header?: string;
  /** Convert strings to this type when they parse. Values that already are numbers or dates are always written as such. */
  type?: 'string' | 'number' | 'date';
  /** Width in characters. Default: fitted to the content (8 to 60). */
  width?: number;
  /** Excel number format for numeric cells, for example `#,##0.00`. */
  format?: string;
}

export interface XlsxSheet {
  /** Worksheet name; made valid and unique if needed (see `sanitizeSheetName`). */
  name: string;
  columns: readonly (string | XlsxColumn)[];
  rows: readonly ExportRow[];
}

/** Excel refuses longer cell text. */
const MAX_CELL_CHARS = 32767;
const ILLEGAL_SHEET_CHARS = /[[\]:*?/\\]/g;
const DATE_FORMAT = 'yyyy-mm-dd';
const DATE_TIME_FORMAT = 'yyyy-mm-dd hh:mm:ss';

/**
 * Makes a worksheet name Excel accepts: at most 31 characters, none of
 * `[ ] : * ? / \`, no leading or trailing apostrophe, not empty, not
 * "History" (reserved), and different from every name in `taken` (compared
 * ignoring case). Adds the result to `taken`.
 */
export function sanitizeSheetName(name: string, taken: Set<string> = new Set()): string {
  let base = name
    .replace(ILLEGAL_SHEET_CHARS, '_')
    .trim()
    .replace(/^'+|'+$/g, '')
    .slice(0, 31)
    .trim();
  if (!base) base = 'Sheet';
  if (base.toLowerCase() === 'history') base = 'History_';

  let candidate = base;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    candidate = base.slice(0, 31 - suffix.length).trimEnd() + suffix;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

// --- cell values ------------------------------------------------------------

type Cell =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; format?: string | undefined }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'date'; value: number; format: string };

const NUMBER_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DAY_MS = 86_400_000;
/** Days from 1899-12-30, Excel's day 0, to 1970-01-01. */
const EXCEL_EPOCH_DAYS = 25_569;
/** 1900-03-01: from here on the Excel serial number is a plain day count (Excel counts a 29 February 1900 that never was). */
const FIRST_SAFE_DATE = Date.UTC(1900, 2, 1);
const LAST_DATE = Date.UTC(9999, 11, 31, 23, 59, 59);

function dateCell(date: Date): Cell {
  const time = date.getTime();
  // Outside what Excel can show as a date: keep the information as text.
  if (Number.isNaN(time)) return { kind: 'string', value: '' };
  if (time < FIRST_SAFE_DATE || time > LAST_DATE)
    return { kind: 'string', value: date.toISOString() };
  return {
    kind: 'date',
    value: time / DAY_MS + EXCEL_EPOCH_DAYS,
    format: time % DAY_MS === 0 ? DATE_FORMAT : DATE_TIME_FORMAT,
  };
}

function toCell(value: unknown, column: XlsxColumn): Cell | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { kind: 'number', value, format: column.format } : null;
  }
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (value instanceof Date) {
    const cell = dateCell(value);
    return cell.kind === 'string' && cell.value === '' ? null : cell;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (column.type === 'number' && NUMBER_TEXT.test(text)) {
      return { kind: 'number', value: Number(text), format: column.format };
    }
    if (column.type === 'date' && ISO_DATE.test(text)) {
      // A date-time without a zone is taken as UTC, like a bare date.
      const zoned = /[T ]/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/.test(text);
      const cell = dateCell(new Date(zoned ? `${text.replace(' ', 'T')}Z` : text));
      if (!(cell.kind === 'string' && cell.value === '')) return cell;
    }
    return { kind: 'string', value: value.slice(0, MAX_CELL_CHARS) };
  }
  const text = cellText(value);
  return text ? { kind: 'string', value: text.slice(0, MAX_CELL_CHARS) } : null;
}

// --- XML ----------------------------------------------------------------------

/** Characters XML 1.0 cannot carry: most control characters and the non-characters. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed here.
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function escapeText(text: string): string {
  return text
    .replace(XML_ILLEGAL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
function columnLetters(index: number): string {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Shared strings and cell styles, collected while the sheets are written. */
class Registry {
  readonly strings = new Map<string, number>();
  stringCount = 0;
  /** Number format code to the style (cellXfs) index that applies it. Styles 0 and 1 are the default and the header. */
  readonly formats = new Map<string, number>();

  string(text: string): number {
    this.stringCount++;
    let index = this.strings.get(text);
    if (index === undefined) {
      index = this.strings.size;
      this.strings.set(text, index);
    }
    return index;
  }

  style(format: string): number {
    let index = this.formats.get(format);
    if (index === undefined) {
      index = this.formats.size + 2;
      this.formats.set(format, index);
    }
    return index;
  }

  stringsXml(): string {
    const items = [...this.strings.keys()].map((text) => {
      const edge = /^\s|\s$|[\r\n\t]/.test(text);
      return `<si><t${edge ? ' xml:space="preserve"' : ''}>${escapeText(text)}</t></si>`;
    });
    return `${XML_HEADER}<sst xmlns="${MAIN_NS}" count="${this.stringCount}" uniqueCount="${this.strings.size}">${items.join('')}</sst>`;
  }

  stylesXml(): string {
    const formats = [...this.formats.keys()];
    const numFmts = formats.length
      ? `<numFmts count="${formats.length}">${formats
          .map((code, i) => `<numFmt numFmtId="${164 + i}" formatCode="${escapeAttribute(code)}"/>`)
          .join('')}</numFmts>`
      : '';
    const xfs = [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
      ...formats.map(
        (_, i) =>
          `<xf numFmtId="${164 + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
      ),
    ];
    return (
      `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">${numFmts}` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
      '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>'
    );
  }
}

function sheetXml(sheet: XlsxSheet, registry: Registry, selected: boolean): string {
  const columns: XlsxColumn[] = sheet.columns.map((column) =>
    typeof column === 'string' ? { key: column } : column,
  );
  const widths = columns.map((column) => column.width ?? (column.header ?? column.key).length + 2);
  const rows: string[] = [];

  if (columns.length > 0) {
    rows.push(
      `<row r="1">${columns
        .map(
          (column, c) =>
            `<c r="${columnLetters(c)}1" s="1" t="s"><v>${registry.string(column.header ?? column.key)}</v></c>`,
        )
        .join('')}</row>`,
    );
  }

  sheet.rows.forEach((row, r) => {
    const ref = r + 2;
    const cells: string[] = [];
    columns.forEach((column, c) => {
      const cell = toCell(row[column.key], column);
      if (!cell) return;
      const at = `${columnLetters(c)}${ref}`;
      if (!column.width && r < 200) {
        const text = cell.kind === 'string' ? cell.value : cellText(cell.value);
        widths[c] = Math.max(widths[c] ?? 0, Math.min(60, text.length + 2));
      }
      switch (cell.kind) {
        case 'string':
          cells.push(`<c r="${at}" t="s"><v>${registry.string(cell.value)}</v></c>`);
          break;
        case 'number':
          cells.push(
            `<c r="${at}"${cell.format ? ` s="${registry.style(cell.format)}"` : ''}><v>${cell.value}</v></c>`,
          );
          break;
        case 'boolean':
          cells.push(`<c r="${at}" t="b"><v>${cell.value ? 1 : 0}</v></c>`);
          break;
        case 'date':
          cells.push(`<c r="${at}" s="${registry.style(cell.format)}"><v>${cell.value}</v></c>`);
          break;
      }
    });
    if (cells.length > 0) rows.push(`<row r="${ref}">${cells.join('')}</row>`);
  });

  const cols = columns.length
    ? `<cols>${widths
        .map(
          (width, c) =>
            `<col min="${c + 1}" max="${c + 1}" width="${Math.min(60, Math.max(8, width))}" customWidth="1"/>`,
        )
        .join('')}</cols>`
    : '';
  const view = columns.length
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>'
    : '';
  return (
    `${XML_HEADER}<worksheet xmlns="${MAIN_NS}">` +
    `<sheetViews><sheetView workbookViewId="0"${selected ? ' tabSelected="1"' : ''}>${view}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    `${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

/** Builds a workbook with one sheet per entry. */
export async function toXlsx(sheets: readonly XlsxSheet[]): Promise<Blob> {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.');
  const { zipSync, strToU8 } = await import('fflate');
  const registry = new Registry();
  const names = new Set<string>();

  const sheetParts = sheets.map((sheet, index) => ({
    name: sanitizeSheetName(sheet.name, names),
    xml: sheetXml(sheet, registry, index === 0),
  }));
  const sheetEntries = sheetParts.map((_, i) => `xl/worksheets/sheet${i + 1}.xml`);

  const contentTypes =
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheetEntries
      .map(
        (entry) =>
          `<Override PartName="/${entry}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('') +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '</Types>';

  const workbook =
    `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>` +
    sheetParts
      .map(
        (part, i) =>
          `<sheet name="${escapeAttribute(part.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
      )
      .join('') +
    '</sheets></workbook>';

  const count = sheetParts.length;
  const workbookRels =
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    sheetParts
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${count + 1}" Type="${REL_NS}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${count + 2}" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
    '</Relationships>';

  const rootRels =
    `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/styles.xml': strToU8(registry.stylesXml()),
    'xl/sharedStrings.xml': strToU8(registry.stringsXml()),
  };
  sheetParts.forEach((part, i) => {
    files[sheetEntries[i] ?? ''] = strToU8(part.xml);
  });

  return new Blob([zipSync(files)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
