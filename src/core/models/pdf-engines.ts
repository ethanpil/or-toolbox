/**
 * OpenRouter's PDF parsers: the `file-parser` plugin's `pdf.engine` (docs/openrouter-api.md §2.5). One table for
 * every tool that sends PDFs (OCR, Chat, Data and Table extractors), so labels, hints and prices agree.
 *
 * ```ts
 * plugins: [{ id: 'file-parser', pdf: { engine } }]
 * const addon = pdfEngineAddon(engine, pages);           // null unless the engine charges by itself
 * await ctx.beginRun({ addons: addon ? [addon] : [] }, signal);
 * ```
 */
import type { RunAddon } from '../types';

export type PdfEngineId = 'cloudflare-ai' | 'mistral-ocr' | 'native';

export interface PdfEngine {
  id: PdfEngineId;
  /** Short name, e.g. "Mistral OCR". */
  name: string;
  /** For a select option. */
  label: string;
  /** One line under the select. */
  hint: string;
  /** Adds no charge of its own (`native` is billed as the model's input tokens, which the model estimate covers). */
  free: boolean;
  /** USD per page charged on top of the model; null when the engine charges nothing extra. */
  pageUsd: number | null;
}

/**
 * Mistral OCR: $2 per 1,000 pages (OpenRouter's "Universal PDF Support" announcement; the docs page renders the
 * price as a template variable). The US regional rate is 10% more, so estimates use $2.20 per 1,000 pages.
 * Re-check when OpenRouter publishes the number again.
 */
export const MISTRAL_OCR_PAGE_USD = 0.0022;

export const PDF_ENGINES: readonly PdfEngine[] = [
  {
    id: 'cloudflare-ai',
    name: 'Cloudflare AI',
    label: 'Cloudflare AI (free)',
    hint: 'Free. Best for PDFs that already contain text.',
    free: true,
    pageUsd: null,
  },
  {
    id: 'mistral-ocr',
    name: 'Mistral OCR',
    label: 'Mistral OCR (paid per page)',
    hint: 'For scans. OpenRouter bills it per page, even with a free model.',
    free: false,
    pageUsd: MISTRAL_OCR_PAGE_USD,
  },
  {
    id: 'native',
    name: "The model's own PDF reading",
    label: "The model's own PDF reading",
    hint: 'Only models with file input; billed as tokens.',
    free: true,
    pageUsd: null,
  },
];

export const isPdfEngineId = (value: unknown): value is PdfEngineId =>
  PDF_ENGINES.some((engine) => engine.id === value);

export function pdfEngine(id: PdfEngineId): PdfEngine {
  return PDF_ENGINES.find((engine) => engine.id === id) ?? PDF_ENGINES[0]!;
}

/**
 * The add-on a run that sends `pages` PDF pages through `engine` incurs (`RunSpec.addons`), or null when the
 * engine adds no charge of its own or there are no pages.
 */
export function pdfEngineAddon(engine: PdfEngineId, pages: number): RunAddon | null {
  const info = pdfEngine(engine);
  if (info.free || pages <= 0) return null;
  return {
    id: `pdf-engine:${info.id}`,
    label: `${info.name} (PDF parser)`,
    estimateUsd: info.pageUsd === null ? null : pages * info.pageUsd,
  };
}
