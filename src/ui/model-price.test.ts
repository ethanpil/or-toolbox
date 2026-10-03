import { describe, expect, it } from 'vitest';
import modelsFixture from '../../tests/fixtures/openrouter/models.json';
import type { RawModel } from '../core/api/types';
import { normalizeModel } from '../core/models/normalize';
import type { ModelInfo } from '../core/types';
import { formatModelPrice, formatUsd } from './format';
import { comparablePrice, describePrice, modelPrice, roundUsd } from './model-price';

const models = new Map(
  (modelsFixture.data as unknown as RawModel[]).map((raw) => [raw.id, normalizeModel(raw)]),
);
const get = (id: string): ModelInfo => {
  const model = models.get(id);
  if (!model) throw new Error(`fixture lacks ${id}`);
  return model;
};
const text = (id: string): string => describePrice(modelPrice(get(id)), formatUsd).text;
const extras = (id: string): string[] => describePrice(modelPrice(get(id)), formatUsd).extras;

/** A model built from a raw catalog entry, for shapes the fixture lacks. */
function synthetic(raw: Partial<RawModel> & { id: string }): ModelInfo {
  return normalizeModel({
    name: raw.id,
    created: 0,
    context_length: null,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: {},
    ...raw,
  });
}

describe('free models', () => {
  it('are free by id only', () => {
    expect(modelPrice(get('qwen/qwen3.8-27b:free'))).toEqual({ kind: 'free' });
    expect(text('qwen/qwen3.8-27b:free')).toBe('Free');
    expect(text('openrouter/free')).toBe('Free');
    // Every video model prices at "0" and is not free.
    expect(modelPrice(get('google/veo-3.1')).kind).not.toBe('free');
  });
});

describe('token-priced models', () => {
  it('show input and output per 1M tokens', () => {
    expect(modelPrice(get('openai/gpt-6.1-sol'))).toMatchObject({
      kind: 'tokens',
      inputPerM: 2,
      outputPerM: 10,
    });
    expect(text('openai/gpt-6.1-sol')).toBe('$2.00 in · $10.00 out per 1M tokens');
    expect(extras('openai/gpt-6.1-sol')).toEqual([]);
  });

  it('decisions models bill input only', () => {
    expect(text('typesafe/jev-1.13')).toBe('$0.042 in · $0.00 out per 1M tokens');
  });

  it('have no float artefacts', () => {
    // 0.0000001 * 1e6 is 0.09999999999999999 in floating point.
    const model = synthetic({
      id: 'a/b',
      pricing: { prompt: '0.0000001', completion: '0.0000005' },
    });
    expect(modelPrice(model)).toMatchObject({ inputPerM: 0.1, outputPerM: 0.5 });
    expect(comparablePrice(modelPrice(model))).toEqual({ group: 1, amount: 0.6 });
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
  });
});

describe('image models', () => {
  it('image-only models bill the output image (4175 image tokens for a 1 MP image)', () => {
    expect(modelPrice(get('black-forest-labs/flux.2-pro'))).toMatchObject({
      kind: 'unit',
      unit: 'image',
    });
    expect(text('black-forest-labs/flux.2-pro')).toBe('≈ $0.031 per image');
    // Seedream bills a flat $0.04 per image.
    expect(text('bytedance-seed/seedream-4.5')).toBe('≈ $0.04 per image');
  });

  it('chat models that also draw show the tokens first and the image as an extra line', () => {
    expect(text('google/gemini-3.1-flash-image')).toBe('$0.50 in · $3.00 out per 1M tokens');
    expect(extras('google/gemini-3.1-flash-image')).toEqual(['Image output: ≈ $0.25 per image']);
    expect(extras('openai/gpt-image-2')).toEqual(['Image output: ≈ $0.13 per image']);
  });
});

