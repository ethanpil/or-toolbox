import { describe, expect, it } from 'vitest';
import { presetById, PRESETS } from './presets';
import {
  cleanFields,
  extractJson,
  type FieldDef,
  fieldLabel,
  normalizeFieldName,
  normalizeRecord,
  normalizeValue,
  parseDate,
  parseNumber,
  readFields,
  readNumber,
  toJsonSchema,
  validateSchema,
  valueText,
} from './schema';

const invoice = presetById('invoice')!.fields;

describe('field names', () => {
  it('normalises what people type into JSON keys and back into labels', () => {
    expect(normalizeFieldName('Invoice Number')).toBe('invoice_number');
    expect(normalizeFieldName('  Totál (EUR) ')).toBe('total_eur');
    expect(normalizeFieldName('2nd line')).toBe('f_2nd_line');
    expect(normalizeFieldName('***')).toBe('');
    expect(fieldLabel('invoice_number')).toBe('Invoice number');
  });

  it('flags empty, duplicate and incomplete fields', () => {
    expect(validateSchema([])).toEqual([{ index: -1, message: 'Add at least one field.' }]);
    const problems = validateSchema([
      { name: 'a', type: 'text', description: '', required: false },
      { name: 'a', type: 'text', description: '', required: false },
      { name: '', type: 'text', description: '', required: false },
      { name: 'kind', type: 'enum', description: '', required: false, options: [' '] },
      { name: 'items', type: 'table', description: '', required: false, columns: [] },
    ]);
    expect(problems.map((problem) => problem.index)).toEqual([1, 2, 3, 4]);
    expect(validateSchema(invoice)).toEqual([]);
    // Names the response parser drops: an answer filed under one would never arrive.
    const unsafe = validateSchema([
      { name: 'constructor', type: 'text', description: '', required: false },
      { name: '__proto__', type: 'text', description: '', required: false },
      {
        name: 'rows',
        type: 'table',
        description: '',
        required: false,
        columns: [{ name: 'prototype', type: 'text', description: '' }],
      },
    ]);
    expect(unsafe.map((problem) => problem.index)).toEqual([0, 1, 2]);
    expect(unsafe[0]?.message).toMatch(/constructor/);
    expect(unsafe[2]?.message).toMatch(/prototype/);
    for (const preset of PRESETS) expect(validateSchema(preset.fields), preset.id).toEqual([]);
  });

  it('reads fields from snapshots, dropping malformed entries and stray keys', () => {
    const fields = readFields([
      { name: 'total', type: 'currency', description: 'x', required: true, options: ['ignored'] },
      { name: 'bad', type: 'nope' },
      'junk',
      { name: 'kind', type: 'enum', options: ['a', 3, 'b'] },
      {
        name: 'rows',
        type: 'table',
        columns: [
          { name: 'q', type: 'number' },
          { name: 'z', type: 'wrong' },
        ],
      },
    ]);
    expect(fields).toEqual([
      { name: 'total', type: 'currency', description: 'x', required: true },
      { name: 'kind', type: 'enum', description: '', required: false, options: ['a', 'b'] },
      {
        name: 'rows',
        type: 'table',
        description: '',
        required: false,
        columns: [{ name: 'q', type: 'number', description: '' }],
      },
    ]);
    expect(readFields('nope')).toBeNull();
    const copy = cleanFields(invoice);
    expect(copy).toEqual(invoice);
    expect(copy[0]).not.toBe(invoice[0]);
  });
});

