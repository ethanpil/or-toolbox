import { expect, test } from '../../mock/index.ts';
import { fixture, openMediaPage } from './support.ts';

test('opens a PDF, renders a page and reads its text, with the worker on our own origin', async ({
  page,
}) => {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async (invoice) => {
    const { pdf } = window.__media as NonNullable<Window['__media']>;
    const bytes = Uint8Array.from(atob(invoice.base64), (c) => c.charCodeAt(0));
    const doc = await pdf.openPdf(new Blob([bytes], { type: invoice.type }));

    const darkPixels = async (
      blob: Blob,
    ): Promise<{ width: number; height: number; dark: number }> => {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 100) dark++;
      return { width: bitmap.width, height: bitmap.height, dark };
    };

    const started = performance.now();
    const png = await doc.renderPage(1, { scale: 1 });
    const renderMs = performance.now() - started;
    const narrow = await doc.renderPage(1, { maxWidth: 306, type: 'image/jpeg', quality: 0.8 });
    const capped = await doc.renderPage(1, { scale: 4, maxPixels: 100_000 });
    const outOfRange = await doc.renderPage(2).then(
      () => 'rendered',
      (error: unknown) => (error as Error).name,
    );
    const text = await doc.pageText(1);
    await doc.close();

    const notPdf = await pdf.openPdf(new Blob(['hello'])).then(
      () => 'opened',
      (error: unknown) => (error as Error).message,
    );

    return {
      numPages: doc.numPages,
      png: { type: png.type, ...(await darkPixels(png)) },
      narrow: { type: narrow.type, ...(await darkPixels(narrow)) },
      capped: await darkPixels(capped),
      renderMs,
      outOfRange,
      text,
      notPdf,
    };
  }, fixture('invoice.pdf'));

  expect(result.numPages).toBe(1);
  // US Letter at 72 dpi.
  expect(result.png).toMatchObject({ type: 'image/png', width: 612, height: 792 });
  expect(result.png.dark).toBeGreaterThan(200); // the 24 pt line of text is on the page
  expect(result.narrow).toMatchObject({ type: 'image/jpeg', width: 306, height: 396 });
  expect(result.capped.width * result.capped.height).toBeLessThanOrEqual(100_000 + 2000);
  expect(result.outOfRange).toBe('RangeError');
  expect(result.text).toBe('Invoice 4711 total 128.50 EUR');
  expect(result.notPdf).toMatch(/not a valid PDF/);

  // pdf.js runs in a real worker served from this origin, not on the main thread.
  const origin = new URL(page.url()).origin;
  expect(workers.some((url) => /pdf\.worker/.test(url) && new URL(url).origin === origin)).toBe(
    true,
  );
  expect(problems).toEqual([]);
});

test('serves pdf.js its CMaps, fonts and image decoders from bundled files', async ({ page }) => {
  const problems = await openMediaPage(page);

  const result = await page.evaluate(async () => {
    const { pdf } = window.__media as NonNullable<Window['__media']>;
    const factory = new pdf.BundledDataFactory();
    const fetchOne = async (
      kind: 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl',
      filename: string,
    ): Promise<{ bytes: number; head: number[] }> => {
      const data = await factory.fetch({ kind, filename });
      return { bytes: data.length, head: Array.from(data.subarray(0, 4)) };
    };
    return {
      font: await fetchOne('standardFontDataUrl', 'LiberationSans-Regular.ttf'),
      cmap: await fetchOne('cMapUrl', 'UniJIS-UCS2-H.bcmap'),
      jpx: await fetchOne('wasmUrl', 'openjpeg.wasm'),
      jbig2: await fetchOne('wasmUrl', 'jbig2.wasm'),
      missing: await factory.fetch({ kind: 'cMapUrl', filename: 'Nope.bcmap' }).then(
        () => 'fetched',
        (error: unknown) => (error as Error).message,
      ),
    };
  });

  expect(result.font.bytes).toBeGreaterThan(100_000);
  expect(result.cmap.bytes).toBeGreaterThan(1000);
  // WebAssembly modules start with "\0asm".
  expect(result.jpx.head).toEqual([0, 0x61, 0x73, 0x6d]);
  expect(result.jbig2.head).toEqual([0, 0x61, 0x73, 0x6d]);
  expect(result.missing).toMatch(/not bundled/);
  expect(problems).toEqual([]);
});
