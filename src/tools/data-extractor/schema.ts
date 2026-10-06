/**
 * The Data extractor's schemas: field definitions, the JSON Schema sent as a structured output, and the
 * validation and normalisation of what a model returns (numbers, currency amounts, dates, booleans, choices,
 * lists and tables of line items). Pure: no DOM, no network.
 */
import { isRecord, isUnsafeKey, parseJsonSafe } from '../../core/util';

export const FIELD_TYPES = [
  'text',
  'number',
  'currency',
  'date',
  'boolean',
  'enum',
  'list',
  'table',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'boolean'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency amount',
  date: 'Date',
  boolean: 'Yes / no',
  enum: 'Choice',
  list: 'List of text',
  table: 'Table of line items',
};

export interface ColumnDef {
  name: string;
  type: ColumnType;
  description: string;
}

export interface FieldDef {
  /** JSON key, `a-z0-9_` (see `normalizeFieldName`). */
  name: string;
  type: FieldType;
  description: string;
  required: boolean;
  /** Choices, for `enum`. */
  options?: string[];
  /** Columns, for `table`. */
  columns?: ColumnDef[];
}

export const isFieldType = (value: unknown): value is FieldType =>
  (FIELD_TYPES as readonly unknown[]).includes(value);
export const isColumnType = (value: unknown): value is ColumnType =>
  (COLUMN_TYPES as readonly unknown[]).includes(value);

/** `Invoice Number` → `invoice_number`: lower case, underscores, at most 64 characters, never starting with a digit. */
export function normalizeFieldName(text: string): string {
  const name = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^\d/.test(name) ? `f_${name}`.slice(0, 64) : name;
}

/** `invoice_number` → `Invoice number`. */
export function fieldLabel(name: string): string {
  const words = name.replace(/_/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/**
 * Why `__proto__`, `constructor` and `prototype` cannot name a field or a column: the parser of the model's answer
 * (`parseJsonSafe`) drops those keys, so a value filed under one would never arrive.
 */
export const unsafeName = (name: string): string =>
  `“${name}” cannot be a name: answers filed under it are dropped. Use another.`;

/** Problems that make a schema unusable, by field index (`-1` for the schema as a whole). */
export function validateSchema(fields: readonly FieldDef[]): { index: number; message: string }[] {
  const problems: { index: number; message: string }[] = [];
  if (fields.length === 0) problems.push({ index: -1, message: 'Add at least one field.' });
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (!field.name) problems.push({ index, message: 'Give the field a name.' });
    else if (isUnsafeKey(field.name)) problems.push({ index, message: unsafeName(field.name) });
    else if (seen.has(field.name))
      problems.push({ index, message: `“${field.name}” is used twice.` });
    seen.add(field.name);
    if (
      field.type === 'enum' &&
      (field.options ?? []).filter((option) => option.trim()).length === 0
    ) {
      problems.push({ index, message: 'A choice needs at least one option.' });
    }
    if (field.type === 'table') {
      const columns = field.columns ?? [];
      if (columns.length === 0)
        problems.push({ index, message: 'A table needs at least one column.' });
      const names = new Set<string>();
      for (const column of columns) {
        if (!column.name) problems.push({ index, message: 'Every column needs a name.' });
        else if (isUnsafeKey(column.name)) {
          problems.push({ index, message: unsafeName(column.name) });
        } else if (names.has(column.name))
          problems.push({ index, message: `Column “${column.name}” is used twice.` });
        names.add(column.name);
      }
    }
  });
  return problems;
}

/** Reads a field list from a snapshot or tool state, dropping anything malformed. */
export function readFields(value: unknown): FieldDef[] | null {
  if (!Array.isArray(value)) return null;
  const fields: FieldDef[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || !isFieldType(item['type'])) continue;
    const field: FieldDef = {
      name: item['name'],
      type: item['type'],
      description: typeof item['description'] === 'string' ? item['description'] : '',
      required: item['required'] === true,
    };
    if (field.type === 'enum') {
      field.options = Array.isArray(item['options'])
        ? item['options'].filter((option): option is string => typeof option === 'string')
        : [];
    }
    if (field.type === 'table') {
      field.columns = Array.isArray(item['columns'])
        ? item['columns'].flatMap((column) =>
            isRecord(column) && typeof column['name'] === 'string' && isColumnType(column['type'])
              ? [
                  {
                    name: column['name'],
                    type: column['type'],
                    description:
                      typeof column['description'] === 'string' ? column['description'] : '',
                  },
                ]
              : [],
          )
        : [];
    }
    fields.push(field);
  }
  return fields;
}

