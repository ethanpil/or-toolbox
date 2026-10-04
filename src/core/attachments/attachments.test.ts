import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AttachmentRef,
  audioFormat,
  checkText,
  classifyFile,
  keepParsed,
  PARSED_LIMIT,
  parsedFiles,
  pdfPages,
  readAttachment,
  SIZE_LIMITS,
  TEXT_TOTAL_LIMIT,
  textAttachment,
  toContentPart,
} from './attachments';

describe('classifyFile', () => {
  it.each([
    [{ name: 'a.png', type: 'image/png' }, 'image'],
    [{ name: 'photo.JPG', type: '' }, 'image'],
    [{ name: 'doc.pdf', type: '' }, 'pdf'],
    [{ name: 'talk.m4a', type: 'audio/x-m4a' }, 'audio'],
    [{ name: 'voice', type: 'audio/ogg' }, 'audio'],
    [{ name: 'notes.md', type: '' }, 'text'],
    [{ name: 'main.py', type: 'text/x-python' }, 'text'],
    [{ name: 'index.ts', type: 'video/mp2t' }, 'text'], // the extension wins over a wrong browser type
    [{ name: 'data.json', type: 'application/json' }, 'text'],
    [{ name: 'Makefile', type: '' }, 'text'],
    [{ name: 'readme', type: 'text/plain' }, 'text'],
  ])('%o is %s', (file, kind) => {
    expect(classifyFile(file)).toBe(kind);
  });

  it('refuses what a chat request cannot carry', () => {
    expect(classifyFile({ name: 'movie.mp4', type: 'video/mp4' })).toBeNull();
    expect(classifyFile({ name: 'archive.zip', type: 'application/zip' })).toBeNull();
    expect(classifyFile({ name: 'pic.heic', type: 'image/heic' })).toBeNull();
  });
});

describe('audioFormat', () => {
  it('comes from the type, then the extension, else mp3', () => {
    expect(audioFormat({ name: 'a.bin', type: 'audio/wav' })).toBe('wav');
    expect(audioFormat({ name: 'a.flac', type: '' })).toBe('flac');
    expect(audioFormat({ name: 'a', type: 'audio/unknown' })).toBe('mp3');
  });
});

describe('readAttachment', () => {
  it('reads images as data URLs and keeps only the metadata in the reference', async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', {
      type: 'image/png',
    });
    const { ref, data } = await readAttachment(file);
    expect(ref).toMatchObject({ name: 'a.png', type: 'image/png', size: 4, kind: 'image' });
    expect(ref).not.toHaveProperty('text');
    expect(data).toBe('data:image/png;base64,iVBORw==');
  });

  it('types an untyped PDF and inlines text files', async () => {
    const pdf = await readAttachment(new File(['%PDF-1.4'], 'scan.pdf'));
    expect(pdf.ref.type).toBe('application/pdf');
    expect(pdf.data?.startsWith('data:application/pdf;base64,')).toBe(true);

    const text = await readAttachment(new File(['print(1)'], 'main.py'));
    expect(text.ref).toMatchObject({ kind: 'text', type: 'text/plain', text: 'print(1)' });
    expect(text.data).toBeUndefined();
  });

  it('counts the pages of a PDF for the parser’s price, else guesses high from its size', async () => {
    const invoice = readFileSync(join(process.cwd(), 'tests/fixtures/media/invoice.pdf'));
    const read = await readAttachment(
      new File([invoice], 'invoice.pdf', { type: 'application/pdf' }),
    );
    expect(read.ref.pages).toBe(1);
    expect(pdfPages(read.ref)).toBe(1);

    const three =
      '%PDF-1.4\n1 0 obj<</Type /Pages /Count 3>>\n' + '2 0 obj<</Type/Page>>\n'.repeat(3);
    expect((await readAttachment(new File([three], 'a.pdf'))).ref.pages).toBe(3);
    // Page objects in compressed streams cannot be counted: about a page per 30 KB, rounded up.
    const packed = await readAttachment(new File(['%PDF-1.5 ' + 'x'.repeat(70_000)], 'b.pdf'));
    expect(packed.ref.pages).toBeUndefined();
    expect(pdfPages(packed.ref)).toBe(3);
  });

  it('refuses files over the limit, unknown kinds and binary files posing as text', async () => {
    const big = new File([new Uint8Array(SIZE_LIMITS.text + 1)], 'huge.txt', {
      type: 'text/plain',
    });
    await expect(readAttachment(big)).rejects.toThrow(
      /huge\.txt is 1 MB\. Text files can be at most 1 MB/,
    );
    await expect(
      readAttachment(new File(['x'], 'clip.mp4', { type: 'video/mp4' })),
    ).rejects.toThrow(/can't be attached/);
    await expect(readAttachment(new File(['a\u0000b'], 'x.txt'))).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});

describe('content parts', () => {
  it('maps each kind to its part', () => {
    const text = textAttachment('ocr.md', '# Invoice', 'text/markdown');
    expect(text).toMatchObject({ name: 'ocr.md', kind: 'text', size: 9 });
    expect(toContentPart(text, undefined)).toEqual({
      type: 'text',
      text: '<file name="ocr.md">\n# Invoice\n</file>',
    });
    const image = { id: 'i', name: 'a.webp', type: 'image/webp', size: 1, kind: 'image' as const };
    expect(toContentPart(image, 'data:image/webp;base64,UklG')).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/webp;base64,UklG' },
    });
    // Without its bytes an image has no part; the caller decides what to send instead.
    expect(toContentPart(image, undefined)).toBeNull();
    const pdf = { id: 'p', name: 'b.pdf', type: 'application/pdf', size: 1, kind: 'pdf' as const };
    expect(toContentPart({ ...pdf, parsed: 'Page 1' }, undefined)).toEqual({
      type: 'text',
      text: 'Page 1',
    });
    const audio = { id: 'a', name: 'a.wav', type: 'audio/wav', size: 1, kind: 'audio' as const };
    expect(toContentPart(audio, 'data:audio/wav;base64,UklGRg==')).toEqual({
      type: 'input_audio',
      input_audio: { data: 'UklGRg==', format: 'wav' },
    });
  });
});

