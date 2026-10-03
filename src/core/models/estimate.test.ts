import { describe, expect, it } from 'vitest';
import lyriaEndpoints from '../../../tests/fixtures/openrouter/model-endpoints.google-lyria-3-pro-preview.json';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import videosFixture from '../../../tests/fixtures/openrouter/videos-models.json';
import type { RawModel, RawModelEndpoint, RawVideoModel } from '../api/types';
import type { ModelInfo } from '../types';
import {
  estimateDecision,
  estimateImage,
  estimateMusic,
  estimateSpeech,
  estimateTokens,
  estimateTranscription,
  estimateVideo,
} from './estimate';
import { normalizeModel } from './normalize';

const models = new Map(
  (modelsFixture.data as unknown as RawModel[]).map((m) => [m.id, normalizeModel(m)]),
);
const videos = new Map((videosFixture.data as unknown as RawVideoModel[]).map((m) => [m.id, m]));

function model(id: string): ModelInfo {
  const found = models.get(id);
  if (!found) throw new Error(`fixture lacks ${id}`);
  return found;
}

function video(id: string): RawVideoModel {
  const found = videos.get(id);
  if (!found) throw new Error(`fixture lacks ${id}`);
  return found;
}

function endpoint(prompt: string, completion = '0'): RawModelEndpoint {
  return { name: 'e', provider_name: 'p', pricing: { prompt, completion } };
}

describe('tokens and decisions', () => {
  it('multiplies token counts by catalog prices', () => {
    expect(estimateTokens(model('openai/gpt-6.1-sol'), 1000, 500)).toBeCloseTo(0.007, 10);
    expect(estimateTokens(model('openrouter/auto'), 1000, 500)).toBeNull();
  });

  it('bills decisions on input tokens only (matches the recorded Jev cost)', () => {
    expect(estimateDecision(model('typesafe/jev-1.13'), 476)).toBeCloseTo(0.000019992, 12);
  });

  it('applies long-context overrides above their threshold', () => {
    const sol = model('openai/gpt-6.1-sol'); // above 272k prompt tokens: $4 / $15 per M
    expect(estimateTokens(sol, 271_999, 0)).toBeCloseTo(271_999 * 0.000002, 8);
    expect(estimateTokens(sol, 300_000, 1000)).toBeCloseTo(300_000 * 0.000004 + 1000 * 0.000015, 8);
  });

  it('assumes surcharge windows without a threshold apply', () => {
    const base = model('openai/gpt-6.1-sol');
    const windowed = {
      ...base,
      pricing: {
        ...base.pricing,
        raw: { ...base.pricing.raw, overrides: [{ prompt: '0.000003' }, { prompt: '0.000001' }] },
      },
    };
    expect(estimateTokens(windowed, 1000, 0)).toBeCloseTo(1000 * 0.000003, 10);
  });
});

