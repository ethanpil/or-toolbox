import { describe, expect, it } from 'vitest';
import {
  chunkLimit,
  DEFAULT_CHUNK_CHARS,
  PREVIEW_TEXT,
  previewText,
  speedSupported,
  voiceLabel,
  voiceLanguage,
} from './voices';

describe('voices', () => {
  it('names Kokoro and MAI-Voice voices, and leaves others as they are', () => {
    expect(voiceLabel('af_alloy')).toBe('Alloy (American English, female)');
    expect(voiceLabel('bm_george')).toBe('George (British English, male)');
    expect(voiceLabel('en-US-Harper:MAI-Voice-2.1')).toBe('Harper (en-US)');
    expect(voiceLabel('Zephyr')).toBe('Zephyr');
    expect(voiceLabel('aura-2-thalia-en')).toBe('aura-2-thalia-en');
  });

  it('offers speed only where it is known to work', () => {
    expect(speedSupported({ id: 'hexgrad/kokoro-82m', supportedParameters: [] })).toBe(true);
    expect(speedSupported({ id: 'bytedance-seed/seed-audio-1-0', supportedParameters: [] })).toBe(
      true,
    );
    expect(speedSupported({ id: 'google/gemini-3.8-flash-tts', supportedParameters: [] })).toBe(
      false,
    );
    expect(speedSupported({ id: 'x/new-tts', supportedParameters: ['speed'] })).toBe(true);
  });

  it('keeps requests to about a minute of speech, and inside a small token context', () => {
    const kokoro = { id: 'hexgrad/kokoro-82m', contextLength: 4096 };
    expect(DEFAULT_CHUNK_CHARS).toBe(900);
    expect(chunkLimit(undefined)).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit({ id: 'x/tts', contextLength: 0 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit(kokoro, { text: 'Plain English text.' })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit({ id: 'x/tts', contextLength: 300 })).toBe(600);
  });

  it('makes parts shorter for CJK text and slow speeds, never longer for fast ones', () => {
    const model = { id: 'x/tts', contextLength: 0 };
    expect(chunkLimit(model, { text: '今天天气很好。我们去公园散步吧！' })).toBe(300);
    expect(chunkLimit(model, { text: 'こんにちは、元気ですか。' })).toBe(300);
    expect(chunkLimit(model, { text: '안녕하세요 반갑습니다' })).toBe(420);
    // Half Chinese, half English (by letters): between the two.
    const mixed = chunkLimit(model, { text: '你好世界 abcd' });
    expect(mixed).toBeGreaterThan(300);
    expect(mixed).toBeLessThan(900);
    expect(chunkLimit(model, { text: 'Slow.', speed: 0.5 })).toBe(450);
    expect(chunkLimit(model, { text: 'Fast.', speed: 2 })).toBe(900);
    expect(chunkLimit(model, { text: '慢', speed: 0.5 })).toBe(150);
  });

  it('keeps Seed Audio within its 3,000 characters and 120 seconds', () => {
    const seed = { id: 'bytedance-seed/seed-audio-1-0', contextLength: 0 };
    const limit = chunkLimit(seed, { text: 'English.', speed: 0.5 });
    expect(limit).toBeLessThanOrEqual(3000);
    // At 15 characters a second and half speed, a part is at most 60 s at 1× pace, 120 s at 0.5×.
    expect(limit / 15 / 0.5).toBeLessThanOrEqual(120);
  });

  it('previews a voice in its own language', () => {
    expect(voiceLanguage('af_alloy')).toBe('en');
    expect(voiceLanguage('jf_alpha')).toBe('ja');
    expect(voiceLanguage('fr-FR-Denise:MAI-Voice-2.1')).toBe('fr');
    expect(voiceLanguage('Kore')).toBeNull();
    expect(previewText('af_alloy')).toBe(PREVIEW_TEXT);
    expect(previewText('zf_xiaobei')).toBe('你好！这就是我朗读你的文字时的声音。');
    expect(previewText('ef_dora')).toMatch(/^¡Hola!/);
    expect(previewText('Kore')).toBe(PREVIEW_TEXT);
    expect(previewText(null)).toBe(PREVIEW_TEXT);
  });
});
