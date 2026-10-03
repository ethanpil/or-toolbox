import { describe, expect, it } from 'vitest';
import {
  MISTRAL_OCR_PAGE_USD,
  PDF_ENGINES,
  isPdfEngineId,
  pdfEngine,
  pdfEngineAddon,
} from './pdf-engines';

describe('PDF engines', () => {
  it('lists each engine once, with the free one first', () => {
    expect(PDF_ENGINES.map((engine) => engine.id)).toEqual([
      'cloudflare-ai',
      'mistral-ocr',
      'native',
    ]);
    expect(PDF_ENGINES.filter((engine) => !engine.free).map((engine) => engine.id)).toEqual([
      'mistral-ocr',
    ]);
    expect(isPdfEngineId('native')).toBe(true);
    expect(isPdfEngineId('pdf-text')).toBe(false);
    expect(pdfEngine('mistral-ocr').pageUsd).toBe(MISTRAL_OCR_PAGE_USD);
  });

  it('makes a per-page add-on only for an engine that charges by itself', () => {
    expect(pdfEngineAddon('cloudflare-ai', 40)).toBeNull();
    expect(pdfEngineAddon('native', 40)).toBeNull(); // billed as the model's input tokens
    const addon = pdfEngineAddon('mistral-ocr', 12)!;
    expect(addon.id).toBe('pdf-engine:mistral-ocr');
    expect(addon.label).toBe('Mistral OCR (PDF parser)');
    expect(addon.estimateUsd).toBeCloseTo(12 * MISTRAL_OCR_PAGE_USD);
    expect(pdfEngineAddon('mistral-ocr', 0)).toBeNull();
  });
});