/** A deep copy that keeps only the keys of a field's type (what snapshots store). */
export function cleanFields(fields: readonly FieldDef[]): FieldDef[] {
  return readFields(fields) ?? [];
}

// --- JSON Schema ------------------------------------------------------------------------------------------

const TYPE_HINTS: Partial<Record<FieldType | ColumnType, string>> = {
  number: 'A plain number.',
  currency:
    'An amount as a plain number: no currency symbol, no thousands separators, a dot for decimals.',
  date: 'A date as YYYY-MM-DD.',
  boolean: 'true or false.',
};

function describe(type: FieldType | ColumnType, description: string): string {
  return [description.trim(), TYPE_HINTS[type]].filter(Boolean).join(' ');
}

function scalarSchema(
  type: ColumnType,
  description: string,
  nullable: boolean,
): Record<string, unknown> {
  const base =
    type === 'number' || type === 'currency' ? 'number' : type === 'boolean' ? 'boolean' : 'string';
  const schema: Record<string, unknown> = { type: nullable ? [base, 'null'] : base };
  const text = describe(type, description);
  if (text) schema['description'] = text;
  return schema;
}

function fieldSchema(field: FieldDef): Record<string, unknown> {
  // Required fields too: a document that does not show the value must be able to say so (null), or the model
  // is forced to invent one and "Required, but not found" can never be flagged.
  const nullable = true;
  const description = describe(field.type, field.description);
  switch (field.type) {
    case 'enum': {
      const options = (field.options ?? []).map((option) => option.trim()).filter(Boolean);
      return {
        type: nullable ? ['string', 'null'] : 'string',
        enum: nullable ? [...options, null] : options,
        ...(description ? { description } : {}),
      };
    }
    case 'list':
      return {
        type: nullable ? ['array', 'null'] : 'array',
        items: { type: 'string' },
        ...(description ? { description } : {}),
      };
    case 'table': {
      const columns = field.columns ?? [];
      return {
        type: nullable ? ['array', 'null'] : 'array',
        ...(description ? { description } : {}),
        items: {
          type: 'object',
          properties: Object.fromEntries(
            columns.map((column) => [
              column.name,
              scalarSchema(column.type, column.description, true),
            ]),
          ),
          required: columns.map((column) => column.name),
          additionalProperties: false,
        },
      };
    }
    default:
      return scalarSchema(field.type, field.description, nullable);
  }
}

/**
 * The JSON Schema of one document's answer, written for strict structured outputs: every property is listed in
 * `required` and may be `null` (whether the field is required is checked after the answer, not by the model), and
 * no other properties are allowed.
 */
export function toJsonSchema(fields: readonly FieldDef[]): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(fields.map((field) => [field.name, fieldSchema(field)])),
    required: fields.map((field) => field.name),
    additionalProperties: false,
  };
}

// --- normalisation ----------------------------------------------------------------------------------------

export type Value = string | number | boolean | string[] | Record<string, unknown>[] | null;

export interface Normalized {
  value: Value;
  /** Why the value needs a look (unreadable number, ambiguous date, not a listed choice…). */
  issue?: string;
}

/**
 * ISO 4217 codes of the currencies in use. Only these, and only in capitals as documents print them, are stripped
 * from a number: a pattern for any three letters made "5 and 6" read as 56.
 */
const CURRENCY_CODES =
  'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
  'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD ' +
  'GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT ' +
  'LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR ' +
  'NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP ' +
  'STN SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF ' +
  'YER ZAR ZMW ZWL';
const CURRENCY_MARKS = new RegExp(
  `[$€£¥₹₩₽₺₪฿₫₦₴₱]|\\b(?:${CURRENCY_CODES.split(' ').join('|')})\\b`,
  'g',
);

/** A number read from text, and why it may be wrong when the text could mean another one. */
export interface ReadNumber {
  value: number;
  /** Set when the text could also mean another number (`1.234`: 1234 or 1.234). */
  doubtful?: string;
}

