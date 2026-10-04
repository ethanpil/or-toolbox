import { describe, expect, it } from 'vitest';
import type { AttachmentRef } from './attachments';
import { approxTokens, attachmentTokens, missingInput, needsParser, parserAddons } from './request';

const ref = (kind: 'image' | 'audio' | 'pdf', parsed?: string): AttachmentRef => ({
  id: kind,
  name: `x.${kind}`,
  type: '',
  size: 1,
  kind,
  ...(parsed ? { parsed } : {}),
});

describe('token approximation', () => {
  it('counts tokens conservatively for scripts that are not Latin', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('你好世界')).toBe(4);
    expect(approxTokens('こんにちは')).toBe(5);
    expect(approxTokens('안녕하세요')).toBe(5);
    expect(approxTokens('привет')).toBe(3);
    expect(approxTokens('')).toBe(0);
  });

  it('gives attachments fixed allowances, and a parsed PDF its text', () => {
    expect(attachmentTokens(ref('image'))).toBe(1500);
    expect(attachmentTokens({ ...ref('pdf'), size: 500_000 })).toBe(10_000);
    expect(attachmentTokens(ref('pdf', 'abcdefgh'))).toBe(2);
  });
});

describe('what a model can read', () => {
  const has = (): boolean => true;

  it('names the first attachment the model cannot take', () => {
    expect(missingInput([ref('image')], ['text'], 'cloudflare-ai', has)).toBe('image');
    expect(missingInput([ref('audio')], ['text', 'image'], 'cloudflare-ai', has)).toBe('audio');
    expect(missingInput([ref('pdf')], ['text'], 'native', has)).toBe('file');
    expect(missingInput([ref('pdf')], ['text'], 'cloudflare-ai', has)).toBeNull();
    expect(missingInput([ref('pdf', 'text')], ['text'], 'native', has)).toBeNull();
    expect(missingInput([ref('image')], ['text', 'image'], 'native', has)).toBeNull();
    // Gone after a reload: sent as a note, so nothing is missing.
    expect(missingInput([ref('image')], ['text'], 'native', () => false)).toBeNull();
  });
});

describe('the PDF parser', () => {
  it('needs the bytes of a PDF not read yet', () => {
    expect(needsParser(ref('pdf'), () => 'data:')).toBe(true);
    expect(needsParser(ref('pdf', 'text'), () => 'data:')).toBe(false);
    expect(needsParser(ref('pdf'), () => undefined)).toBe(false);
    expect(needsParser(ref('image'), () => 'data:')).toBe(false);
  });

  it('is an add-on only for a paid engine, priced by the pages', () => {
    const pdfs = [
      { ...ref('pdf'), pages: 3 },
      { ...ref('pdf'), pages: 2 },
    ];
    expect(parserAddons('cloudflare-ai', pdfs)).toEqual([]);
    expect(parserAddons('native', pdfs)).toEqual([]);
    const [addon, ...rest] = parserAddons('mistral-ocr', pdfs);
    expect(rest).toEqual([]);
    expect(addon?.id).toBe('pdf-engine:mistral-ocr');
    expect(addon?.estimateUsd).toBeCloseTo(5 * 0.0022);
    expect(parserAddons('mistral-ocr', [])).toEqual([]);
  });
});