describe('speech', () => {
  it('uses the most expensive endpoint (matches the billed Kokoro request)', () => {
    const endpoints = [endpoint('0.00000062'), endpoint('0.000004')];
    expect(estimateSpeech({ model: 'hexgrad/kokoro-82m', characters: 44 }, endpoints)).toBeCloseTo(
      0.000176,
      10,
    );
  });

  it('adds audio-token output for token-priced models (Gemini TTS, billed $0.00057)', () => {
    const raw = model('google/gemini-3.8-flash-tts').pricing.raw;
    const endpoints = [endpoint(String(raw['prompt']), String(raw['completion']))];
    const estimate =
      estimateSpeech({ model: 'google/gemini-3.8-flash-tts', characters: 20 }, endpoints) ?? 0;
    expect(estimate).toBeGreaterThanOrEqual(0.00057);
    expect(estimate).toBeLessThan(0.001);
  });

  it('assumes slow speech for per-second output prices (Seed Audio)', () => {
    const endpoints = [endpoint('0', '0.0025')];
    // 100 characters at 4 per second = 25 s at $0.0025/s.
    expect(
      estimateSpeech({ model: 'bytedance-seed/seed-audio-1-0', characters: 100 }, endpoints),
    ).toBeCloseTo(0.0625, 10);
  });

  it('counts UTF-8 bytes for byte-priced providers (Fish Audio)', () => {
    const endpoints = [endpoint('0.000015')];
    const fish = { model: 'fish-audio/s2.1-pro', characters: 7 };
    expect(estimateSpeech({ ...fish, bytes: 12 }, endpoints)).toBeCloseTo(12 * 0.000015, 10);
    // Without the byte count, the worst case of 4 bytes per character.
    expect(estimateSpeech(fish, endpoints)).toBeCloseTo(28 * 0.000015, 10);
  });

  it('returns null without endpoint prices, never the cheapest catalog price', () => {
    expect(estimateSpeech({ model: 'hexgrad/kokoro-82m', characters: 10 }, [])).toBeNull();
    expect(
      estimateSpeech({ model: 'hexgrad/kokoro-82m', characters: 10 }, [
        { name: 'e', provider_name: 'p', pricing: {} },
      ]),
    ).toBeNull();
  });
});

describe('transcription', () => {
  it('bills per second, rounding up', () => {
    const whisper = model('openai/whisper-1').pricing.raw;
    expect(estimateTranscription(3.17, whisper)).toBeCloseTo(0.0004, 10);
  });

  it('bills per hour when the price is hourly (MAI-Transcribe: $0.000111 for 3.17 s)', () => {
    const mai = model('microsoft/mai-transcribe-2').pricing.raw;
    expect(estimateTranscription(3.17, mai)).toBeCloseTo(0.000111, 6);
  });

  it('estimates token-priced models from audio and text token rates', () => {
    const gemini = model('google/gemini-3.5-transcribe').pricing.raw;
    expect(estimateTranscription(60, gemini)).toBeCloseTo(
      60 * 32 * 0.000002 + 60 * 5 * 0.000012,
      10,
    );
  });
});

describe('image', () => {
  it('prices per-image models at their flat token count (Seedream 4.5: $0.04)', () => {
    expect(estimateImage(model('bytedance-seed/seedream-4.5'), { images: 1 })).toBeCloseTo(0.04, 6);
    expect(estimateImage(model('bytedance-seed/seedream-4.5'), { images: 3 })).toBeCloseTo(0.12, 6);
  });

  it('scales per-megapixel models with the output size (FLUX.2 Pro: $0.03 per MP)', () => {
    const flux = model('black-forest-labs/flux.2-pro');
    expect(estimateImage(flux, { images: 1, width: 2048, height: 2048 })).toBeCloseTo(0.12, 6);
    expect(estimateImage(flux, { images: 1, width: 512, height: 512 })).toBeCloseTo(0.0306, 4);
  });

  it('adds reference images', () => {
    const gpt = model('openai/gpt-image-2');
    const base = estimateImage(gpt, { images: 1 }) ?? 0;
    const withRef = estimateImage(gpt, { images: 1, references: 2 }) ?? 0;
    expect(withRef - base).toBeCloseTo(2 * 4096 * 0.000008, 8);
  });

  it('returns null for models without an image price', () => {
    expect(estimateImage(model('openai/gpt-6.1-sol'), { images: 1 })).toBeNull();
  });
});

