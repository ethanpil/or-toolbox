/**
 * Table extractor: two tables found on one page (one from a chart), edited in their grids, exported as an XLSX
 * with a sheet per table, a ZIP of CSVs, a single CSV once one table is left, and copied as TSV.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { expect, MEDIA_FIXTURES_DIR, test } from '../mock/index.ts';
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

const TABLES = {
  tables: [
    {
      title: 'Quarterly revenue',
      kind: 'table',
      headers: ['Region', 'Q1', 'Q2'],
      rows: [
        ['North', '1,200', '1,350'],
        ['=HYPERLINK("http://evil")', '98', '101'],
      ],
      notes: 'EUR thousands',
    },
    {
      title: 'Sales by year',
      kind: 'chart',
      headers: ['Year', 'Sales'],
      rows: [
        ['2024', '10'],
        ['2025', '12'],
      ],
      notes: 'Read from a chart',
    },
  ],
};

async function save(page: Page, testId: string): Promise<{ name: string; bytes: Buffer }> {
  await page.getByTestId('te-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId(testId).click(),
  ]);
  return { name: download.suggestedFilename(), bytes: readFileSync(await download.path()) };
}

test('two tables on a page: edit, export XLSX, a ZIP of CSVs, one CSV, and copy as TSV', async ({
  page,
  context,
  mock,
}) => {
  test.slow();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedApp(context, {
    key: true,
    settings: { tools: { 'table-extractor': { model: 'test/vision' } } },
  });
  mock.json('GET', '/api/v1/models', { data: [MODEL] });
  mock.json('POST', '/api/v1/chat/completions', {
    id: 'gen-1',
    model: 'test/vision',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(TABLES) },
      },
    ],
    usage: { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, cost: 0.0026 },
  });
  const problems = await watchForProblems(page);
  await page.goto('tools/table-extractor/');
  await page
    .getByTestId('doc-drop-zone')
    .locator('input[type=file]')
    .setInputFiles(join(MEDIA_FIXTURES_DIR, 'generated-image.jpg'));
  await expect(page.getByTestId('doc-count')).toHaveText('1 file · 1 page');
  await page.getByTestId('run-button').click();

  const tables = page.getByTestId('te-table');
  await expect(tables).toHaveCount(2);
  await expect(page.getByTestId('te-summary')).toHaveText('2 tables · 4 rows · 1 of 1 page read');
  await expect(tables.nth(1)).toContainText('From a chart');
  const body = mock.calls('/api/v1/chat/completions')[0]!.body as { response_format: unknown };
  expect(body.response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { name: 'tables', strict: true },
  });

  // Edit: a cell, a header, a new row, a new column.
  const first = tables.nth(0);
  await first.getByLabel('Q2, row 2, Quarterly revenue', { exact: true }).fill('102');
  await first.getByLabel('Q2, row 2, Quarterly revenue', { exact: true }).press('Tab');
  await first.getByLabel('Header of column 1, Quarterly revenue').fill('Area');
  await first.getByLabel('Header of column 1, Quarterly revenue').press('Tab');
  await first.getByTestId('te-add-row').click();
  await expect(first.getByTestId('te-row')).toHaveCount(3);
  // Focus moved into the new row's first cell; the grid is one Tab stop, the arrow keys move between cells.
  await page.keyboard.type('South');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('75');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('80');
  await expect(first.getByLabel('Q2, row 3, Quarterly revenue', { exact: true })).toBeFocused();
  // Tab leaves the grid for the buttons under it.
  await page.keyboard.press('Tab');
  await expect(first.getByTestId('te-add-row')).toBeFocused();
  await expect(first.getByTestId('te-add-row')).toHaveAccessibleName(
    'Add row to Quarterly revenue',
  );
  const second = tables.nth(1);
  await second.getByTestId('te-add-column').click();
  await expect(second.getByTestId('te-header')).toHaveCount(3);
  await expect(second.getByTestId('te-header').nth(2)).toBeFocused();
  await second.getByTestId('te-header').nth(2).fill('Forecast');
  await second.getByTestId('te-header').nth(2).press('Tab');
  await expect(page.getByTestId('te-table-meta').nth(0)).toHaveText(
    'generated-image.jpg · 3 rows × 3 columns',
  );

  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoSeriousA11yViolations(page);

  // XLSX: one sheet per table, numeric columns as numbers, the edits in place.
  const xlsx = await save(page, 'export-xlsx');
  expect(xlsx.name).toBe('generated-image-tables.xlsx');
  const book = unzipSync(new Uint8Array(xlsx.bytes));
  const workbook = strFromU8(book['xl/workbook.xml']!);
  expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((match) => match[1])).toEqual([
    'Quarterly revenue',
    'Sales by year',
  ]);
  const sheet1 = strFromU8(book['xl/worksheets/sheet1.xml']!);
  expect(sheet1).toContain('<c r="B2"><v>1200</v></c>');
  expect(sheet1).toContain('<c r="C3"><v>102</v></c>');
  expect(sheet1).toContain('<c r="C4"><v>80</v></c>');
  const strings = strFromU8(book['xl/sharedStrings.xml']!);
  expect(strings).toContain('<t>Area</t>');
  expect(strings).toContain('<t>Forecast</t>');

  // A ZIP with one CSV per table, formulas defused.
  const zip = await save(page, 'export-zip');
  expect(zip.name).toBe('generated-image-tables-csv.zip');
  const csvs = unzipSync(new Uint8Array(zip.bytes));
  expect(Object.keys(csvs)).toEqual(['1-quarterly-revenue.csv', '2-sales-by-year.csv']);
  const csvBytes = csvs['1-quarterly-revenue.csv']!;
  expect([...csvBytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 byte order mark for Excel
  // (strFromU8 drops the byte order mark while decoding.)
  expect(strFromU8(csvBytes).split('\r\n')).toEqual([
    'Area,Q1,Q2',
    'North,"1,200","1,350"',
    `"'=HYPERLINK(""http://evil"")",98,102`,
    'South,75,80',
  ]);

  // Copy as TSV for a spreadsheet.
  await first.getByTestId('te-copy').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Copied' })).toBeVisible();
  const tsv = await page.evaluate(() => navigator.clipboard.readText());
  // The system clipboard may turn line feeds into CRLF (Windows).
  expect(tsv.split(/\r?\n/)).toEqual([
    'Area\tQ1\tQ2',
    'North\t1,200\t1,350',
    `"'=HYPERLINK(""http://evil"")"\t98\t102`,
    'South\t75\t80',
  ]);

  // Delete the chart table (Undo brings it back), then delete it for good: one table exports as one CSV.
  await second.getByTestId('te-delete').click();
  await expect(tables).toHaveCount(1);
  await page.getByTestId('toast').filter({ hasText: 'Deleted' }).getByTestId('toast-undo').click();
  await expect(tables).toHaveCount(2);
  await tables.nth(1).getByTestId('te-delete').click();
  await expect(tables).toHaveCount(1);
  const csv = await save(page, 'export-csv');
  expect(csv.name).toBe('1-quarterly-revenue.csv');
  expect(csv.bytes.toString('utf8')).toContain('South,75,80');

  expect(problems).toEqual([]);
});
