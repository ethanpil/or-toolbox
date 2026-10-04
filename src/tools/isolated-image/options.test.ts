// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  appliedMargin,
  FALLBACK_SETTINGS,
  type IsolateSettings,
  MIN_JPG_MARGIN_PX,
  outputName,
  processingKey,
  readSettings,
} from './options';
import manifest from './manifest.json';

describe('appliedMargin', () => {
  it('keeps at least 24 px of white for JPG, so compression cannot tint the border', () => {
    expect(MIN_JPG_MARGIN_PX).toBe(24);
    expect(appliedMargin(0.005, { format: 'jpg', size: 2000 })).toBe(0.012);
    expect(appliedMargin(0.01, { format: 'jpg', size: 500 })).toBe(0.048);
    expect(appliedMargin(0.08, { format: 'jpg', size: 2000 })).toBe(0.08);
    // PNG is lossless: the margin is the one asked for, even 0.
    expect(appliedMargin(0.005, { format: 'png', size: 2000 })).toBe(0.005);
    expect(appliedMargin(0, { format: 'png', size: 2000 })).toBe(0);
  });
});

describe('readSettings', () => {
  it('starts from the manifest defaults, which match the fallback', () => {
    expect(readSettings(manifest.defaults)).toEqual(FALLBACK_SETTINGS);
  });

  it('takes every valid field and keeps the base for missing, invalid and unknown ones', () => {
    const next = readSettings(
      {
        size: 1500,
        margin: 0.12,
        whiteThreshold: 250,
        sharpen: false,
        sharpenAmount: 1.2,
        shadow: true,
        format: 'png',
        jpegQuality: 80,
        filenamePattern: '{n:3}-{name}',
        sendSize: 2048,
        concurrency: 3,
        extra: 'ignored',
      },
      FALLBACK_SETTINGS,
    );
    expect(next).toEqual({
      size: 1500,
      margin: 0.12,
      whiteThreshold: 250,
      sharpen: false,
      sharpenAmount: 1.2,
      shadow: true,
      format: 'png',
      jpegQuality: 80,
      filenamePattern: '{n:3}-{name}',
      sendSize: 2048,
      concurrency: 3,
    } satisfies IsolateSettings);

    const kept = readSettings(
      {
        size: 1234,
        margin: 0.6,
        whiteThreshold: 245.5,
        sharpen: 'yes',
        format: 'gif',
        jpegQuality: 101,
        filenamePattern: '   ',
        concurrency: 0,
        __proto__: { size: 500 },
      },
      next,
    );
    expect(kept).toEqual(next);
  });
});

describe('processingKey', () => {
  const photo = { margin: null, threshold: null };

  it('changes with what the post-processing depends on, and only that', () => {
    const base = processingKey(FALLBACK_SETTINGS, photo);
    expect(processingKey({ ...FALLBACK_SETTINGS, shadow: true }, photo)).toBe(base);
    expect(processingKey({ ...FALLBACK_SETTINGS, filenamePattern: 'x' }, photo)).toBe(base);
    expect(processingKey({ ...FALLBACK_SETTINGS, sendSize: 2048 }, photo)).toBe(base);
    for (const patch of [
      { size: 1000 },
      { margin: 0.1 },
      { whiteThreshold: 240 },
      { sharpen: false },
      { sharpenAmount: 1 },
      { format: 'png' as const },
      { jpegQuality: 80 },
    ]) {
      expect(processingKey({ ...FALLBACK_SETTINGS, ...patch }, photo)).not.toBe(base);
    }
    // The photo's own margin and threshold win; a fixed threshold differs from the same automatic one.
    expect(processingKey(FALLBACK_SETTINGS, { margin: 0.1, threshold: null })).not.toBe(base);
    expect(processingKey(FALLBACK_SETTINGS, { margin: null, threshold: 245 })).not.toBe(base);
    // The JPG quality does not matter for PNG.
    const png = { ...FALLBACK_SETTINGS, format: 'png' as const };
    expect(processingKey({ ...png, jpegQuality: 60 }, photo)).toBe(processingKey(png, photo));
  });
});

describe('outputName', () => {
  const input = { fileName: 'Red Shoe.final.JPG', n: 7, format: 'jpg' as const, size: 2000 };

  it('fills the pattern from the photo name without its extension', () => {
    expect(outputName('{name}-white.{ext}', input)).toBe('Red Shoe.final-white.jpg');
    expect(outputName('{n:3}_{name}_{size}.{ext}', { ...input, format: 'png' })).toBe(
      '007_Red Shoe.final_2000.png',
    );
  });

  it('adds the extension when the pattern has none, and keeps unknown placeholders visible', () => {
    expect(outputName('product-{n}', input)).toBe('product-7.jpg');
    expect(outputName('{nam}.{ext}', input)).toBe('{nam}.jpg');
  });

  it('makes unsafe names safe', () => {
    expect(outputName('../{name}:{n}.{ext}', { ...input, fileName: '.png' })).toBe(
      '.._photo_7.jpg',
    );
  });
});