describe('video', () => {
  it('prices Grok per second at the chosen resolution (recorded $0.052 incl. a $0.002 image)', () => {
    expect(
      estimateVideo(video('x-ai/grok-imagine-video'), { seconds: 1, resolution: '480p' }),
    ).toBeCloseTo(0.05, 6);
    expect(
      estimateVideo(video('x-ai/grok-imagine-video'), { seconds: 5, resolution: '720p' }),
    ).toBeCloseTo(0.35, 6);
  });

  it('prices token-billed Seedance from frame size (recorded $0.1358 for 4.04 s at 480p)', () => {
    const estimate = estimateVideo(video('bytedance/seedance-2.0-mini'), {
      seconds: 4.04,
      resolution: '480p',
    });
    expect(estimate).toBeCloseTo(0.1358, 3);
  });

  it('picks the most specific SKU for resolution and audio', () => {
    const veo = video('google/veo-3.1-fast');
    expect(estimateVideo(veo, { seconds: 8, resolution: '720p', withAudio: true })).toBeCloseTo(
      0.8,
      6,
    );
    expect(estimateVideo(veo, { seconds: 8, resolution: '720p', withAudio: false })).toBeCloseTo(
      0.64,
      6,
    );
    expect(estimateVideo(veo, { seconds: 8, resolution: '4K', withAudio: true })).toBeCloseTo(
      2.4,
      6,
    );
    // Unknown audio choice: the dearer option.
    expect(estimateVideo(veo, { seconds: 8, resolution: '720p' })).toBeCloseTo(0.8, 6);
  });

  it('counts the with-audio price when the audio choice is unknown (Kling)', () => {
    const kling = video('kwaivgi/kling-v3.0-pro');
    expect(estimateVideo(kling, { seconds: 5, resolution: '720p', withAudio: false })).toBeCloseTo(
      0.56,
      6,
    );
    expect(estimateVideo(kling, { seconds: 5, resolution: '720p', withAudio: true })).toBeCloseTo(
      0.84,
      6,
    );
    expect(estimateVideo(kling, { seconds: 5, resolution: '720p' })).toBeCloseTo(0.84, 6);
  });

  it('is conservative without a resolution and applies minimum charges', () => {
    expect(estimateVideo(video('minimax/hailuo-3-max'), { seconds: 5 })).toBeCloseTo(0.4, 6);
    expect(estimateVideo(video('runway/aleph-2'), { seconds: 1 })).toBeCloseTo(0.56, 6);
    expect(estimateVideo(video('runway/aleph-2'), { seconds: 10 })).toBeCloseTo(2.8, 6);
  });

  it('ignores reference and continuation surcharges', () => {
    expect(
      estimateVideo(video('black-forest-labs/flux-3-video'), { seconds: 5, resolution: '720p' }),
    ).toBeCloseTo(0.85, 6);
    expect(
      estimateVideo(video('heygen/heygen-video-1'), { seconds: 5, resolution: '480p' }),
    ).toBeCloseTo(0.1, 6);
  });

  it('returns null when nothing applies', () => {
    expect(estimateVideo(video('black-forest-labs/flux-video-upscale'), { seconds: 5 })).toBeNull();
    expect(
      estimateVideo(video('heygen/heygen-video-1'), { seconds: 5, resolution: '4K' }),
    ).toBeNull();
  });

  it('estimates every model with durations in the fixture', () => {
    for (const entry of videos.values()) {
      if (!entry.supported_durations) continue;
      const seconds = entry.supported_durations[0] ?? 5;
      const resolution = entry.supported_resolutions?.[0];
      const estimate = estimateVideo(entry, resolution ? { seconds, resolution } : { seconds });
      expect(estimate, entry.id).not.toBeNull();
      expect(estimate ?? 0, entry.id).toBeGreaterThan(0);
    }
  });
});

describe('music', () => {
  it('reads the flat per-song price from the description, with a table fallback', () => {
    expect(estimateMusic(model('google/lyria-3-pro-preview'))).toBe(0.08);
    expect(estimateMusic(model('google/lyria-3-clip-preview'))).toBe(0.04);
    expect(estimateMusic({ id: 'google/lyria-3-pro-preview', description: '' })).toBe(0.08);
    expect(
      estimateMusic({ id: lyriaEndpoints.data.id, description: lyriaEndpoints.data.description }),
    ).toBe(0.08);
    expect(estimateMusic({ id: 'other/model', description: '' })).toBeNull();
  });
});
