/**
 * Stage 3 gate, Data extractor: ten synthetic receipts (drawn on a canvas in the page) through the Invoice /
 * receipt preset with mocked strict structured answers, one cell corrected in the review grid, and the XLSX
 * export opened and checked as OOXML: content types, workbook, two sheets, shared strings, numbers as numbers,
 * dates as dates, the correction present. (Python's openpyxl is not installed on the development machine, so
 * the workbook is checked here by unzipping it; the parts are also parsed as XML in the browser.)
 */
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { expect, type RecordedCall, test } from '../mock/index.ts';
import { seedApp } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const MODEL = {
  id: 'test/vision',
  name: 'Test: Vision',
  created: 1750000000,
  description: 'Vision model with structured outputs.',
  context_length: 128000,
  architecture: {
    modality: 'text+image->text',
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
  },
  pricing: { prompt: '0.000001', completion: '0.000002' },
  top_provider: { context_length: 128000, max_completion_tokens: 8192, is_moderated: false },
  supported_parameters: ['max_tokens', 'temperature', 'response_format', 'structured_outputs'],
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** What the "model" reads on receipt n. Receipt 10 has no vendor name (a missing required field). */
function receipt(n: number): Record<string, unknown> {
  return {
    vendor_name: n === 10 ? null : `Shop ${n}`,
    vendor_address: null,
    invoice_number: `R-${pad(n)}`,
    invoice_date: `2026-09-${pad(n)}`,
    due_date: null,
    currency: 'EUR',
    subtotal: 10 + n,
    tax: 0.25,
    total: 10.25 + n,
    payment_method: 'card',
    line_items: [
      { description: 'Coffee', quantity: n, unit_price: 2.5, amount: n * 2.5 },
      { description: 'Bagel', quantity: 1, unit_price: 3.75, amount: 3.75 },
    ],
  };
}

function fileOf(call: RecordedCall): string {
  const body = call.body as { messages: { content: string | { type: string; text?: string }[] }[] };
  const parts = body.messages[1]?.content;
  return /“(.+?)”/.exec(Array.isArray(parts) ? (parts[0]?.text ?? '') : '')?.[1] ?? '';
}

/** Draws ten receipts and hands them to the drop zone's file input, as choosing them would. */
async function addReceipts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="doc-drop-zone"] input[type=file]',
    )!;
    const transfer = new DataTransfer();
    for (let n = 1; n <= 10; n++) {
      const canvas = document.createElement('canvas');
      canvas.width = 420;
      canvas.height = 560;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = '#111111';
      g.font = 'bold 26px sans-serif';
      g.fillText(`Shop ${n}`, 24, 50);
      g.font = '18px monospace';
      const lines = [
        `Receipt R-${String(n).padStart(2, '0')}`,
        `2026-09-${String(n).padStart(2, '0')}`,
        `${n} x Coffee   ${(n * 2.5).toFixed(2)}`,
        '1 x Bagel     3.75',
        `Total EUR     ${(10.25 + n).toFixed(2)}`,
      ];
      lines.forEach((line, i) => g.fillText(line, 24, 110 + i * 34));
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      transfer.items.add(
        new File([blob], `receipt-${String(n).padStart(2, '0')}.png`, { type: 'image/png' }),
      );
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByTestId('doc-count')).toHaveText('10 files · 10 pages');
}

/** Cells of a worksheet by reference: type, style and value. */
function cells(xml: string): Map<string, { t?: string; s?: string; v?: string }> {
  const map = new Map<string, { t?: string; s?: string; v?: string }>();
  for (const match of xml.matchAll(
    /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g,
  )) {
    const attributes = match[2] ?? '';
    map.set(match[1]!, {
      t: /\bt="(\w+)"/.exec(attributes)?.[1],
      s: /\bs="(\d+)"/.exec(attributes)?.[1],
      v: match[3],
    });
  }
  return map;
}

