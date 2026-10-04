import { describe, expect, it } from 'vitest';
import { chunkLimit, DEFAULT_CHUNK_CHARS, speedSupported, voiceLabel } from './voices';

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

  it('keeps requests short, and inside a small token context', () => {
    expect(chunkLimit(undefined)).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit({ contextLength: 0 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit({ contextLength: 4096 })).toBe(DEFAULT_CHUNK_CHARS);
    expect(chunkLimit({ contextLength: 300 })).toBe(600);
  });
});
