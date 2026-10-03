import { describe, expect, it } from 'vitest';
import {
  audioFormat,
  classifyFile,
  readAttachment,
  SIZE_LIMITS,
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

  it('refuses what chat cannot use', () => {
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
    expect(toContentPart(image, undefined)).toEqual({
      type: 'text',
      text: '[Attachment "a.webp" (image) is no longer available.]',
    });
    const audio = { id: 'a', name: 'a.wav', type: 'audio/wav', size: 1, kind: 'audio' as const };
    expect(toContentPart(audio, 'data:audio/wav;base64,UklGRg==')).toEqual({
      type: 'input_audio',
      input_audio: { data: 'UklGRg==', format: 'wav' },
    });
  });
});