/** The number format code a style index applies. */
function formatOf(styles: string, style: string | undefined): string | null {
  if (style === undefined) return null;
  const xfs = [
    ...(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '').matchAll(/<xf ([^>]*)\/>/g),
  ];
  const id = /numFmtId="(\d+)"/.exec(xfs[Number(style)]?.[1] ?? '')?.[1];
  if (!id) return null;
  return (
    new RegExp(`<numFmt numFmtId="${id}" formatCode="([^"]*)"`).exec(styles)?.[1] ?? `builtin:${id}`
  );
}

const excelSerial = (iso: string): number => Date.parse(`${iso}T00:00:00Z`) / 86_400_000 + 25_569;

test('ten receipts to an XLSX: extracted, corrected in the grid, valid OOXML', async ({
  page,
  context,
  mock,
}) => {
  test.slow();
  await seedApp(context, {
    key: true,
    settings: { tools: { 'data-extractor': { model: 'test/vision' } } },
  });
  mock.json('GET', '/api/v1/models', { data: [MODEL] });
  mock.respond('POST', '/api/v1/chat/completions', (call) => {
    const n = Number(/receipt-(\d+)/.exec(fileOf(call))?.[1]);
    return {
      body: {
        id: `gen-${n}`,
        model: 'test/vision',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(receipt(n)) },
          },
        ],
        usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200, cost: 0.0024 },
      },
    };
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/data-extractor/');
  await expect(page.getByTestId('de-schema-select')).toHaveValue('preset:invoice');
  await addReceipts(page);
  await page.getByTestId('run-button').click();

  await expect(page.getByTestId('de-summary')).toHaveText(
    '10 of 10 documents extracted · 1 to check',
  );
  const calls = mock.calls('/api/v1/chat/completions');
  expect(calls).toHaveLength(10);
  expect((calls[0]!.body as { response_format: unknown }).response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { name: 'extraction', strict: true },
  });
  await expect(page.getByTestId('de-row')).toHaveCount(10);
  // Receipt 10 has no vendor: flagged in its row.
  const vendorTen = page.getByLabel('Vendor name, document 10', { exact: true });
  await expect(vendorTen).toHaveAttribute('aria-invalid', 'true');

  // Correct the total of receipt 3 (13.25 → 99.95).
  const total = page.getByLabel('Total, document 3', { exact: true });
  await expect(total).toHaveValue('13.25');
  await total.fill('€ 99,95');
  await total.press('Tab');
  await expect(total).toHaveValue('99.95');
  await expect(page.getByTestId('de-summary')).toHaveText(
    '10 of 10 documents extracted · 1 to check · 1 corrected',
  );

  // Line items open under their row.
  await page.getByTestId('de-row').nth(2).getByTestId('de-expand').click();
  await expect(page.getByTestId('de-items')).toBeVisible();
  await expect(page.getByLabel('Quantity, row 1, Line items of document 3')).toHaveValue('3');

  // The source page opens from the grid.
  await page.getByTestId('de-row').nth(2).getByTestId('de-source').click();
  await expect(page.getByTestId('de-source-dialog')).toBeVisible();
  await expect(page.getByTestId('de-source-image').locator('img')).toHaveJSProperty(
    'complete',
    true,
  );
  await page
    .getByTestId('de-source-dialog')
    .locator('.modal-footer')
    .getByRole('button', { name: 'Close' })
    .click();
  await expect(page.getByTestId('de-source-dialog')).toHaveCount(0);

  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);

  // Export the workbook and read it back.
  await page.getByTestId('de-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-xlsx').click(),
  ]);
  expect(download.suggestedFilename()).toBe('extracted-data.xlsx');
  const files = unzipSync(new Uint8Array(readFileSync(await download.path())));
  const part = (name: string): string => {
    expect(files[name], name).toBeDefined();
    return strFromU8(files[name]!);
  };

  // Every part is well-formed XML.
  const parts = Object.keys(files).filter((name) => /\.(xml|rels)$/.test(name));
  const malformed = await page.evaluate(
    (xmls) =>
      xmls
        .filter(([, xml]) =>
          new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror'),
        )
        .map(([name]) => name),
    parts.map((name) => [name, part(name)] as [string, string]),
  );
  expect(malformed).toEqual([]);

  const types = part('[Content_Types].xml');
  for (const override of [
    '/xl/workbook.xml',
    '/xl/worksheets/sheet1.xml',
    '/xl/worksheets/sheet2.xml',
    '/xl/styles.xml',
    '/xl/sharedStrings.xml',
  ]) {
    expect(types).toContain(`<Override PartName="${override}"`);
  }
  expect(part('_rels/.rels')).toContain('Target="xl/workbook.xml"');
  const workbook = part('xl/workbook.xml');
  expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'Documents',
    'Line items',
  ]);
  expect(part('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet2.xml"');

  const shared = part('xl/sharedStrings.xml');
  expect(shared).toMatch(/<sst [^>]*count="\d+" uniqueCount="\d+">/);
  const strings = [...shared.matchAll(/<si><t[^>]*>([^<]*)<\/t><\/si>/g)].map((match) => match[1]);
  const styles = part('xl/styles.xml');

  // Documents: header row, then documents 1-10 in rows 2-11.
  const documents = cells(part('xl/worksheets/sheet1.xml'));
  const text = (ref: string): string | undefined => {
    const cell = documents.get(ref);
    return cell?.t === 's' ? strings[Number(cell.v)] : undefined;
  };
  expect(['A1', 'D1', 'G1', 'L1'].map(text)).toEqual([
    'Document',
    'vendor_name',
    'invoice_date',
    'total',
  ]);
  expect(text('D4')).toBe('Shop 3');
  expect(text('B4')).toBe('receipt-03.png');
  expect(documents.get('D11')).toBeUndefined(); // receipt 10: no vendor
  for (let row = 2; row <= 11; row++) {
    const n = row - 1;
    const totalCell = documents.get(`L${row}`)!;
    expect(totalCell.t, `L${row} is a number`).toBeUndefined();
    expect(Number(totalCell.v)).toBe(n === 3 ? 99.95 : 10.25 + n);
    expect(formatOf(styles, totalCell.s)).toBe('#,##0.00');
    const date = documents.get(`G${row}`)!;
    expect(date.t).toBeUndefined();
    expect(Number(date.v)).toBe(excelSerial(`2026-09-${pad(n)}`));
    expect(formatOf(styles, date.s)).toBe('yyyy-mm-dd');
    expect(documents.get(`A${row}`)).toMatchObject({ v: String(n) });
  }

  // Line items: two per receipt, keyed by document number, quantities and amounts numeric.
  const items = cells(part('xl/worksheets/sheet2.xml'));
  expect([...items.keys()].filter((ref) => ref.startsWith('A')).length).toBe(21);
  expect(items.get('A6')).toMatchObject({ v: '3' });
  expect(items.get('D6')).toMatchObject({ v: '3' });
  expect(items.get('D6')?.t).toBeUndefined();
  expect(Number(items.get('F6')?.v)).toBe(7.5);

  expect(problems).toEqual([]);
});

