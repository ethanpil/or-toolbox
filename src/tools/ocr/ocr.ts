/**
 * OCR's pure half: modes and their prompts, the requests for one page (vision) or one whole PDF (OpenRouter's PDF
 * parser), the combined Markdown, and the token estimate. tool.ts draws the page and runs these.
 */
import type { ChatRequest, ContentPart } from '../../core/api/types';

export type OcrMode = 'printed' | 'handwriting' | 'math' | 'layout';
export type PdfEngine = 'cloudflare-ai' | 'mistral-ocr' | 'native';

export const OCR_MODES: readonly { id: OcrMode; label: string; hint: string }[] = [
  { id: 'printed', label: 'Printed text', hint: 'Books, letters, receipts, screenshots.' },
  { id: 'handwriting', label: 'Handwriting', hint: 'Notes and forms written by hand.' },
  { id: 'math', label: 'Math', hint: 'Formulas as LaTeX inside Markdown.' },
  {
    id: 'layout',
    label: 'Layout-preserving',
    hint: 'Columns, headings and tables kept; tables as Markdown.',
  },
];

export const PDF_ENGINES: readonly { id: PdfEngine; label: string; hint: string }[] = [
  {
    id: 'cloudflare-ai',
    label: 'Cloudflare AI (free)',
    hint: 'Free. Best for PDFs that already contain text.',
  },
  {
    id: 'mistral-ocr',
    label: 'Mistral OCR (paid per page)',
    hint: 'For scans. OpenRouter bills it per page, even with a free model.',
  },
  {
    id: 'native',
    label: "The model's own PDF reading",
    hint: 'Only models with file input; billed as tokens.',
  },
];

export const isOcrMode = (value: unknown): value is OcrMode =>
  OCR_MODES.some((mode) => mode.id === value);
export const isPdfEngine = (value: unknown): value is PdfEngine =>
  PDF_ENGINES.some((engine) => engine.id === value);

/** Older snapshots said `standard` for printed text. */
export function readMode(value: unknown): OcrMode {
  return isOcrMode(value) ? value : 'printed';
}

const MODE_RULES: Record<OcrMode, string> = {
  printed:
    'Transcribe all printed text exactly as written, in reading order. Keep headings, paragraphs and lists as Markdown; write tables as Markdown tables.',
  handwriting:
    'The page is handwritten. Transcribe it exactly as written, keeping the line breaks and the author’s spelling. Write [illegible] for words you cannot read, and [?] after a word you are unsure of.',
  math: 'Transcribe the text and every mathematical expression. Write mathematics in LaTeX: inline as $...$ and displayed equations as $$...$$ on their own lines. Keep equation numbers.',
  layout:
    'Preserve the layout: follow the reading order of columns, keep headings, lists, indentation and blank lines between blocks, and write every table as a Markdown table with a header row. Mark figures as [Figure: short description].',
};

/** The system prompt for a mode and an optional language hint. */
export function systemPrompt(mode: OcrMode, language: string): string {
  const lines = [
    'You are an OCR engine. You receive one page as an image and return its text.',
    MODE_RULES[mode],
    'Do not summarise, translate, correct or explain anything. Output only the transcription, as Markdown, without a code fence. If the page has no text, output nothing.',
  ];
  if (language.trim()) lines.push(`The text is mostly in ${language.trim()}.`);
  return lines.join('\n');
}

/** The longest PDF text layer sent along as a hint, in characters. */
export const TEXT_HINT_CHARS = 6000;

export interface PageRequestInput {
  fileName: string;
  pageNumber: number;
  pageCount: number;
  imageDataUrl: string;
  /** The PDF's own text layer, sent as a hint when present. */
  text?: string;
}

/** The chat request for one page. */
export function pageRequest(
  model: string,
  page: PageRequestInput,
  settings: { mode: OcrMode; language: string; instructions: string; textHint: boolean },
): ChatRequest {
  const parts = [`Page ${page.pageNumber} of ${page.pageCount} of “${page.fileName}”.`];
  if (settings.instructions.trim())
    parts.push(`Extra instructions: ${settings.instructions.trim()}`);
  const hint = settings.textHint ? (page.text ?? '').trim() : '';
  if (hint) {
    parts.push(
      'The PDF also carries this embedded text for the page. It may be incomplete or out of order; use it only to check spelling and numbers against the image:',
      hint.slice(0, TEXT_HINT_CHARS),
    );
  }
  const content: ContentPart[] = [
    { type: 'text', text: parts.join('\n\n') },
    { type: 'image_url', image_url: { url: page.imageDataUrl } },
  ];
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt(settings.mode, settings.language) },
      { role: 'user', content },
    ],
    max_tokens: MAX_PAGE_TOKENS,
    temperature: 0,
  };
}

