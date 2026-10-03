import { describe, expect, it } from 'vitest';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import type { RawModel } from '../api/types';
import { CAPABILITIES } from '../../tools/types';
import { SHIPPED_DEFAULTS } from './defaults';
import { isFreeModelId } from './free';
import { capabilitiesOf, normalizeModel, priceNumber } from './normalize';

const raw = modelsFixture.data as unknown as RawModel[];
const models = raw.map(normalizeModel);
const byId = new Map(models.map((m) => [m.id, m]));

function caps(id: string): string[] {
  const model = byId.get(id);
  if (!model) throw new Error(`fixture lacks ${id}`);
  return model.capabilities;
}

describe('capabilities', () => {
  it('derives each kind as docs §9.2 describes', () => {
    expect(caps('openai/gpt-6.1-sol')).toEqual(['text', 'vision']);
    expect(caps('nvidia/nemotron-3-super-120b-a12b:free')).toEqual(['text']);
    expect(caps('google/gemini-3.1-flash-image')).toEqual(['text', 'vision', 'image']);
    expect(caps('black-forest-labs/flux.2-pro')).toEqual(['image']);
    expect(caps('hexgrad/kokoro-82m')).toEqual(['tts']);
    expect(caps('openai/whisper-1')).toEqual(['stt']);
    expect(caps('google/veo-3.1')).toEqual(['video']);
    expect(caps('typesafe/jev-1.13')).toEqual(['decisions']);
    // Music: audio output on a Lyria id, and never a text model.
    expect(caps('google/lyria-3-pro-preview')).toEqual(['music']);
    expect(caps('google/lyria-3-clip-preview')).toEqual(['music']);
    // Speech-chat models output audio too, but are not music.
    expect(caps('openai/gpt-audio')).toEqual(['text']);
    // Routers: text yes, /images no.
    expect(caps('openrouter/auto')).toEqual(['text', 'vision']);
    expect(caps('liquid/lfm-2.5-embedding-350m:free')).toEqual([]);
    expect(caps('voyageai/rerank-3')).toEqual([]);
  });

  it('gives every capability at least one model in the fixture', () => {
    for (const cap of CAPABILITIES) {
      expect(
        models.some((m) => m.capabilities.includes(cap)),
        cap,
      ).toBe(true);
    }
  });

  it('matches the output modalities of every fixture model', () => {
    for (const model of raw) {
      const out = model.architecture.output_modalities;
      const derived = capabilitiesOf(model);
      expect(derived.includes('tts'), model.id).toBe(out.includes('speech'));
      expect(derived.includes('stt'), model.id).toBe(out.includes('transcription'));
      expect(derived.includes('video'), model.id).toBe(out.includes('video'));
      expect(derived.includes('decisions'), model.id).toBe(out.includes('decisions'));
      if (derived.includes('vision')) expect(derived).toContain('text');
    }
  });
});

describe('free detection', () => {
  it('uses the id only: :free suffix and the openrouter/free router', () => {
    const free = models.filter((m) => m.isFree).map((m) => m.id);
    expect(free).toEqual(
      raw.map((m) => m.id).filter((id) => id.endsWith(':free') || id === 'openrouter/free'),
    );
    expect(free).toContain('openrouter/free');
    expect(free).toContain('fish-audio/s2.1-pro-free:free');
  });

  it('never treats a zero price as free', () => {
    const zeroPriced = raw.filter(
      (m) => m.pricing['prompt'] === '0' && m.pricing['completion'] === '0' && !isFreeModelId(m.id),
    );
    expect(zeroPriced.length).toBeGreaterThan(10);
    for (const model of zeroPriced) expect(byId.get(model.id)?.isFree, model.id).toBe(false);
    expect(byId.get('google/lyria-3-clip-preview')?.isFree).toBe(false);
    expect(byId.get('google/veo-3.1')?.isFree).toBe(false);
  });
});

describe('normalizeModel', () => {
  it('turns price strings into numbers and the -1 sentinel into null', () => {
    expect(byId.get('openai/gpt-6.1-sol')?.pricing).toMatchObject({
      prompt: 0.000002,
      completion: 0.00001,
      image: null,
      request: null,
    });
    expect(byId.get('openrouter/auto')?.pricing).toMatchObject({ prompt: null, completion: null });
    expect(byId.get('bytedance-seed/seedream-4.5')?.pricing.image).toBe(0);
    expect(priceNumber('-1')).toBeNull();
    expect(priceNumber('')).toBeNull();
    expect(priceNumber('abc')).toBeNull();
    expect(priceNumber(0.5)).toBe(0.5);
  });

  it('nulls per-token prices for non-token units but keeps the raw object', () => {
    const kokoro = byId.get('hexgrad/kokoro-82m');
    expect(kokoro?.pricing.prompt).toBeNull();
    expect(kokoro?.pricing.raw['prompt']).toBe('0.00000062');
    expect(byId.get('openai/whisper-1')?.pricing.prompt).toBeNull();
    expect(byId.get('google/veo-3.1')?.pricing.completion).toBeNull();
    expect(byId.get('google/lyria-3-pro-preview')?.pricing.prompt).toBeNull();
    // Decisions are billed per input token.
    expect(byId.get('typesafe/jev-1.13')?.pricing.prompt).toBe(0.000000042);
  });

  it('normalises the descriptive fields', () => {
    const alias = byId.get('~openai/gpt-sol-latest');
    expect(alias?.author).toBe('openai');
    expect(byId.get('openai/whisper-1')?.supportedVoices).toBeNull();
    expect(byId.get('hexgrad/kokoro-82m')?.supportedVoices?.length).toBe(54);
    expect(byId.get('fish-audio/s2.1-pro')?.contextLength).toBeNull();
    expect(byId.get('poolside/laguna-s-2.1:free')?.expirationDate).toBe('2026-10-31');
    expect(byId.get('openai/gpt-6.1-sol')?.supportedParameters).toContain('structured_outputs');
  });
});

describe('shipped defaults', () => {
  it('pairs each capability with a paid model and a :free model or null', () => {
    for (const cap of CAPABILITIES) {
      const entry = SHIPPED_DEFAULTS[cap];
      expect(isFreeModelId(entry.paid), cap).toBe(false);
      if (entry.free !== null) expect(isFreeModelId(entry.free), cap).toBe(true);
      expect(entry.reason.length, cap).toBeGreaterThan(20);
      expect(entry.reason, cap).not.toContain('\n');
    }
    for (const cap of ['image', 'stt', 'video', 'music'] as const) {
      expect(SHIPPED_DEFAULTS[cap].free).toBeNull();
    }
  });

  it('serves the capability it is the default for (where the fixture has the model)', () => {
    for (const cap of CAPABILITIES) {
      for (const id of [SHIPPED_DEFAULTS[cap].paid, SHIPPED_DEFAULTS[cap].free]) {
        const model = id ? byId.get(id) : undefined;
        if (model) expect(model.capabilities, `${cap} ${id}`).toContain(cap);
      }
    }
  });

  it('prefers structured-output text models', () => {
    const free = byId.get(SHIPPED_DEFAULTS.text.free ?? '');
    expect(free?.supportedParameters).toContain('structured_outputs');
  });
});