test('build a schema with the keyboard, save it, and get it back from Prompts', async ({
  page,
  context,
}) => {
  await seedApp(context, { key: true });
  const problems = await watchForProblems(page);
  await page.goto('tools/data-extractor/');
  await page.getByTestId('de-edit-fields').click();
  await expect(page.getByTestId('de-field')).toHaveCount(11);

  // Add a field, name it, make it a choice, move it up with the keyboard.
  await page.getByTestId('de-add-field').click();
  const name = page.getByTestId('de-field-name').last();
  await expect(name).toBeFocused();
  await name.fill('Expense Category');
  await name.press('Tab');
  await expect(name).toHaveValue('expense_category');
  await page.getByTestId('de-field').last().getByTestId('de-field-type').selectOption('enum');
  await page
    .getByLabel('Choices of field expense_category, separated by commas')
    .fill('travel, meals, office');
  await page.getByLabel('Choices of field expense_category, separated by commas').press('Tab');
  const up = page.getByTestId('de-field').last().getByTestId('de-field-up');
  await up.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('de-field').nth(10)).toHaveAttribute(
    'data-field',
    'expense_category',
  );
  await expect(page.getByTestId('de-field').nth(10).getByTestId('de-field-up')).toBeFocused();
  await expect(page.getByTestId('de-schema-edited')).toBeVisible();

  // Save as a named schema; it is listed and selected.
  await page.getByTestId('de-schema-save').click();
  await page.getByTestId('prompt-input').fill('Expenses');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('de-schema-select').locator('option:checked')).toHaveText(
    'Expenses',
  );
  await expect(page.getByTestId('de-schema-edited')).toBeHidden();

  // Prompts round trip: save the form, switch schema, Use brings the fields back.
  await page.getByTestId('tool-prompt').fill('Receipts from the Berlin trip');
  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-save-current').click();
  await page.getByTestId('prompt-input').fill('Berlin');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('prompt-entry')).toHaveCount(1);
  await page.getByTestId('prompts-tab-saved').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('prompts-panel')).toBeHidden();
  await page.getByTestId('de-schema-select').selectOption('preset:business-card');
  await expect(page.getByTestId('de-field')).toHaveCount(7);
  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompt-entry').getByTestId('prompt-use').click();
  await expect(page.getByTestId('tool-prompt')).toHaveValue('Receipts from the Berlin trip');
  await expect(page.getByTestId('de-field')).toHaveCount(12);
  await expect(page.getByTestId('de-schema-select').locator('option:checked')).toHaveText(
    'Expenses',
  );
  expect(problems).toEqual([]);
});

