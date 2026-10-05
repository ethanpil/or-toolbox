/**
 * Request-building pieces every chat-style tool needs (Chat, Model arena): a token approximation of text and
 * attachments, the input a model needs for each attachment, and the paid PDF parser as a run add-on.
 *
 * Token counts are approximations, deliberately on the high side (`approxTokens` from src/core/tokens.ts for text,
 * re-exported here with `MESSAGE_OVERHEAD`; fixed allowances per image, PDF and audio file): they decide trimming,
 * the `max_tokens` clamp and the cost estimate, never billing.
 */
import { pdfEngineAddon, type PdfEngineId } from '../models/pdf-engines';
import { approxTokens } from '../tokens';
import type { RunAddon } from '../types';
import { type AttachmentRef, pdfPages } from './attachments';

export { approxTokens, MESSAGE_OVERHEAD } from '../tokens';

/** Rough token cost of one attachment as the model sees it. */
export function attachmentTokens(ref: AttachmentRef): number {
  switch (ref.kind) {
    case 'text':
      return approxTokens(ref.text ?? '') + 10;
    case 'image':
      return 1500;
    case 'pdf':
      // Parsed to text: about a page of text per 50 KB of a text PDF, far less for scans.
      return ref.parsed !== undefined
        ? approxTokens(ref.parsed)
        : Math.max(1000, Math.ceil(ref.size / 50));
    case 'audio':
      // ~32 tokens per second at ~16 KB per second of MP3.
      return Math.max(200, Math.ceil(ref.size / 500));
  }
}

/** An input modality a model must list to read an attachment (a PDF the model reads itself needs `file`). */
export type Modality = 'image' | 'audio' | 'file';

/** A PDF goes to the parser: its bytes are here and it has not been read yet. */
export const needsParser = (
  ref: AttachmentRef,
  data: (id: string) => string | undefined,
): boolean => ref.kind === 'pdf' && ref.parsed === undefined && data(ref.id) !== undefined;

/** The input a model needs for an attachment, or null when it goes as text (or, its bytes gone, not at all). */
export function neededInput(
  ref: AttachmentRef,
  pdfEngine: string,
  data: (id: string) => string | undefined,
): Modality | null {
  if (ref.kind === 'text' || data(ref.id) === undefined) return null;
  if (ref.kind === 'pdf') return ref.parsed === undefined && pdfEngine === 'native' ? 'file' : null;
  return ref.kind;
}

/**
 * The first input the attachments need that `modalities` lacks ('image', 'audio', or 'file' for a PDF the model
 * reads itself), or null. Attachments whose bytes are gone need nothing.
 */
export function missingInput(
  attachments: readonly AttachmentRef[],
  modalities: readonly string[],
  pdfEngine: string,
  has: (id: string) => boolean,
): Modality | null {
  const data = (id: string): string | undefined => (has(id) ? '' : undefined);
  for (const ref of attachments) {
    const needed = neededInput(ref, pdfEngine, data);
    if (needed && !modalities.includes(needed)) return needed;
  }
  return null;
}

/** The paid PDF parser for these PDFs as run add-ons (none for the free engines and `native`). */
export function parserAddons(engine: PdfEngineId, pdfs: readonly AttachmentRef[]): RunAddon[] {
  const pages = pdfs.reduce((sum, ref) => sum + pdfPages(ref), 0);
  const addon = pdfEngineAddon(engine, pages);
  return addon ? [addon] : [];
}