describe('audio models', () => {
  it('chat models with audio list the audio token prices', () => {
    expect(text('openai/gpt-audio')).toBe('$2.50 in · $10.00 out per 1M tokens');
    expect(extras('openai/gpt-audio')).toEqual(['Audio: $32.00 in · $64.00 out per 1M tokens']);
  });

  it('speech: per character, per byte, per second of speech, or per token', () => {
    expect(text('hexgrad/kokoro-82m')).toBe('$0.62 per 1M characters');
    expect(modelPrice(get('hexgrad/kokoro-82m'))).toMatchObject({ unit: 'character' });
    expect(text('fish-audio/s2.1-pro')).toBe('$15.00 per 1M bytes of text');
    expect(text('bytedance-seed/seed-audio-1-0')).toBe('$0.0025 per second of speech');
    // Gemini TTS bills prompt and audio tokens.
    expect(text('google/gemini-3.8-flash-tts')).toBe('$0.50 in · $9.00 out per 1M tokens');
  });

  it('transcription: per hour of audio, or per token', () => {
    // Whisper bills $0.0001 per second.
    expect(text('openai/whisper-1')).toBe('$0.36 per hour of audio');
    // MAI Transcribe lists $0.10 per hour.
    expect(text('microsoft/mai-transcribe-2')).toBe('$0.10 per hour of audio');
    expect(modelPrice(get('openai/whisper-1'))).toMatchObject({ unit: 'audio-hour', amount: 0.36 });
    expect(text('openai/gpt-4o-transcribe')).toBe('$2.50 in · $10.00 out per 1M tokens');
  });
});

describe('other units', () => {
  it('music is billed per clip or song', () => {
    expect(text('google/lyria-3-clip-preview')).toBe('$0.04 per clip or song');
    expect(text('google/lyria-3-pro-preview')).toBe('$0.08 per clip or song');
  });

  it('video prices depend on the request, so there is no single number', () => {
    expect(modelPrice(get('google/veo-3.1'))).toMatchObject({ kind: 'varies' });
    expect(text('google/veo-3.1')).toBe('Billed per second of video');
  });

  it('per request prices keep their unit', () => {
    const model = synthetic({
      id: 'a/b',
      pricing: { prompt: '0', completion: '0', request: '0.04' },
    });
    expect(describePrice(modelPrice(model), formatUsd).text).toBe('$0.04 per request');
    expect(comparablePrice(modelPrice(model))).toEqual({ group: 8, amount: 0.04 });
  });

  it('routers and unknown prices vary', () => {
    expect(modelPrice(get('openrouter/auto'))).toMatchObject({ kind: 'varies' });
    expect(text('openrouter/auto')).toBe('Price varies');
    expect(comparablePrice(modelPrice(get('openrouter/auto')))).toBeNull();
    expect(text('liquid/lfm-2.5-embedding-350m:free')).toBe('Free');
  });

  it('a price per input image alone is named as such', () => {
    const model = synthetic({ id: 'a/b', pricing: { image: '0.03' } });
    expect(describePrice(modelPrice(model), formatUsd).text).toBe('$0.03 per input image');
  });
});

describe('comparing prices like with like', () => {
  const key = (id: string) => comparablePrice(modelPrice(get(id)));

  it('free comes first whatever the family', () => {
    expect(key('qwen/qwen3.8-27b:free')).toEqual({ group: 0, amount: 0 });
    expect(key('fish-audio/s2.1-pro-free:free')).toEqual({ group: 0, amount: 0 });
  });

  it('tokens compare as input plus output per 1M; other units are groups of their own', () => {
    expect(key('openai/gpt-6.1-sol')).toEqual({ group: 1, amount: 12 });
    expect(key('black-forest-labs/flux.2-pro')?.group).toBe(2);
    expect(key('hexgrad/kokoro-82m')?.group).toBeGreaterThan(2);
    expect(key('openai/whisper-1')?.group).not.toBe(key('hexgrad/kokoro-82m')?.group);
    expect(key('google/veo-3.1')).toBeNull();
  });
});

describe('formatModelPrice delegates to the same model', () => {
  it('agrees for every family of the fixture', () => {
    for (const model of models.values()) {
      expect(formatModelPrice(model)).toBe(describePrice(modelPrice(model), formatUsd).text);
    }
  });
});