test('Extract again asks before it replaces corrected values, and leaving asks until they are exported', async ({
  page,
  context,
  mock,
}) => {
  test.slow();
  await seedApp(context, {
    key: true,
    settings: { tools: { 'data-extractor': { model: 'test/vision' } } },
  });
  mock.json('GET', '/api/v1/models', { data: [MODEL] });
  mock.respond('POST', '/api/v1/chat/completions', (call) => {
    const n = Number(/receipt-(\d+)/.exec(fileOf(call))?.[1]);
    return {
      body: {
        id: `gen-${n}`,
        model: 'test/vision',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: JSON.stringify(receipt(n)) },
          },
        ],
        usage: { prompt_tokens: 2000, completion_tokens: 200, total_tokens: 2200, cost: 0.0024 },
      },
    };
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/data-extractor/');
  await addReceipts(page);
  await page.getByTestId('run-button').click();
  await expect(page.getByTestId('de-summary')).toHaveText(
    '10 of 10 documents extracted · 1 to check',
  );

  const total = page.getByLabel('Total, document 3', { exact: true });
  await total.fill('99.95');
  await total.press('Tab');
  await expect(page.getByTestId('de-summary')).toContainText('1 corrected');

  // The corrections are unsaved work: the app's leave dialog names them.
  const guard = page.getByTestId('leave-guard');
  await page.getByTestId('history-link').click();
  await expect(guard).toBeVisible();
  await expect(page.getByTestId('leave-guard-list')).toContainText(
    'Corrected values not exported yet',
  );
  await page.getByTestId('leave-guard-stay').click();
  await expect(guard).toBeHidden();

  // Extract again asks first; declining sends nothing and keeps the correction.
  await page.getByTestId('run-button').click();
  const question = page.getByTestId('discard-dialog');
  await expect(question).toBeVisible();
  await question.getByTestId('dialog-cancel').click();
  await expect(question).toHaveCount(0);
  expect(mock.calls('/api/v1/chat/completions')).toHaveLength(10);
  await expect(total).toHaveValue('99.95');

  // Once exported, the corrections are saved: leaving no longer asks.
  await page.getByTestId('de-export').click();
  await Promise.all([page.waitForEvent('download'), page.getByTestId('export-json').click()]);
  await page.getByTestId('history-link').click();
  await expect(page).toHaveURL(/\/history\//);
  expect(problems).toEqual([]);
});
