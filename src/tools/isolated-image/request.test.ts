// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RawImageModel } from '../../core/api/types';
import { buildInstruction, buildRequest, editSupport } from './request';

const model = (id: string, supported: Record<string, unknown>): RawImageModel => ({
  id,
  name: id.toUpperCase(),
  supported_parameters: supported,
});

const KLEIN = model('black-forest-labs/flux.2-klein-4b', {
  output_format: { type: 'enum', values: ['png', 'jpeg'] },
  n: { type: 'range', min: 1, max: 1 },
  input_references: { type: 'range', min: 0, max: 4 },
});

describe('buildInstruction', () => {
  it('asks to keep the product unchanged and to remove everything else, on pure white, without shadow', () => {
    const text = buildInstruction({ shadow: false, notes: '' });
    for (const part of [
      'Keep the product exactly as it is',
      'shape',
      'colours',
      'logos',
      'text',
      'Remove everything else',
      'pure white background (#FFFFFF)',
      'sharp and evenly lit',
      'No shadow',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('soft, natural shadow');
    expect(text).not.toContain('About these photos');
  });

  it('keeps a soft shadow when asked, and appends the notes', () => {
    const text = buildInstruction({ shadow: true, notes: '  The product is the left shoe. ' });
    expect(text).toContain('Keep a soft, natural shadow directly under the product.');
    expect(text).not.toContain('No shadow');
    expect(text.endsWith('\n\nAbout these photos: The product is the left shoe.')).toBe(true);
  });
});

describe('editSupport', () => {
  it('asks for one PNG where the model takes those parameters', () => {
    expect(editSupport(KLEIN.id, [KLEIN])).toEqual({
      ok: true,
      params: { n: 1, output_format: 'png' },
    });
    const plain = model('google/gemini-3.1-flash-image', {
      input_references: { type: 'range', min: 0, max: 14 },
      aspect_ratio: { type: 'enum', values: ['1:1'] },
    });
    expect(editSupport(plain.id, [plain])).toEqual({ ok: true, params: {} });
    const jpegOnly = model('a/jpeg', {
      output_format: { type: 'enum', values: ['jpeg'] },
      input_references: { type: 'range', min: 0, max: 1 },
    });
    expect(editSupport(jpegOnly.id, [jpegOnly])).toEqual({ ok: true, params: {} });
  });

  it('refuses models that take no single reference image, or are not on the image endpoint', () => {
    const none = model('meta/muse-image', {});
    const result = editSupport(none.id, [none, KLEIN]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('META/MUSE-IMAGE cannot edit a photo');
    const zero = model('a/zero', { input_references: { type: 'range', min: 0, max: 0 } });
    expect(editSupport(zero.id, [zero]).ok).toBe(false);
    const pair = model('a/pair', { input_references: { type: 'range', min: 2, max: 4 } });
    expect(editSupport(pair.id, [pair]).ok).toBe(false);
    const missing = editSupport('openai/gpt-5-image', [KLEIN]);
    expect(!missing.ok && missing.reason).toContain(
      "does not edit images through OpenRouter's image",
    );
  });

  it('tries the request as it is when the model list could not be read', () => {
    expect(editSupport('any/model', undefined)).toEqual({ ok: true, params: {} });
    expect(editSupport('any/model', [])).toEqual({ ok: true, params: {} });
  });
});

describe('buildRequest', () => {
  it('sends the photo as a data-URL reference with the instruction', () => {
    expect(buildRequest(KLEIN.id, 'Do it', 'data:image/png;base64,AAAA', { n: 1 })).toEqual({
      model: KLEIN.id,
      prompt: 'Do it',
      n: 1,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    });
  });
});
