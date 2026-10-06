/**
 * The workbook CI hands to a real spreadsheet reader (`scripts/check-xlsx.py`, openpyxl): numbers with a currency
 * format, dates, booleans, text that looks like a number or a formula, long and non-Latin text, characters XML
 * treats specially, an empty cell, and several sheets (one with a name Excel would refuse). The checker states what
 * each cell must read back as; change the two together.
 */
import type { XlsxSheet } from './xlsx';

export const SAMPLE_SHEETS: readonly XlsxSheet[] = [
  {
    name: 'Invoices',
    columns: [
      'id',
      { key: 'amount', header: 'Amount', type: 'number', format: '#,##0.00' },
      'paid',
      { key: 'issued', header: 'Issued', type: 'date' },
      { key: 'sent', header: 'Sent', type: 'date' },
      'note',
    ],
    rows: [
      {
        id: 'INV-001',
        amount: 1234.5,
        paid: true,
        issued: new Date(Date.UTC(2026, 2, 5)),
        sent: '2026-03-05T14:30:00Z',
        note: 'Café – 日本語 😀',
      },
      { id: '007', amount: '99.90', paid: false, issued: '2026-12-31', sent: null, note: null },
      {
        id: 'INV-003',
        amount: null,
        paid: null,
        issued: 'not a date',
        sent: '',
        note: '=SUM(A1:A2)',
      },
    ],
  },
  {
    name: 'Text',
    columns: ['kind', 'text'],
    rows: [
      { kind: 'xml', text: '<tag attr="1"> & \'quotes\'' },
      { kind: 'lines', text: 'first line\nsecond line' },
      { kind: 'long', text: 'x'.repeat(40_000) },
    ],
  },
  { name: 'Q1/Q2: totals?', columns: ['n'], rows: [{ n: 1 }, { n: -2.5 }, { n: 1e21 }] },
];
