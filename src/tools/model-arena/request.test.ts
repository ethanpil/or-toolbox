import { describe, expect, it } from 'vitest';
import type { AttachmentRef } from '../../core/attachments/attachments';
import type { ModelInfo } from '../../core/types';
import { type ArenaInput, contenderRequest, DEFAULT_OUTPUT_TOKENS } from './request';

const input = (patch: Partial<ArenaInput> = {}): ArenaInput => ({
  prompt: 'Which is larger, 9.11 or 9.9?',
  system: '',
  temperature: null,
  maxTokens: null,
  pdfEngine: 'cloudflare-ai',
  attachments: [],
  data: () => undefined,
  ...patch,
});

const info = (contextLength: number | null, maxCompletionTokens: number | null): ModelInfo =>
  ({ contextLength, maxCompletionTokens }) as ModelInfo;

const image: AttachmentRef = {
  id: 'img',
  name: 'a.png',
  type: 'image/png',
  size: 9,
  kind: 'image',
};
const pdf: AttachmentRef = {
  id: 'pdf',
  name: 'b.pdf',
  type: 'application/pdf',
  size: 9,
  kind: 'pdf',
  pages: 2,
};
const text: AttachmentRef = {
  id: 'txt',
  name: 'c.md',
  type: 'text/markdown',
  size: 4,
  kind: 'text',
  text: '# Hi',
};
const DATA: Record<string, string> = {
  img: 'data:image/png;base64,AAAA',
  pdf: 'data:application/pdf;base64,JVBERi0=',
};

describe('contender requests', () => {
  it('sends the same prompt to each model, only the model differs', () => {
    const a = contenderRequest('a/one', undefined, input());
    const b = contenderRequest('b/two', undefined, input());
    expect(a.body).toEqual({
      model: 'a/one',
      messages: [{ role: 'user', content: 'Which is larger, 9.11 or 9.9?' }],
    });
    expect({ ...b.body, model: 'a/one' }).toEqual(a.body);
    expect(a.completionTokens).toBe(DEFAULT_OUTPUT_TOKENS);
    expect(a.tooLong).toBe(false);
  });

  it('adds the system prompt and the temperature when set', () => {
    const built = contenderRequest(
      'a/one',
      undefined,
      input({ system: ' Be terse. ', temperature: 0 }),
    );
    expect(built.body).toEqual({
      model: 'a/one',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Which is larger, 9.11 or 9.9?' },
      ],
      temperature: 0,
    });
  });

  it('sends files as parts after the text, PDFs through the parser', () => {
    const built = contenderRequest(
      'a/one',
      undefined,
      input({ attachments: [image, pdf, text], pdfEngine: 'mistral-ocr', data: (id) => DATA[id] }),
    );
    expect(built.body.messages[0]?.content).toEqual([
      { type: 'text', text: 'Which is larger, 9.11 or 9.9?' },
      { type: 'image_url', image_url: { url: DATA['img'] } },
      { type: 'file', file: { filename: 'b.pdf', file_data: DATA['pdf'] } },
      { type: 'text', text: '<file name="c.md">\n# Hi\n</file>' },
    ]);
    expect(built.body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
    expect(built.parses).toEqual([pdf]);
    // 1,500 per image, at least 1,000 for an unread PDF.
    expect(built.promptTokens).toBeGreaterThan(2500);
  });

  it('sends a PDF read in an earlier round as its parser text, without the parser', () => {
    const read = { ...pdf, parsed: '<file name="b.pdf">\nTotal 12\n</file>' };
    const built = contenderRequest(
      'a/one',
      undefined,
      input({ prompt: '', attachments: [read], data: (id) => DATA[id] }),
    );
    expect(built.body.messages[0]?.content).toEqual([
      { type: 'text', text: '<file name="b.pdf">\nTotal 12\n</file>' },
    ]);
    expect(built.body.plugins).toBeUndefined();
    expect(built.parses).toEqual([]);
  });

  it('lets a native PDF reader read the file itself (no parser add-on)', () => {
    const built = contenderRequest(
      'a/one',
      undefined,
      input({ attachments: [pdf], pdfEngine: 'native', data: (id) => DATA[id] }),
    );
    expect(built.body.plugins).toEqual([{ id: 'file-parser', pdf: { engine: 'native' } }]);
    expect(built.parses).toEqual([]);
  });

  it('assumes the model’s output cap and flags a prompt that does not fit its window', () => {
    expect(contenderRequest('a', info(128_000, 1000), input()).completionTokens).toBe(1000);
    const long = input({ prompt: 'x'.repeat(40_000) }); // about 10,000 tokens
    const small = contenderRequest('a', info(8000, null), long);
    expect(small.tooLong).toBe(true);
    expect(small.completionTokens).toBe(1);
    const large = contenderRequest('a', info(64_000, null), long);
    expect(large.tooLong).toBe(false);
    expect(large.promptTokens + large.completionTokens).toBeLessThanOrEqual(64_000);
  });

  it('sends Max tokens when set, clamped to the model’s cap and the room left, and estimates with it', () => {
    const set = contenderRequest('a', info(128_000, 8000), input({ maxTokens: 300 }));
    expect(set.body.max_tokens).toBe(300);
    expect(set.completionTokens).toBe(300);
    const capped = contenderRequest('a', info(128_000, 8000), input({ maxTokens: 50_000 }));
    expect(capped.body.max_tokens).toBe(8000);
    expect(capped.completionTokens).toBe(8000);
    const long = input({ prompt: 'x'.repeat(40_000), maxTokens: 30_000 }); // about 10,000 tokens
    const room = contenderRequest('a', info(32_000, null), long);
    expect(room.tooLong).toBe(false);
    expect(room.promptTokens + room.body.max_tokens!).toBeLessThanOrEqual(32_000);
    // Unset: nothing is sent, and the estimate assumes the default.
    const unset = contenderRequest('a', info(128_000, 8000), input());
    expect(unset.body).not.toHaveProperty('max_tokens');
    expect(unset.completionTokens).toBe(DEFAULT_OUTPUT_TOKENS);
  });

  it('takes a prompt token count worked out once for every contender', () => {
    const shared = input({ prompt: 'x'.repeat(4000) });
    const counted = contenderRequest('a', info(128_000, null), shared);
    expect(contenderRequest('a', info(128_000, null), shared, 12_345).promptTokens).toBe(12_345);
    expect(counted.promptTokens).toBeGreaterThan(1000);
  });
});