describe('toJsonSchema', () => {
  it('writes a strict schema: every key listed and nullable (required ones too), nothing else allowed', () => {
    const schema = toJsonSchema(invoice) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(invoice.map((field) => field.name));
    expect(schema.additionalProperties).toBe(false);
    // A required field the document does not show must still be answerable (null), so it can be flagged.
    expect(schema.properties['vendor_name']).toEqual({
      type: ['string', 'null'],
      description: 'Business that issued the invoice or receipt.',
    });
    expect(schema.properties['total']?.['type']).toEqual(['number', 'null']);
    expect(schema.properties['total']?.['description']).toMatch(/plain number/);
    expect(schema.properties['tax']?.['type']).toEqual(['number', 'null']);
    expect(schema.properties['invoice_date']?.['description']).toMatch(/YYYY-MM-DD/);
    expect(schema.properties['payment_method']).toMatchObject({
      type: ['string', 'null'],
      enum: ['cash', 'card', 'bank transfer', 'other', null],
    });
    expect(schema.properties['line_items']).toMatchObject({
      type: ['array', 'null'],
      items: {
        type: 'object',
        required: ['description', 'quantity', 'unit_price', 'amount'],
        additionalProperties: false,
        properties: { quantity: { type: ['number', 'null'] } },
      },
    });
  });

  it('types lists and booleans', () => {
    const schema = toJsonSchema([
      { name: 'tags', type: 'list', description: '', required: true },
      { name: 'paid', type: 'boolean', description: '', required: true },
      { name: 'kind', type: 'enum', description: '', required: true, options: ['a', 'b'] },
    ]) as { properties: Record<string, unknown> };
    expect(schema.properties).toEqual({
      tags: { type: ['array', 'null'], items: { type: 'string' } },
      paid: { type: ['boolean', 'null'], description: 'true or false.' },
      kind: { type: ['string', 'null'], enum: ['a', 'b', null] },
    });
  });
});

