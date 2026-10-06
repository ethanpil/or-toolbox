/**
 * Writes the sample workbook to the path in `XLSX_OUT` for `scripts/check-xlsx.py`; skipped without it, so a normal
 * `npm run test` writes nothing. CI: `XLSX_OUT=sample.xlsx npx vitest run src/core/export/xlsx-sample.test.ts`.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SHEETS } from './xlsx-sample';
import { toXlsx } from './xlsx';

const out = process.env['XLSX_OUT'];

describe('the sample workbook for a real reader', () => {
  it.skipIf(!out)('is written to XLSX_OUT', async () => {
    const blob = await toXlsx(SAMPLE_SHEETS);
    writeFileSync(out!, new Uint8Array(await blob.arrayBuffer()));
    expect(blob.size).toBeGreaterThan(1000);
  });

  it('builds without a reader', async () => {
    expect((await toXlsx(SAMPLE_SHEETS)).size).toBeGreaterThan(1000);
  });
});
