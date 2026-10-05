/**
 * Ready-made schemas. Invoice/receipt is the default (PLAN.md). Field names are JSON keys; descriptions are
 * what the model reads.
 */
import type { ColumnDef, FieldDef } from './schema';

export interface Preset {
  id: string;
  name: string;
  fields: FieldDef[];
}

const text = (name: string, description: string, required = false): FieldDef => ({
  name,
  type: 'text',
  description,
  required,
});
const field = (
  name: string,
  type: FieldDef['type'],
  description: string,
  required = false,
): FieldDef => ({
  name,
  type,
  description,
  required,
});
const column = (name: string, type: ColumnDef['type'], description: string): ColumnDef => ({
  name,
  type,
  description,
});

export const PRESETS: readonly Preset[] = [
  {
    id: 'invoice',
    name: 'Invoice / receipt',
    fields: [
      text('vendor_name', 'Business that issued the invoice or receipt.', true),
      text('vendor_address', 'Address of the vendor, on one line.'),
      text('invoice_number', 'Invoice, receipt or transaction number.'),
      field('invoice_date', 'date', 'Date of the invoice or purchase.', true),
      field('due_date', 'date', 'Payment due date, if shown.'),
      text('currency', 'ISO 4217 code of the amounts, such as USD or EUR.'),
      field('subtotal', 'currency', 'Total before tax.'),
      field('tax', 'currency', 'Total tax (VAT, GST, sales tax).'),
      field('total', 'currency', 'Amount due or paid, including tax.', true),
      {
        name: 'payment_method',
        type: 'enum',
        description: 'How it was paid, if shown.',
        required: false,
        options: ['cash', 'card', 'bank transfer', 'other'],
      },
      {
        name: 'line_items',
        type: 'table',
        description: 'Every purchased item or service line.',
        required: false,
        columns: [
          column('description', 'text', 'What was bought.'),
          column('quantity', 'number', 'How many.'),
          column('unit_price', 'currency', 'Price of one.'),
          column('amount', 'currency', 'Line total.'),
        ],
      },
    ],
  },
  {
    id: 'purchase-order',
    name: 'Purchase order',
    fields: [
      text('po_number', 'Purchase order number.', true),
      field('order_date', 'date', 'Date of the order.', true),
      text('buyer', 'Company placing the order.'),
      text('supplier', 'Company receiving the order.'),
      field('delivery_date', 'date', 'Requested delivery date.'),
      text('currency', 'ISO 4217 code of the amounts.'),
      field('total', 'currency', 'Order total.'),
      {
        name: 'line_items',
        type: 'table',
        description: 'Ordered items.',
        required: false,
        columns: [
          column('sku', 'text', 'Item number or SKU.'),
          column('description', 'text', 'Item description.'),
          column('quantity', 'number', 'Quantity ordered.'),
          column('unit_price', 'currency', 'Price of one.'),
          column('amount', 'currency', 'Line total.'),
        ],
      },
    ],
  },
  {
    id: 'business-card',
    name: 'Business card',
    fields: [
      text('full_name', 'Name of the person.', true),
      text('job_title', 'Role or title.'),
      text('company', 'Company or organization.'),
      field('emails', 'list', 'Email addresses.'),
      field('phones', 'list', 'Phone numbers, as printed.'),
      text('website', 'Web address.'),
      text('address', 'Postal address, on one line.'),
    ],
  },
  {
    id: 'resume',
    name: 'Resume',
    fields: [
      text('full_name', 'Name of the candidate.', true),
      text('email', 'Email address.'),
      text('phone', 'Phone number.'),
      text('location', 'City and country.'),
      text('summary', 'Profile or summary paragraph.'),
      field('skills', 'list', 'Skills, one per item.'),
      {
        name: 'experience',
        type: 'table',
        description: 'Jobs, most recent first.',
        required: false,
        columns: [
          column('company', 'text', 'Employer.'),
          column('title', 'text', 'Role.'),
          column('start_date', 'date', 'Start (first of the month when only a month is given).'),
          column('end_date', 'date', 'End; null while current.'),
          column('description', 'text', 'What they did, briefly.'),
        ],
      },
      {
        name: 'education',
        type: 'table',
        description: 'Degrees and schools.',
        required: false,
        columns: [
          column('institution', 'text', 'School or university.'),
          column('degree', 'text', 'Degree or qualification.'),
          column('year', 'text', 'Year finished.'),
        ],
      },
    ],
  },
  {
    id: 'bank-statement',
    name: 'Bank statement lines',
    fields: [
      text('account_holder', 'Name on the account.'),
      text('account_number', 'Account number or IBAN, as printed.'),
      field('statement_start', 'date', 'First day of the statement period.'),
      field('statement_end', 'date', 'Last day of the statement period.'),
      text('currency', 'ISO 4217 code of the account.'),
      field('opening_balance', 'currency', 'Balance at the start.'),
      field('closing_balance', 'currency', 'Balance at the end.'),
      {
        name: 'transactions',
        type: 'table',
        description: 'Every transaction line, in order.',
        required: true,
        columns: [
          column('date', 'date', 'Booking date.'),
          column('description', 'text', 'Description or payee.'),
          column('amount', 'currency', 'Amount: negative for money out, positive for money in.'),
          column('balance', 'currency', 'Running balance, if shown.'),
        ],
      },
    ],
  },
];

export const DEFAULT_PRESET = 'invoice';

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}