describe('normalisation', () => {
  it.each([
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234,56', 1234.56],
    ["1'234.50", 1234.5],
    ['$12.00', 12],
    ['€ 5', 5],
    ['12.50 EUR', 12.5],
    ['(12.00)', -12],
    ['12.00-', -12],
    ['-3', -3],
    ['0,5', 0.5],
    ['1,234', 1234],
    ['1.234.567', 1234567],
    [42, 42],
    // A leading zero: a decimal comma, never a thousands group.
    ['0,123', 0.123],
    ['0,500', 0.5],
    // One dot and three digits, no comma: European thousands.
    ['1.000', 1000],
    ['€1.234', 1234],
    // Minus written twice (in brackets and with a sign) is still negative.
    ['(-12.00)', -12],
    ['0.123,45', 123.45],
    ['12,5', 12.5],
    ['1234.567', 1234.567],
    ['1,23,456', 123456],
  ])('reads the number %j', (text, value) => {
    expect(parseNumber(text)).toBe(value);
  });

  it.each([
    ['1.234', 1234],
    ['€1.234', 1234],
    ['1,234', 1234],
    ['123,456', 123456],
  ])('reads %j as %d, but flags it as doubtful', (text, value) => {
    const read = readNumber(text);
    expect(read?.value).toBe(value);
    expect(read?.doubtful).toMatch(/could also mean/);
    expect(normalizeValue({ type: 'number' }, text)).toEqual({ value, issue: read?.doubtful });
  });

  it.each(['0,123', '1,234.56', '1.234,56', '12,50', '1.5', '1234.567', '1.234.567', '42'])(
    'reads %j without doubt',
    (text) => {
      expect(readNumber(text)?.doubtful).toBeUndefined();
    },
  );

  it.each([
    ['CHF 12.50', 12.5],
    ['12.50 CHF', 12.5],
    ['USD 1,200', 1200],
    ['(EUR 5.00)', -5],
    ['SEK 1 234,50', 1234.5],
  ])('reads %j with its currency code', (text, value) => {
    expect(parseNumber(text)).toBe(value);
  });

  it.each(['5 and 6', '5 the 6', '12 tons', 'no 5', '1 a 2', '5 xyz', 'abc 12', '3 pcs'])(
    'does not strip words that are not currency codes from %j',
    (text) => {
      expect(parseNumber(text)).toBeNull();
    },
  );

  it.each(['abc', '', '1.2.3', '12,34,5', 'NaN', '--', '.'])('refuses %j as a number', (text) => {
    expect(parseNumber(text)).toBeNull();
  });

  it.each([
    ['2026-03-05', '2026-03-05'],
    ['2026-03-05T10:00:00Z', '2026-03-05'],
    ['2026/3/5', '2026-03-05'],
    ['05.03.2026', '2026-03-05'],
    ['5.3.26', '2026-03-05'],
    ['25/12/2026', '2026-12-25'],
    ['12/25/2026', '2026-12-25'],
    ['7/7/2026', '2026-07-07'],
    ['March 5, 2026', '2026-03-05'],
    ['5 Mar 2026', '2026-03-05'],
    ['3rd October 2026', '2026-10-03'],
    ['Sept 1 2026', '2026-09-01'],
  ])('reads the date %j', (text, iso) => {
    expect(parseDate(text)).toBe(iso);
  });

  it('refuses impossible dates and says when day and month could swap', () => {
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('31.04.2026')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
    expect(parseDate('03/05/2026')).toEqual({ ambiguous: true });
  });

  it('normalises each type, flagging what needs a look', () => {
    const field = (type: FieldDef['type'], extra: Partial<FieldDef> = {}) => ({ type, ...extra });
    expect(normalizeValue(field('currency'), '$1,234.5')).toEqual({ value: 1234.5 });
    expect(normalizeValue(field('number'), 'twelve')).toEqual({
      value: 'twelve',
      issue: 'Not a number.',
    });
    expect(normalizeValue(field('date'), '03/05/2026').issue).toMatch(/either way round/);
    expect(normalizeValue(field('date'), 'soon').issue).toMatch(/Not a date/);
    expect(normalizeValue(field('boolean'), 'Yes')).toEqual({ value: true });
    expect(normalizeValue(field('boolean'), 'nein')).toEqual({ value: false });
    expect(normalizeValue(field('boolean'), 'maybe').issue).toBe('Not yes or no.');
    expect(normalizeValue(field('enum', { options: ['cash', 'card'] }), 'CARD')).toEqual({
      value: 'card',
    });
    expect(normalizeValue(field('enum', { options: ['cash', 'card'] }), 'cheque').issue).toBe(
      'Not one of: cash, card.',
    );
    expect(normalizeValue(field('list'), 'a; b\nc')).toEqual({ value: ['a', 'b', 'c'] });
    expect(normalizeValue(field('list'), ['x', ' ', 'y'])).toEqual({ value: ['x', 'y'] });
    expect(normalizeValue(field('text'), 12)).toEqual({ value: '12' });
    expect(normalizeValue(field('text'), '  ')).toEqual({ value: null });
    expect(normalizeValue(field('table'), null)).toEqual({ value: [] });
  });

  it('normalises a whole answer, line items included, and lists missing required fields', () => {
    const { values, issues } = normalizeRecord(invoice, {
      vendor_name: 'Café Lumière',
      invoice_date: '3 October 2026',
      total: '9,02',
      payment_method: 'Card',
      line_items: [
        { description: 'Croissant', quantity: '2', unit_price: '2.20', amount: 4.4 },
        { description: 'Café crème', quantity: 'one', unit_price: 3.8, amount: 3.8 },
      ],
      unexpected: 'ignored',
    });
    expect(values).toMatchObject({
      vendor_name: 'Café Lumière',
      invoice_date: '2026-10-03',
      total: 9.02,
      payment_method: 'card',
      tax: null,
      line_items: [
        { description: 'Croissant', quantity: 2, unit_price: 2.2, amount: 4.4 },
        { description: 'Café crème', quantity: 'one', unit_price: 3.8, amount: 3.8 },
      ],
    });
    expect(values).not.toHaveProperty('unexpected');
    expect(issues).toEqual({ 'line_items[1].quantity': 'Not a number.' });

    expect(normalizeRecord(invoice, { total: 5 }).issues).toMatchObject({
      vendor_name: 'Required, but not found.',
      invoice_date: 'Required, but not found.',
    });
  });

  it('shows values as cell text', () => {
    expect(valueText(['a', 'b'])).toBe('a; b');
    expect(valueText(true)).toBe('Yes');
    expect(valueText(null)).toBe('');
    expect(valueText(12.5)).toBe('12.5');
  });
});

describe('extractJson', () => {
  it('finds JSON as it is, in a fence, or inside chatter, and refuses prototype keys', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! {"a":3} Hope that helps.')).toEqual({ a: 3 });
    expect(extractJson('not json')).toBeUndefined();
    const parsed = extractJson('{"__proto__":{"polluted":true},"a":1}') as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