/**
 * A number as people write it on documents: `1,234.56`, `1.234,56`, `1 234,56`, `1'234.50`, `$12.00`, `(12.00)`,
 * `12.00-` and `(-12.00)` (negative), `€ 5`, `1,23,456` (Indian grouping). Null when it is not a number.
 *
 * One separator followed by exactly three digits (`1.234`, `1,234`, `€1.000`) is read as a thousands separator, the
 * likelier meaning on a document, but marked `doubtful` (it could be a decimal mark). After a lone `0` a separator
 * is always a decimal mark (`0,500`).
 */
export function readNumber(input: unknown): ReadNumber | null {
  if (typeof input === 'number') return Number.isFinite(input) ? { value: input } : null;
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(CURRENCY_MARKS, '').replace(/[\s\u00a0\u202f']/g, '');
  // A minus (before or after) makes it negative; written together with brackets it is still just negative.
  if (/^-/.test(text)) {
    negative = true;
    text = text.slice(1);
  } else if (/-$/.test(text)) {
    negative = true;
    text = text.slice(0, -1);
  } else if (/^\+/.test(text)) {
    text = text.slice(1);
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return null;
  let doubtful: string | undefined;
  const commas = (text.match(/,/g) ?? []).length;
  const dots = (text.match(/\./g) ?? []).length;
  if (commas > 0 && dots > 0) {
    // Both: the later one is the decimal mark, and it appears once.
    const decimal = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    if ((decimal === ',' ? commas : dots) > 1) return null;
    text = text.split(thousands).join('').replace(decimal, '.');
  } else if (commas + dots > 1) {
    // One kind, several times: thousands groups (1.234.567, 1,234,567, Indian 1,23,456).
    const mark = commas ? ',' : '.';
    const groups = text.split(mark);
    const western = groups.slice(1).every((group) => group.length === 3);
    const indian =
      mark === ',' &&
      groups.at(-1)?.length === 3 &&
      groups.slice(1, -1).every((group) => group.length === 2);
    if (!(western || indian) || !/^\d{1,3}$/.test(groups[0] ?? '')) return null;
    text = groups.join('');
  } else if (commas + dots === 1) {
    const mark = commas ? ',' : '.';
    const [whole = '', fraction = ''] = text.split(mark);
    if (fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole)) {
      // 1.234 / 1,234: a thousands separator most likely, but it could be a decimal mark.
      const sign = negative ? '-' : '';
      text = `${whole}${fraction}`;
      doubtful = `Read as ${sign}${text}; it could also mean ${sign}${whole}.${fraction}.`;
    } else {
      text = `${whole}.${fraction}`;
    }
  }
  if (!/^\d*\.?\d*$/.test(text) || text === '.' || text === '') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const signed = negative && value !== 0 ? -value : value;
  return doubtful ? { value: signed, doubtful } : { value: signed };
}

/** `readNumber`'s value (doubtful readings included); null when the text is not a number. */
export function parseNumber(input: unknown): number | null {
  return readNumber(input)?.value ?? null;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function monthNumber(name: string): number | null {
  const lower = name.toLowerCase().replace(/\.$/, '');
  if (lower.length < 3) return null;
  const index = MONTHS.findIndex(
    (month) => month.startsWith(lower) || (lower === 'sept' && month === 'september'),
  );
  return index >= 0 ? index + 1 : null;
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 100) year += year < 70 ? 2000 : 1900;
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A date as `YYYY-MM-DD`. Reads ISO dates (a time part is dropped), `2026/03/05`, `05.03.2026` (day first),
 * `March 5, 2026`, `5 Mar 2026`, and `03/05/2026` when one part cannot be a month. Returns `{ ambiguous: true }`
 * for `03/05/2026`-style dates that could be either, and null for anything else.
 */
export function parseDate(input: unknown): string | { ambiguous: true } | null {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/\s+/g, ' ');
  let match =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text) ??
    /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(text);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text);
  if (match) return isoDate(Number(match[3]), Number(match[2]), Number(match[1]));
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(text);
  if (match) {
    const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (a > 12) return isoDate(year, b, a);
    if (b > 12) return isoDate(year, a, b);
    if (a === b) return isoDate(year, a, b);
    return { ambiguous: true };
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,}\.?),? (\d{4})$/.exec(text);
  if (match) {
    const month = monthNumber(match[2]!);
    return month ? isoDate(Number(match[3]), month, Number(match[1])) : null;
  }
  match = /^([A-Za-z]{3,}\.?) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text);
  if (match) {
    const month = monthNumber(match[1]!);
    return month ? isoDate(Number(match[3]), month, Number(match[2])) : null;
  }
  return null;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'ja', 'oui', 'si', 'sí', 'x', '✓']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'nein', 'non']);

