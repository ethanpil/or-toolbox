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

/** The text of one page request besides the image and the hint: system prompt, page line, instructions. */
export const PROMPT_TEXT_TOKENS = 300;
/** A PDF text layer sent as a hint, at most `TEXT_HINT_CHARS` (about four characters per token). */
export const TEXT_HINT_TOKENS = Math.ceil(TEXT_HINT_CHARS / 4);
/** One page of a PDF read by the parser: its extracted text, as input tokens. */
export const PARSED_PAGE_TOKENS = 1000;
/** A dense page of small print, out. */
export const PER_PAGE_COMPLETION_TOKENS = 1500;

/**
 * Input tokens of one page image whose longest side is `maxSide` px, for an A4-shaped page (sides 1 : √2): its
 * pixels / 750, the usual rule of thumb for vision models (deliberately on the high side; most downscale).
 */
export function imageTokens(maxSide: number): number {
  return Math.ceil((maxSide * Math.round(maxSide / Math.SQRT2)) / 750);
}

/** Tokens for a plan: pages sent as images (`hintPages` of them with their PDF text), and pages the parser reads. */
export function estimateTokens(plan: {
  imagePages: number;
  hintPages: number;
  parsedPages: number;
  maxSide: number;
}): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens:
      plan.imagePages * (PROMPT_TEXT_TOKENS + imageTokens(plan.maxSide)) +
      plan.hintPages * TEXT_HINT_TOKENS +
      plan.parsedPages * PARSED_PAGE_TOKENS,
    completionTokens: (plan.imagePages + plan.parsedPages) * PER_PAGE_COMPLETION_TOKENS,
  };
}

/**
 * What OpenRouter's file parser bills per page on top of the model's tokens, in USD. Only Mistral OCR charges; its
 * price did not render in the fetched docs (docs/openrouter-api.md, [unverified]), so this is OpenRouter's listed
 * $2 per 1,000 pages, on the high side for an estimate.
 */
export const PARSER_PAGE_FEE_USD: Record<PdfEngine, number> = {
  'cloudflare-ai': 0,
  'mistral-ocr': 0.002,
  native: 0,
};

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
  /** The answer stopped at the length limit (`finish_reason: length`): the end of the page may be missing. */
  truncated: boolean;
}

/** "report.pdf · page 2 of 20", or "report.pdf · all pages". */
export function pageLabel(
  result: Pick<PageResult, 'fileName' | 'pageNumber' | 'pageCount'>,
): string {
  if (result.pageNumber === 0) return `${result.fileName} · all pages`;
  if (result.pageCount <= 1) return result.fileName;
  return `${result.fileName} · page ${result.pageNumber} of ${result.pageCount}`;
}

/**
 * Removes a code fence the model wrapped the whole answer in (```markdown … ```): only when the answer opens with
 * a fence line, closes with the matching fence line, and has no other fence inside. A page with several code
 * blocks (or a fenced block inside the wrapper) is left exactly as it is.
 */
export function unwrapFence(text: string): string {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return text;
  const open = /^(`{3,}|~{3,})[\w+-]*$/.exec(lines[0]!.trim());
  if (!open) return text;
  const fence = open[1]!;
  if (lines[lines.length - 1]!.trim() !== fence) return text;
  const inner = lines.slice(1, -1);
  if (inner.some((line) => /^\s*(`{3,}|~{3,})/.test(line))) return text;
  return inner.join('\n');
}

/** Text safe inside a Markdown line: one line, with the characters Markdown reads as syntax escaped. */
export function inlineMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]#|<>~]/g, '\\$&');
}

/** Pages shown in the combined text: everything read or tried, but not a page still waiting or just started. */
const isShown = (result: PageResult): boolean =>
  result.status !== 'queued' && !(result.status === 'running' && !result.text.trim());

/** What is missing from a page, said after its text; null when it was read in full (or is still being read). */
export function pageNote(result: PageResult): string | null {
  const label = pageLabel(result);
  const partial = result.text.trim() !== '';
  switch (result.status) {
    case 'failed':
      return partial
        ? `${label} is incomplete: ${result.error ?? 'error'}`
        : `${label} could not be read: ${result.error ?? 'error'}`;
    case 'stopped':
      return partial ? `${label} was stopped before its end` : `${label} was not read`;
    case 'done':
      if (result.truncated) return `${label} is cut off: the answer reached the length limit`;
      return partial ? null : `No text on ${label}`;
    default:
      return null;
  }
}

/** Pages not read in full: failed, never read, or cut off. */
export function missingPages(results: readonly PageResult[]): PageResult[] {
  return results.filter(
    (result) => result.status === 'failed' || result.status === 'stopped' || result.truncated,
  );
}

/**
 * The combined Markdown: every page in order, each after a separator line naming it (a single page gets none).
 * A page that failed, was not read or was cut off carries a marker saying so; pages still queued are left out.
 */
export function combineMarkdown(results: readonly PageResult[], separators = true): string {
  const single = results.length <= 1;
  return results
    .filter(isShown)
    .map((result) => {
      const note = pageNote(result);
      const body = [unwrapFence(result.text).trim(), note ? `*[${inlineMarkdown(note)}]*` : '']
        .filter(Boolean)
        .join('\n\n');
      if (single || !separators) return body;
      return `*${inlineMarkdown(pageLabel(result))}*\n\n${body}`;
    })
    .filter((block) => block.length > 0)
    .join(separators && !single ? '\n\n---\n\n' : '\n\n');
}

/**
 * Plain text: the pages with simple separator lines and the same markers as the Markdown; when pages are
 * missing, a first line lists them.
 */
export function combinePlainText(results: readonly PageResult[]): string {
  const single = results.length <= 1;
  const blocks = results.filter(isShown).map((result) => {
    const note = pageNote(result);
    const body = [unwrapFence(result.text).trim(), note ? `[${note}]` : '']
      .filter(Boolean)
      .join('\n\n');
    return single ? body : `--- ${pageLabel(result)} ---\n\n${body}`;
  });
  const missing = missingPages(results);
  if (missing.length > 0 && !single) {
    blocks.unshift(`[Not read in full: ${missing.map((result) => pageLabel(result)).join('; ')}]`);
  }
  return blocks.filter(Boolean).join('\n\n');
}