describe('parser text from annotations', () => {
  it('reads each file annotation of a reply as one text, in order', () => {
    const recorded = JSON.parse(
      readFileSync(
        join(process.cwd(), 'tests/fixtures/openrouter/chat-completion-pdf.recorded.json'),
        'utf8',
      ),
    ) as { response: { choices: { message: { annotations: unknown } }[] } };
    const annotations = recorded.response.choices[0]!.message.annotations;
    const [file, ...rest] = parsedFiles(annotations);
    expect(rest).toEqual([]);
    expect(file?.name).toBe('invoice.pdf');
    expect(file?.text.startsWith('<file name="invoice.pdf">\n# document.pdf')).toBe(true);
    expect(file?.text.endsWith('Invoice 4711 total 128.50 EUR\n</file>')).toBe(true);
  });

  it('ignores what it does not know, and texts over the limit', () => {
    expect(parsedFiles(undefined)).toEqual([]);
    expect(parsedFiles([{ type: 'url_citation' }, { type: 'file', file: {} }, 'x'])).toEqual([]);
    const huge = [
      {
        type: 'file',
        file: { name: 'a.pdf', content: [{ type: 'text', text: 'x'.repeat(PARSED_LIMIT + 1) }] },
      },
    ];
    expect(parsedFiles(huge)).toEqual([]);
    const withImage = [
      {
        type: 'file',
        file: {
          name: 'b.pdf',
          content: [
            { type: 'text', text: 'Page 1' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
          ],
        },
      },
    ];
    expect(parsedFiles(withImage)).toEqual([{ name: 'b.pdf', text: 'Page 1' }]);
  });

  it('keeps each PDF’s parser text on its reference, matched by name in order', () => {
    const pdf = (id: string, name: string): AttachmentRef => ({
      id,
      name,
      type: 'application/pdf',
      size: 1,
      kind: 'pdf',
    });
    const refs = [pdf('1', 'a.pdf'), pdf('2', 'a.pdf'), pdf('3', 'c.pdf')];
    const file = (name: string, text: string) => ({
      type: 'file',
      file: { name, content: [{ type: 'text', text }] },
    });
    keepParsed(refs, [file('a.pdf', 'first'), file('a.pdf', 'second')]);
    expect(refs.map((ref) => ref.parsed)).toEqual(['first', 'second', undefined]);
  });
});

describe('text limits per message', () => {
  const text = (size: number) => textAttachment('a.txt', 'x'.repeat(size));

  it('refuses text that would take the message over the total', () => {
    expect(() => checkText([text(TEXT_TOTAL_LIMIT - 10)], 'b.txt', 10)).not.toThrow();
    expect(() => checkText([text(TEXT_TOTAL_LIMIT - 10)], 'b.txt', 11)).toThrow(
      /b\.txt.*at most 2 MB of text/,
    );
    expect(() => checkText([], 'big.txt', SIZE_LIMITS.text + 1)).toThrow(/big\.txt is/);
  });
});
