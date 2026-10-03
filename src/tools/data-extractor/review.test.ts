import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocResult } from './export';
import { presetById } from './presets';
import { reviewGrid } from './review';
import { normalizeRecord } from './schema';

const fields = presetById('invoice')!.fields;

function makeDoc(): DocResult {
  const { values, issues } = normalizeRecord(fields, {
    vendor_name: 'Shop',
    total: 'twelve',
    payment_method: 'card',
    line_items: [{ description: 'Tea', quantity: 2, unit_price: 2.5, amount: 5 }],
  });
  return {
    key: 'f1:1',
    index: 1,
    fileId: 'f1',
    fileName: 'receipt.png',
    pages: [1],
    pageCount: 1,
    status: 'done',
    values,
    issues,
    edited: [],
    error: null,
  };
}

const input = (root: ParentNode, label: string): HTMLInputElement | HTMLSelectElement =>
  root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;

afterEach(() => {
  document.body.replaceChildren();
});

describe('review grid', () => {
  const mount = () => {
    const doc = makeDoc();
    const onEdit = vi.fn();
    const onSource = vi.fn();
    const grid = reviewGrid({ fields: () => fields, onEdit, onRetry: vi.fn(), onSource });
    document.body.append(grid.element);
    grid.render([doc]);
    return { doc, grid, onEdit, onSource };
  };

  it('flags missing required fields and unreadable values', () => {
    const { grid } = mount();
    const date = input(grid.element, 'Invoice date, document 1');
    expect(date.getAttribute('aria-invalid')).toBe('true');
    expect(date.parentElement?.textContent).toContain('Required, but not found.');
    expect(input(grid.element, 'Total, document 1').value).toBe('twelve');
    expect(grid.element.querySelector('[data-testid="de-issues"]')?.textContent).toBe('2 to check');
    // Required columns are marked in the header, for screen readers too.
    expect(grid.element.querySelector('thead')?.textContent).toContain('Total * (required)');
  });

  it('keeps a correction, normalised, and clears its issue', () => {
    const { doc, grid, onEdit } = mount();
    const total = input(grid.element, 'Total, document 1') as HTMLInputElement;
    total.value = '$1,234.50';
    total.dispatchEvent(new Event('change'));
    expect(doc.values['total']).toBe(1234.5);
    expect(doc.issues['total']).toBeUndefined();
    expect(doc.edited).toEqual(['total']);
    expect(total.getAttribute('aria-invalid')).toBeNull();
    expect(onEdit).toHaveBeenCalledWith(doc);
    expect(grid.element.querySelector('[data-testid="de-issues"]')?.textContent).toBe('1 to check');

    const date = input(grid.element, 'Invoice date, document 1') as HTMLInputElement;
    date.value = '31.02.2026';
    date.dispatchEvent(new Event('change'));
    expect(doc.issues['invoice_date']).toMatch(/Not a date/);
    expect(date.getAttribute('aria-invalid')).toBe('true');
    date.value = '1 March 2026';
    date.dispatchEvent(new Event('change'));
    expect(doc.values['invoice_date']).toBe('2026-03-01');

    const method = input(grid.element, 'Payment method, document 1') as HTMLSelectElement;
    expect(method.value).toBe('card');
    method.value = 'cash';
    method.dispatchEvent(new Event('change'));
    expect(doc.values['payment_method']).toBe('cash');
  });

  it('opens line items, edits a cell, adds and removes rows', () => {
    const { doc, grid } = mount();
    const expand = grid.element.querySelector<HTMLButtonElement>('[data-testid="de-expand"]')!;
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(expand.textContent).toContain('1 row');
    expand.focus();
    expand.click();
    const reopened = grid.element.querySelector<HTMLButtonElement>('[data-testid="de-expand"]')!;
    expect(reopened.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(reopened);
    expect(grid.element.querySelectorAll('[data-testid="de-item"]')).toHaveLength(1);

    const quantity = input(
      grid.element,
      'Quantity, row 1, Line items of document 1',
    ) as HTMLInputElement;
    quantity.value = '3';
    quantity.dispatchEvent(new Event('change'));
    expect((doc.values['line_items'] as Record<string, unknown>[])[0]?.['quantity']).toBe(3);

    grid.element.querySelector<HTMLButtonElement>('[data-testid="de-add-item"]')!.click();
    expect(grid.element.querySelectorAll('[data-testid="de-item"]')).toHaveLength(2);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Description, row 2, Line items of document 1',
    );
    const amount = input(
      grid.element,
      'Amount, row 2, Line items of document 1',
    ) as HTMLInputElement;
    amount.value = 'abc';
    amount.dispatchEvent(new Event('change'));
    expect(doc.issues['line_items[1].amount']).toBe('Not a number.');

    grid.element
      .querySelector<HTMLButtonElement>('[aria-label="Remove row 1 of Line items of document 1"]')!
      .click();
    expect((doc.values['line_items'] as unknown[]).length).toBe(1);
    // The issue moved up with its row.
    expect(doc.issues['line_items[0].amount']).toBe('Not a number.');
    expect(doc.issues['line_items[1].amount']).toBeUndefined();
  });

  it('keeps text typed in one row while another row is redrawn', () => {
    const doc = makeDoc();
    const other = { ...makeDoc(), key: 'f2:1', index: 2, fileName: 'other.png' };
    const grid = reviewGrid({
      fields: () => fields,
      onEdit: vi.fn(),
      onRetry: vi.fn(),
      onSource: vi.fn(),
    });
    document.body.append(grid.element);
    grid.render([doc, other]);
    const vendor = input(grid.element, 'Vendor name, document 1') as HTMLInputElement;
    vendor.focus();
    vendor.value = 'Half-typ';
    vendor.dispatchEvent(new Event('input'));
    other.status = 'failed';
    grid.update(other);
    expect(input(grid.element, 'Vendor name, document 1')).toBe(vendor);
    grid.update(doc);
    const redrawn = input(grid.element, 'Vendor name, document 1') as HTMLInputElement;
    expect(redrawn.value).toBe('Half-typ');
    expect(document.activeElement).toBe(redrawn);
  });

  it('opens the source of a row', () => {
    const { doc, grid, onSource } = mount();
    grid.element.querySelector<HTMLButtonElement>('[data-testid="de-source"]')!.click();
    expect(onSource).toHaveBeenCalledWith(doc);
  });
});
