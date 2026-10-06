import { describe, expect, it } from 'vitest';
import {
  combineMarkdown,
  combinePlainText,
  estimateTokens,
  imageTokens,
  inlineMarkdown,
  pageRequest,
  type PageResult,
  pdfRequest,
  readMode,
  systemPrompt,
  TEXT_HINT_CHARS,
  unwrapFence,
} from './ocr';

const result = (pageNumber: number, text: string, extra: Partial<PageResult> = {}): PageResult => ({
  key: `f:${pageNumber}`,
  fileId: 'f',
  fileName: 'report.pdf',
  pageNumber,
  pageCount: 3,
  status: 'done',
  text,
  error: null,
  truncated: false,
  ...extra,
});

describe('prompts and requests', () => {
  it('never asks for more output than the model can give', () => {
    const settings = { mode: 'printed' as const, language: '', instructions: '', textHint: false };
    const page = { fileName: 'a.png', pageNumber: 1, pageCount: 1, imageDataUrl: 'data:x' };
    expect(pageRequest('m', page, settings).max_tokens).toBe(4096);
    expect(pageRequest('m', page, { ...settings, maxCompletionTokens: 2000 }).max_tokens).toBe(
      2000,
    );
    expect(pageRequest('m', page, { ...settings, maxCompletionTokens: 64_000 }).max_tokens).toBe(
      4096,
    );
    const file = { fileName: 'a.pdf', dataUrl: 'data:y' };
    const parser = {
      mode: 'printed' as const,
      language: '',
      instructions: '',
      engine: 'cloudflare-ai' as const,
    };
    expect(pdfRequest('m', file, parser).max_tokens).toBe(32_000);
    expect(pdfRequest('m', file, { ...parser, maxCompletionTokens: 8000 }).max_tokens).toBe(8000);
    expect(pdfRequest('m', file, { ...parser, maxCompletionTokens: null }).max_tokens).toBe(32_000);
  });

  it('has a rule per mode and adds the language hint', () => {
    expect(systemPrompt('math', '')).toMatch(/LaTeX/);
    expect(systemPrompt('handwriting', '')).toMatch(/\[illegible\]/);
    expect(systemPrompt('layout', '')).toMatch(/Markdown table/);
    expect(systemPrompt('printed', ' German ')).toMatch(/mostly in German\.$/);
    expect(systemPrompt('printed', '')).not.toMatch(/mostly in/);
  });

  it('reads older snapshots: unknown modes fall back to printed text', () => {
    expect(readMode('standard')).toBe('printed');
    expect(readMode('math')).toBe('math');
  });

  it('builds one vision request per page, with the text layer as a capped hint', () => {
    const body = pageRequest(
      'm/vision',
      {
        fileName: 'report.pdf',
        pageNumber: 2,
        pageCount: 20,
        imageDataUrl: 'data:image/jpeg;base64,AA',
        text: 'x'.repeat(9000),
      },
      { mode: 'printed', language: '', instructions: ' Skip headers ', textHint: true },
    );
    expect(body).toMatchObject({ model: 'm/vision', temperature: 0, max_tokens: 4096 });
    const user = body.messages[1]!;
    expect(Array.isArray(user.content)).toBe(true);
    const [text, image] = user.content as [
      { type: 'text'; text: string },
      { type: 'image_url'; image_url: { url: string } },
    ];
    expect(text.text).toContain('Page 2 of 20 of “report.pdf”.');
    expect(text.text).toContain('Extra instructions: Skip headers');
    expect(text.text).toContain('x'.repeat(TEXT_HINT_CHARS));
    expect(text.text).not.toContain('x'.repeat(TEXT_HINT_CHARS + 1));
    expect(image.image_url.url).toBe('data:image/jpeg;base64,AA');

    const noHint = pageRequest(
      'm',
      { fileName: 'a.png', pageNumber: 1, pageCount: 1, imageDataUrl: 'data:,', text: 'layer' },
      { mode: 'printed', language: '', instructions: '', textHint: false },
    );
    expect(JSON.stringify(noHint)).not.toContain('layer');
  });

  it('sends a whole PDF through the chosen parser engine', () => {
    const body = pdfRequest(
      'm/text',
      { fileName: 'report.pdf', dataUrl: 'data:application/pdf;base64,JVBER' },
      { mode: 'layout', language: '', instructions: '', engine: 'cloudflare-ai' },
    );
    expect(body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    expect(body.messages[1]?.content).toContainEqual({
      type: 'file',
      file: { filename: 'report.pdf', file_data: 'data:application/pdf;base64,JVBER' },
    });
    expect(body.messages[0]?.content).toMatch(/You receive a PDF/);
  });

  it('estimates from the image size, the text hint and parsed pages', () => {
    // An A4-shaped page at 1,600 px: 1,600 × 1,131 pixels / 750.
    expect(imageTokens(1600)).toBe(2413);
    expect(imageTokens(1024)).toBeLessThan(imageTokens(1600));
    expect(imageTokens(2048)).toBeGreaterThan(imageTokens(1600));
    const small = estimateTokens({ imagePages: 20, hintPages: 0, parsedPages: 0, maxSide: 1024 });
    const large = estimateTokens({ imagePages: 20, hintPages: 0, parsedPages: 0, maxSide: 2048 });
    expect(large.promptTokens).toBeGreaterThan(small.promptTokens);
    expect(large.completionTokens).toBe(small.completionTokens);
    const hinted = estimateTokens({ imagePages: 20, hintPages: 20, parsedPages: 0, maxSide: 1024 });
    expect(hinted.promptTokens - small.promptTokens).toBe(20 * Math.ceil(TEXT_HINT_CHARS / 4));
    const parsed = estimateTokens({ imagePages: 0, hintPages: 0, parsedPages: 10, maxSide: 1600 });
    expect(parsed.promptTokens).toBeGreaterThan(0);
    expect(parsed.completionTokens).toBe(small.completionTokens / 2);
  });
});

describe('combined output', () => {
  it('joins pages in order with separators naming each page', () => {
    const text = combineMarkdown([
      result(1, 'One'),
      result(2, '```markdown\nTwo\n```'),
      result(3, 'Three'),
    ]);
    expect(text).toBe(
      '*report.pdf · page 1 of 3*\n\nOne\n\n---\n\n*report.pdf · page 2 of 3*\n\nTwo\n\n---\n\n*report.pdf · page 3 of 3*\n\nThree',
    );
    expect(combineMarkdown([result(1, 'One'), result(2, 'Two')], false)).toBe('One\n\nTwo');
  });

  it('leaves out queued pages and marks failed ones', () => {
    const text = combineMarkdown([
      result(1, 'One'),
      result(2, '', { status: 'failed', error: 'Mocked error 400' }),
      result(3, '', { status: 'queued' }),
    ]);
    expect(text).toContain('*[report.pdf · page 2 of 3 could not be read: Mocked error 400]*');
    expect(text).not.toContain('page 3');
  });

  it('never leaves an empty block for a page that was not read, and marks what is missing', () => {
    const pages = [
      result(1, 'One'),
      result(2, '', { status: 'stopped' }),
      result(3, 'Half of three', { status: 'failed', error: 'Connection lost' }),
    ];
    expect(combineMarkdown(pages)).toBe(
      [
        '*report.pdf · page 1 of 3*\n\nOne',
        '*report.pdf · page 2 of 3*\n\n*[report.pdf · page 2 of 3 was not read]*',
        '*report.pdf · page 3 of 3*\n\nHalf of three\n\n*[report.pdf · page 3 of 3 is incomplete: Connection lost]*',
      ].join('\n\n---\n\n'),
    );
    // Without separators the marker still says which page it is.
    expect(combineMarkdown(pages, false)).toBe(
      'One\n\n*[report.pdf · page 2 of 3 was not read]*\n\nHalf of three\n\n*[report.pdf · page 3 of 3 is incomplete: Connection lost]*',
    );
    // A page still being read with no text yet is not shown at all.
    expect(combineMarkdown([result(1, 'One'), result(2, '', { status: 'running' })])).toBe(
      '*report.pdf · page 1 of 3*\n\nOne',
    );
  });

  it('marks a page cut off at the length limit, and a blank page', () => {
    const text = combineMarkdown([result(1, 'Long page', { truncated: true }), result(2, '   ')]);
    expect(text).toContain(
      'Long page\n\n*[report.pdf · page 1 of 3 is cut off: the answer reached the length limit]*',
    );
    expect(text).toContain('*[No text on report.pdf · page 2 of 3]*');
  });

  it('escapes Markdown in page labels and notes', () => {
    expect(inlineMarkdown('a*b_c #1 | [x]\nnext')).toBe('a\\*b\\_c \\#1 \\| \\[x\\] next');
    const text = combineMarkdown([
      result(1, 'One', { fileName: '*draft*.pdf' }),
      result(2, '', { fileName: '*draft*.pdf', status: 'failed', error: 'Bad | answer' }),
    ]);
    expect(text).toContain('*\\*draft\\*.pdf · page 1 of 3*');
    expect(text).toContain('could not be read: Bad \\| answer]*');
  });

  it('gives a single page no separator, and a whole-PDF read its own label', () => {
    expect(combineMarkdown([result(1, 'Only', { pageCount: 1, fileName: 'a.png' })])).toBe('Only');
    expect(
      combineMarkdown([
        result(0, 'All of it'),
        result(1, 'Image', { fileName: 'b.png', pageCount: 1, key: 'b' }),
      ]),
    ).toBe('*report.pdf · all pages*\n\nAll of it\n\n---\n\n*b.png*\n\nImage');
  });

  it('writes plain text with simple separator lines', () => {
    expect(combinePlainText([result(1, 'One'), result(2, 'Two')])).toBe(
      '--- report.pdf · page 1 of 3 ---\n\nOne\n\n--- report.pdf · page 2 of 3 ---\n\nTwo',
    );
  });

  it('says in plain text which pages are missing, at the top and in place', () => {
    const text = combinePlainText([
      result(1, 'One'),
      result(2, '', { status: 'failed', error: 'Mocked error 400' }),
      result(3, 'Three', { truncated: true }),
    ]);
    expect(text.split('\n\n')[0]).toBe(
      '[Not read in full: report.pdf · page 2 of 3; report.pdf · page 3 of 3]',
    );
    expect(text).toContain(
      '--- report.pdf · page 2 of 3 ---\n\n[report.pdf · page 2 of 3 could not be read: Mocked error 400]',
    );
    expect(text).toContain(
      'Three\n\n[report.pdf · page 3 of 3 is cut off: the answer reached the length limit]',
    );
    expect(combinePlainText([result(1, 'One'), result(2, 'Two')])).not.toContain('Not read');
  });

  it('leaves out the separator lines of plain text when Page separators is off', () => {
    const pages = [result(1, 'One'), result(2, 'Two')];
    expect(combinePlainText(pages, false)).toBe('One\n\nTwo');
    // The missing-pages line stays: it is a warning, not a separator.
    const missing = combinePlainText(
      [result(1, 'One'), result(2, '', { status: 'failed' })],
      false,
    );
    expect(missing.split('\n\n')[0]).toBe('[Not read in full: report.pdf · page 2 of 3]');
    expect(missing).not.toContain('---');
  });

  it('unwraps only a fence around the whole answer', () => {
    expect(unwrapFence('```\nabc\n```')).toBe('abc');
    expect(unwrapFence('  ```markdown\n# Title\n\nText\n```  ')).toBe('# Title\n\nText');
    expect(unwrapFence('text\n```js\ncode\n```')).toBe('text\n```js\ncode\n```');
    // Several blocks on one page: the outer fences are not one wrapper.
    const blocks = '```\nfirst block\n```\n\nSome text\n\n```python\nprint(1)\n```';
    expect(unwrapFence(blocks)).toBe(blocks);
    const nested = '```markdown\nIntro\n```js\ncode\n```\n```';
    expect(unwrapFence(nested)).toBe(nested);
    // The closing fence must match the opening one.
    expect(unwrapFence('````\nabc\n```')).toBe('````\nabc\n```');
    expect(unwrapFence('````md\nabc\n````')).toBe('abc');
  });
});
