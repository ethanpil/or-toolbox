import { expect, test } from '../../mock/index.ts';
import { openMediaPage } from './support.ts';

test.setTimeout(180_000);

test('writes large workbooks, documents and archives under the page CSP, and saves downloads', async ({
  page,
}) => {
  const problems = await openMediaPage(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => {
      const { files } = window.__media as NonNullable<Window['__media']>;
      files.downloadBlob(
        new Blob(['hello download'], { type: 'text/plain' }),
        'report: final?.txt',
      );
    }),
  ]);
  expect(download.suggestedFilename()).toBe('report_ final_.txt');

  const result = await page.evaluate(async () => {
    const { xlsx, docx, zip } = window.__media as NonNullable<Window['__media']>;
    const starts = async (blob: Blob): Promise<string> =>
      Array.from(new Uint8Array(await blob.slice(0, 2).arrayBuffer()), (b) =>
        String.fromCharCode(b),
      ).join('');

    // 20,000 rows: the sheet XML is several MB. fflate compresses anything over 160 KB in a worker it
    // builds from a blob: URL, which `worker-src 'self'` forbids, so this proves that path is not taken.
    const rows = Array.from({ length: 20_000 }, (_, i) => ({
      id: i,
      name: `Item number ${i}`,
      amount: i * 1.5,
      text: `text ${i} with some more words to make it longer`,
      date: new Date(Date.UTC(2026, 0, 1 + (i % 300))),
      flag: i % 2 === 0,
      note: `note ${i}`,
    }));
    const started = performance.now();
    const big = await xlsx
      .toXlsx([{ name: 'Big', columns: Object.keys(rows[0] ?? {}), rows }])
      .then(
        async (blob) => ({ ok: true, size: blob.size, signature: await starts(blob) }),
        (error: unknown) => ({ ok: false, message: String(error) }),
      );
    const bigMs = Math.round(performance.now() - started);

    const document = await docx.toDocx('# Title\n\nSome **bold** text.\n\n- one\n- two\n');
    const archive = await zip.zipFiles([
      { name: 'a.txt', data: 'x'.repeat(500_000) },
      { name: 'a.txt', data: 'again' },
    ]);
    return {
      big,
      bigMs,
      docx: { type: document.type, signature: await starts(document), size: document.size },
      zip: { type: archive.type, signature: await starts(archive), size: archive.size },
    };
  });

  console.info(`20,000-row workbook: ${JSON.stringify(result.big)} in ${result.bigMs} ms`);
  expect(result.big).toMatchObject({ ok: true, signature: 'PK' });
  expect(result.docx).toMatchObject({
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signature: 'PK',
  });
  expect(result.zip).toMatchObject({ type: 'application/zip', signature: 'PK' });
  expect(result.zip.size).toBeLessThan(5_000);
  expect(problems).toEqual([]);
});
