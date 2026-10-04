/**
 * What the TTS tool needs to know about a speech model beyond the catalog: readable voice names, whether it
 * takes a speed, and how long one request may be. (Which audio format a model returns is the API client's
 * `defaultSpeechFormat`.)
 *
 * Facts from docs/openrouter-api.md §4: voices come only from the catalog's `supported_voices` (null for Fish
 * Audio and Seed Audio, whose `voice` is optional); `response_format` is `mp3` or `pcm` and Gemini TTS refuses
 * mp3; no model's maximum input is documented except Seed Audio's 3,000 characters.
 */
import type { ModelInfo } from '../../core/types';

/** The sentence a voice preview reads. Short, so a preview costs a fraction of a cent (and nothing on a free model). */
export const PREVIEW_TEXT = 'Hello! This is how I sound when I read your text aloud.';

/** Characters per request when the model gives no tighter hint: about a minute of speech. */
export const DEFAULT_CHUNK_CHARS = 1000;

/**
 * Characters per request for `model`. No speech model documents a maximum input except Seed Audio (3,000); a
 * request of about a minute of speech also stays well inside the providers' 60-second request timeouts. A
 * token context (4,096 for Kokoro) is respected as roughly two characters per token, never more.
 */
export function chunkLimit(model: Pick<ModelInfo, 'contextLength'> | undefined): number {
  const context = model?.contextLength ?? 0;
  return context > 0 ? Math.min(DEFAULT_CHUNK_CHARS, context * 2) : DEFAULT_CHUNK_CHARS;
}

/**
 * Models that take `speed`. The catalog lists no parameters for speech models, so this is by family: Seed Audio
 * documents 0.5-2.0; Voxtral's API example sends it; Kokoro's providers (DeepInfra, Together) take OpenAI's
 * `speed`. Others may ignore or refuse it, so the control is hidden for them.
 */
const SPEED_MODELS = /^(bytedance-seed\/seed-audio|mistralai\/voxtral|hexgrad\/kokoro)/;

export function speedSupported(model: Pick<ModelInfo, 'id' | 'supportedParameters'>): boolean {
  return model.supportedParameters.includes('speed') || SPEED_MODELS.test(model.id);
}

const KOKORO_LANGUAGES: Readonly<Record<string, string>> = {
  a: 'American English',
  b: 'British English',
  e: 'Spanish',
  f: 'French',
  h: 'Hindi',
  i: 'Italian',
  j: 'Japanese',
  p: 'Brazilian Portuguese',
  z: 'Mandarin Chinese',
};

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A readable name for a voice id: Kokoro's `af_alloy` is "Alloy (American English, female)", MAI-Voice's
 * `en-US-Harper:MAI-Voice-2.1` is "Harper (en-US)"; anything else is shown as it is.
 */
export function voiceLabel(id: string): string {
  const kokoro = /^([a-z])([fm])_([a-z0-9]+)$/.exec(id);
  if (kokoro && KOKORO_LANGUAGES[kokoro[1]!]) {
    const gender = kokoro[2] === 'f' ? 'female' : 'male';
    return `${capitalise(kokoro[3]!)} (${KOKORO_LANGUAGES[kokoro[1]!]}, ${gender})`;
  }
  const azure = /^([a-z]{2,3}-[A-Z]{2})-([^:]+):/.exec(id);
  if (azure) return `${azure[2]} (${azure[1]})`;
  return id;
}