/** Any value as text: strings as they are, numbers and booleans spelled out, anything else as JSON. */
function asText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint')
    return String(raw);
  return JSON.stringify(raw) ?? '';
}

/** One value of a field or column, normalised; text from a grid edit goes through here too. */
export function normalizeValue(
  definition: { type: FieldType | ColumnType; options?: string[]; columns?: ColumnDef[] },
  raw: unknown,
): Normalized {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { value: definition.type === 'table' ? [] : null };
  }
  switch (definition.type) {
    case 'text':
      return {
        value: asText(raw).trim(),
      };
    case 'number':
    case 'currency': {
      const read = readNumber(raw);
      if (read === null) return { value: asText(raw), issue: 'Not a number.' };
      const value =
        definition.type === 'currency' ? Math.round(read.value * 1e6) / 1e6 : read.value;
      return read.doubtful ? { value, issue: read.doubtful } : { value };
    }
    case 'date': {
      const value = parseDate(asText(raw));
      if (typeof value === 'string') return { value };
      return {
        value: asText(raw),
        issue: value
          ? 'Day and month could be either way round; write YYYY-MM-DD.'
          : 'Not a date; write YYYY-MM-DD.',
      };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const word = asText(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return { value: true };
      if (FALSE_WORDS.has(word)) return { value: false };
      return { value: asText(raw), issue: 'Not yes or no.' };
    }
    case 'enum': {
      const text = asText(raw).trim();
      const options = definition.options ?? [];
      const match = options.find((option) => option.toLowerCase() === text.toLowerCase());
      if (match) return { value: match };
      return { value: text, issue: `Not one of: ${options.join(', ')}.` };
    }
    case 'list': {
      const items = Array.isArray(raw)
        ? raw.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
        : asText(raw).split(/\r?\n|;|•/);
      return { value: items.map((item) => item.trim()).filter(Boolean) };
    }
    case 'table': {
      if (!Array.isArray(raw)) return { value: [], issue: 'Expected a list of rows.' };
      const rows = raw.filter(isRecord).map((row) => {
        const out: Record<string, unknown> = {};
        for (const column of definition.columns ?? [])
          out[column.name] = normalizeValue(column, row[column.name]).value;
        return out;
      });
      return { value: rows };
    }
  }
}

export interface RecordResult {
  values: Record<string, Value>;
  /** By field name, or `field[row].column` for a table cell. */
  issues: Record<string, string>;
}

/** Normalises a model's answer for one document and lists what needs a look (missing required fields too). */
export function normalizeRecord(fields: readonly FieldDef[], raw: unknown): RecordResult {
  const source = isRecord(raw) ? raw : {};
  const values: Record<string, Value> = {};
  const issues: Record<string, string> = {};
  for (const field of fields) {
    const { value, issue } = normalizeValue(field, source[field.name]);
    values[field.name] = value;
    if (issue) issues[field.name] = issue;
    else if (field.required && isEmpty(value)) issues[field.name] = 'Required, but not found.';
    if (field.type === 'table' && Array.isArray(source[field.name])) {
      (source[field.name] as unknown[]).filter(isRecord).forEach((row, index) => {
        for (const column of field.columns ?? []) {
          const cell = normalizeValue(column, row[column.name]);
          if (cell.issue) issues[`${field.name}[${index}].${column.name}`] = cell.issue;
        }
      });
    }
  }
  return { values, issues };
}

export function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A value as the text of a grid cell. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value))
    return value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return asText(value);
}

/** Finds the JSON object in a model's answer: the whole text, or inside a code fence, or the outermost braces. */
export function extractJson(text: string): unknown {
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
      // try the next shape
    }
  }
  return undefined;
}