/** The chat request for a whole PDF through OpenRouter's file parser. */
export function pdfRequest(
  model: string,
  file: { fileName: string; dataUrl: string },
  settings: { mode: OcrMode; language: string; instructions: string; engine: PdfEngine },
): ChatRequest {
  const text = [
    `Transcribe the whole of “${file.fileName}”, page by page. Start every page with a line “Page N” in italics (*Page N*).`,
    settings.instructions.trim() ? `Extra instructions: ${settings.instructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    model,
    messages: [
      {
        role: 'system',
        content: systemPrompt(settings.mode, settings.language).replace(
          'one page as an image',
          'a PDF',
        ),
      },
      {
        role: 'user',
        content: [
          { type: 'text', text },
          { type: 'file', file: { filename: file.fileName, file_data: file.dataUrl } },
        ],
      },
    ],
    plugins: [{ id: 'file-parser', pdf: { engine: settings.engine } }],
    max_tokens: MAX_DOCUMENT_TOKENS,
    temperature: 0,
  };
}

/** Output cap per page: a dense page of small print is about 1,500 tokens; tables and LaTeX more. */
export const MAX_PAGE_TOKENS = 4096;
export const MAX_DOCUMENT_TOKENS = 32_000;

/** Deliberately high per-page figures for the estimate (an image at 1,600 px plus prompt; a dense page out). */
export const PER_PAGE_PROMPT_TOKENS = 1800;
export const PER_PAGE_COMPLETION_TOKENS = 1500;

export function estimateTokens(pages: number): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: pages * PER_PAGE_PROMPT_TOKENS,
    completionTokens: pages * PER_PAGE_COMPLETION_TOKENS,
  };
}

// --- results --------------------------------------------------------------------------------------------

export type PageStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/** One unit of work: a page (vision), or a whole PDF (parser mode, `pageNumber` 0). */
export interface PageResult {
  key: string;
  fileId: string;
  fileName: string;
  /** 1-based; 0 for a whole document read by the PDF parser. */
  pageNumber: number;
  pageCount: number;
  status: PageStatus;
  text: string;
  error: string | null;
}

/** "report.pdf · page 2 of 20", or "report.pdf · all pages". */
export function pageLabel(
  result: Pick<PageResult, 'fileName' | 'pageNumber' | 'pageCount'>,
): string {
  if (result.pageNumber === 0) return `${result.fileName} · all pages`;
  if (result.pageCount <= 1) return result.fileName;
  return `${result.fileName} · page ${result.pageNumber} of ${result.pageCount}`;
}

/** Removes a code fence the model wrapped the whole answer in (```markdown … ```). */
export function unwrapFence(text: string): string {
  const match = /^\s*```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? (match[1] ?? '') : text;
}

/**
 * The combined Markdown: every page that has text (or failed), in order, each after a separator line naming it.
 * A single page gets no separator. Pages still queued are left out.
 */
export function combineMarkdown(results: readonly PageResult[], separators = true): string {
  const shown = results.filter((result) => result.status !== 'queued' || result.text);
  const single = results.length <= 1;
  return shown
    .map((result) => {
      const body =
        result.status === 'failed' && !result.text.trim()
          ? `*[${pageLabel(result)} could not be read: ${result.error ?? 'error'}]*`
          : unwrapFence(result.text).trim();
      if (single || !separators) return body;
      return `*${pageLabel(result)}*\n\n${body}`;
    })
    .filter((block) => block.length > 0)
    .join(separators && !single ? '\n\n---\n\n' : '\n\n');
}

/** Plain text: the combined text with page separators as simple lines. */
export function combinePlainText(results: readonly PageResult[]): string {
  return results
    .filter((result) => result.text.trim())
    .map((result) =>
      results.length <= 1
        ? unwrapFence(result.text).trim()
        : `--- ${pageLabel(result)} ---\n\n${unwrapFence(result.text).trim()}`,
    )
    .join('\n\n');
}
