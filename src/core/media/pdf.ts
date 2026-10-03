/**
 * PDF reading with pdf.js 6, loaded on first use.
 *
 * Import this module dynamically (`await import('../../core/media/pdf')`):
 * the worker script and the bundled data files below are assets of whatever
 * chunk imports it, and a statically imported one is part of the page's eager
 * closure, which the service worker precaches (about 5 MB).
 *
 * Setup that matters here:
 *
 * - **Worker from our own origin.** The worker script is bundled by Vite
 *   (`?url`, so it gets a hashed name in the build and is served by the dev
 *   server) and pdf.js starts it with `new Worker(url, { type: 'module' })`.
 *   No CDN and no `blob:` worker, which the CSP (`worker-src 'self'`) forbids,
 *   and a same-origin script gets the COEP header from the service worker, so
 *   it also starts on cross-origin isolated pages. If the worker cannot start
 *   at all, pdf.js falls back to running on the main thread (slow, but it works).
 * - **No eval.** pdf.js 6 removed the `isEvalSupported` option together with
 *   its `new Function` code path, so there is nothing to switch off.
 * - **Binary data without a vendor folder.** CMaps (CJK fonts), the standard
 *   font set and the JPEG 2000 / JBIG2 decoders (scanned PDFs!) are files that
 *   pdf.js fetches by name. They are bundled as hashed assets instead, and a
 *   `BinaryDataFactory` maps pdf.js's names to those URLs, so no extra build
 *   step or fixed directory is needed. The ICC colour-management wasm is not
 *   bundled: ICC-based colours fall back to their device equivalents.
 */
import type * as PdfJs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { type EncodeOptions, toBlob } from './image';

export interface PdfPageImageOptions extends EncodeOptions {
  /** Pixels per PDF point (72 per inch). Default 2 (about 144 dpi). */
  scale?: number;
  /** Alternative to `scale`: render this many pixels wide. */
  maxWidth?: number;
  /** Never render taller than this many pixels (the scale is reduced to fit). */
  maxHeight?: number;
  /** Cap on total pixels, to stay inside browser canvas limits (Safari: about 16.7 million). Default 16,000,000. */
  maxPixels?: number;
}

export interface PdfDocument {
  numPages: number;
  /** Renders page `n` (1-based) on a white background. Default PNG at scale 2. */
  renderPage: (n: number, options?: PdfPageImageOptions) => Promise<Blob>;
  /** The page's embedded text (empty for scanned pages), lines separated by newlines. */
  pageText: (n: number) => Promise<string>;
  /** Frees the document and stops its worker. */
  close: () => Promise<void>;
}

export interface OpenPdfOptions {
  /** For encrypted PDFs. */
  password?: string;
}

// pdf.js asks for these files by name; the keys are paths from the project root.
const DATA_FILES = import.meta.glob<string>(
  [
    '/node_modules/pdfjs-dist/cmaps/*.bcmap',
    '/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
    '/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2}.wasm',
  ],
  { query: '?url', import: 'default', eager: true, exhaustive: true },
);

const DATA_FOLDERS = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
} as const;

/**
 * Serves pdf.js's CMaps, fonts and decoders from our bundled assets. See the
 * module note. Exported for the tests; nothing else needs it.
 */
export class BundledDataFactory {
  async fetch({
    kind,
    filename,
  }: {
    kind: keyof typeof DATA_FOLDERS;
    filename: string;
  }): Promise<Uint8Array> {
    const href = DATA_FILES[`/node_modules/pdfjs-dist/${DATA_FOLDERS[kind]}/${filename}`];
    if (!href) throw new Error(`pdf.js asked for ${filename}, which is not bundled.`);
    const response = await fetch(href);
    if (!response.ok) throw new Error(`Could not load ${filename}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

let library: Promise<typeof PdfJs> | undefined;

/** Loads pdf.js and points it at our worker. A failed load is not remembered. */
function loadPdfJs(): Promise<typeof PdfJs> {
  library ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, location.href).href;
    return pdfjs;
  });
  library.catch(() => {
    library = undefined;
  });
  return library;
}

function describeOpenError(error: unknown): Error {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PasswordException') {
    return new Error('This PDF is password-protected.', { cause: error });
  }
  if (name === 'InvalidPDFException') {
    return new Error('This file is not a valid PDF.', { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Opens a PDF. Always call `close()` when done; each open document owns a worker.
 *
 * ```ts
 * const pdf = await openPdf(file);
 * for (let n = 1; n <= pdf.numPages; n++) images.push(await pdf.renderPage(n, { maxWidth: 1600 }));
 * await pdf.close();
 * ```
 */
export async function openPdf(blob: Blob, options: OpenPdfOptions = {}): Promise<PdfDocument> {
  const pdfjs = await loadPdfJs();
  // pdf.js takes ownership of (transfers) the bytes, so hand it its own copy.
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    // Errors only: the default level warns about every missing optional resource.
    verbosity: pdfjs.VerbosityLevel.ERRORS,
    useWorkerFetch: false,
    BinaryDataFactory: BundledDataFactory,
    ...(options.password === undefined ? {} : { password: options.password }),
  });

  let pdf: PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined);
    throw describeOpenError(error);
  }

  const page = async (n: number): Promise<PDFPageProxy> => {
    if (!Number.isInteger(n) || n < 1 || n > pdf.numPages) {
      throw new RangeError(`Page ${n} does not exist (this PDF has ${pdf.numPages}).`);
    }
    return pdf.getPage(n);
  };

  return {
    numPages: pdf.numPages,

    async renderPage(n, renderOptions = {}) {
      const pdfPage = await page(n);
      try {
        const base = pdfPage.getViewport({ scale: 1 });
        let scale =
          renderOptions.scale ?? (renderOptions.maxWidth ? renderOptions.maxWidth / base.width : 2);
        if (renderOptions.maxHeight) scale = Math.min(scale, renderOptions.maxHeight / base.height);
        const pixels = base.width * base.height * scale * scale;
        const maxPixels = renderOptions.maxPixels ?? 16_000_000;
        if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);

        const viewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        try {
          await pdfPage.render({ canvas, viewport, background: '#ffffff' }).promise;
          return await toBlob(canvas, {
            type: renderOptions.type ?? 'image/png',
            ...(renderOptions.quality === undefined ? {} : { quality: renderOptions.quality }),
          });
        } finally {
          // Give the pixel memory back now rather than at garbage collection.
          canvas.width = 0;
          canvas.height = 0;
        }
      } finally {
        pdfPage.cleanup();
      }
    },

    async pageText(n) {
      const pdfPage = await page(n);
      try {
        const content = await pdfPage.getTextContent();
        let text = '';
        for (const item of content.items) {
          if ('str' in item) {
            text += item.str;
            if (item.hasEOL) text += '\n';
          }
        }
        return text.replace(/[ \t]+\n/g, '\n').trim();
      } finally {
        pdfPage.cleanup();
      }
    },

    async close() {
      await task.destroy();
    },
  };
}
