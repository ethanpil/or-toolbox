// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { RawImageModel } from '../../core/api/types';
import { bareImageControls, imageModelControls } from '../../core/models/image-params';
import type { ImageControlsResult } from '../../core/types';
import { buildInstruction, buildRequest, editSupport } from './request';

/** `imageControls`' answer for a model listed with these `supported_parameters`. */
const ready = (id: string, supported: Record<string, unknown>): ImageControlsResult => {
  const raw: RawImageModel = { id, name: id.toUpperCase(), supported_parameters: supported };
  return { status: 'ready', controls: imageModelControls(raw) };
};

const KLEIN = 'black-forest-labs/flux.2-klein-4b';
const klein = ready(KLEIN, {
  output_format: { type: 'enum', values: ['png', 'jpeg'] },
  n: { type: 'range', min: 1, max: 1 },
  input_references: { type: 'range', min: 0, max: 4 },
});

describe('buildInstruction', () => {
  it('asks to keep the product unchanged and to remove everything else, on pure white, without shadow', () => {
    const text = buildInstruction({ shadow: false });
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
  });

  it('keeps a soft shadow when asked', () => {
    const text = buildInstruction({ shadow: true });
    expect(text).toContain('Keep a soft, natural shadow directly under the product.');
    expect(text).not.toContain('No shadow');
  });
});

describe('editSupport (from imageControls)', () => {
  it('asks for one PNG where the model takes those fields', () => {
    expect(editSupport(KLEIN, klein)).toEqual({ ok: true, params: { n: 1, output_format: 'png' } });
    const plain = ready('google/gemini-3.1-flash-image', {
      input_references: { type: 'range', min: 0, max: 14 },
      aspect_ratio: { type: 'enum', values: ['1:1'] },
    });
    expect(editSupport('google/gemini-3.1-flash-image', plain)).toEqual({ ok: true, params: {} });
    const jpegOnly = ready('a/jpeg', {
      output_format: { type: 'enum', values: ['jpeg'] },
      input_references: { type: 'range', min: 0, max: 1 },
    });
    expect(editSupport('a/jpeg', jpegOnly)).toEqual({ ok: true, params: {} });
  });

  it('refuses models that take no single reference image, or that the image list does not have', () => {
    const none = editSupport('meta/muse-image', ready('meta/muse-image', {}));
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain('META/MUSE-IMAGE cannot edit a photo');
    const zero = ready('a/zero', { input_references: { type: 'range', min: 0, max: 0 } });
    expect(editSupport('a/zero', zero).ok).toBe(false);
    const pair = ready('a/pair', { input_references: { type: 'range', min: 2, max: 4 } });
    expect(editSupport('a/pair', pair).ok).toBe(false);
    const missing = editSupport('openai/gpt-5-image', { status: 'missing' });
    expect(!missing.ok && missing.reason).toContain(
      "does not edit images through OpenRouter's image endpoint",
    );
  });

  it('tries the photo and the instruction alone when the image list could not be read', () => {
    expect(
      editSupport('any/model', { status: 'unknown', controls: bareImageControls('any/model') }),
    ).toEqual({ ok: true, params: {} });
  });
});

describe('buildRequest', () => {
  it('sends the photo as a data-URL reference with the instruction', () => {
    expect(buildRequest(KLEIN, 'Do it', 'data:image/png;base64,AAAA', { n: 1 })).toEqual({
      model: KLEIN,
      prompt: 'Do it',
      n: 1,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
    });
  });
});
