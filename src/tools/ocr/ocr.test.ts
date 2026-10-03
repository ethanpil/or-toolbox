import { describe, expect, it } from 'vitest';
import {
  combineMarkdown,
  combinePlainText,
  estimateTokens,
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
  ...extra,
});

describe('prompts and requests', () => {
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

  it('estimates per page', () => {
    expect(estimateTokens(20)).toEqual({ promptTokens: 36_000, completionTokens: 30_000 });
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

  it('unwraps only a fence around the whole answer', () => {
    expect(unwrapFence('```\nabc\n```')).toBe('abc');
    expect(unwrapFence('text\n```js\ncode\n```')).toBe('text\n```js\ncode\n```');
  });
});
