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

/** The preview sentence in each language a voice id names (ISO 639-1); English for anything else. */
const PREVIEW_TEXTS: Readonly<Record<string, string>> = {
  en: PREVIEW_TEXT,
  es: '¡Hola! Así sueno cuando leo tu texto en voz alta.',
  fr: 'Bonjour ! Voici ma voix quand je lis votre texte à voix haute.',
  de: 'Hallo! So klinge ich, wenn ich deinen Text vorlese.',
  it: 'Ciao! Ecco come suono quando leggo ad alta voce il tuo testo.',
  pt: 'Olá! É assim que eu soo quando leio o seu texto em voz alta.',
  hi: 'नमस्ते! जब मैं आपका पाठ ज़ोर से पढ़ता हूँ, तो मेरी आवाज़ ऐसी होती है।',
  ja: 'こんにちは！あなたの文章を読み上げると、こんな声になります。',
  zh: '你好！这就是我朗读你的文字时的声音。',
  ko: '안녕하세요! 제가 글을 소리 내어 읽으면 이런 목소리예요.',
};

/** Kokoro's voice prefixes (`af_alloy`: American English, female) and their languages. */
const KOKORO_LANGUAGES: Readonly<Record<string, { name: string; code: string }>> = {
  a: { name: 'American English', code: 'en' },
  b: { name: 'British English', code: 'en' },
  e: { name: 'Spanish', code: 'es' },
  f: { name: 'French', code: 'fr' },
  h: { name: 'Hindi', code: 'hi' },
  i: { name: 'Italian', code: 'it' },
  j: { name: 'Japanese', code: 'ja' },
  p: { name: 'Brazilian Portuguese', code: 'pt' },
  z: { name: 'Mandarin Chinese', code: 'zh' },
};

const KOKORO_VOICE = /^([a-z])([fm])_([a-z0-9]+)$/;
const LOCALE_VOICE = /^([a-z]{2,3})-([A-Z]{2})-([^:]+):/;

/** The language a voice id names (`af_alloy` → en, `fr-FR-Denise:…` → fr), or null when it names none. */
export function voiceLanguage(id: string | null): string | null {
  if (!id) return null;
  const kokoro = KOKORO_VOICE.exec(id);
  if (kokoro) return KOKORO_LANGUAGES[kokoro[1]!]?.code ?? null;
  return LOCALE_VOICE.exec(id)?.[1] ?? null;
}

/** The sentence a preview of `voice` reads: in the voice's own language when known, else English. */
export function previewText(voice: string | null): string {
  return PREVIEW_TEXTS[voiceLanguage(voice) ?? 'en'] ?? PREVIEW_TEXT;
}

/**
 * Seconds of speech one request should hold. Providers time out requests at about 60 seconds and Seed Audio
 * stops at 120 seconds of output (docs/openrouter-api.md §4.3); synthesis is usually faster than real time, so
 * a minute of speech per request stays inside both.
 */
export const PART_SECONDS = 60;
/** Characters a voice reads per second at 1×: about 150 words a minute in alphabetic scripts. */
const CHARS_PER_SECOND = 15;
/** Han and kana carry a syllable or more each (about 5 a second); Hangul syllable blocks about 7. */
const CJK_CHARS_PER_SECOND = 5;
const HANGUL_CHARS_PER_SECOND = 7;
/** Seed Audio's documented input limit. */
const SEED_AUDIO_MAX_CHARS = 3000;

/** Characters per request when nothing else is known: a minute of alphabetic text at 1×. */
export const DEFAULT_CHUNK_CHARS = CHARS_PER_SECOND * PART_SECONDS;

/** Characters per second of speech for `text` at 1×, from its mix of scripts. */
export function charsPerSecond(text: string): number {
  const letters = text.replace(/[\s\p{P}\p{S}]/gu, '');
  if (!letters) return CHARS_PER_SECOND;
  const cjk = (letters.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? [])
    .length;
  const hangul = (letters.match(/\p{Script=Hangul}/gu) ?? []).length;
  const other = letters.length - cjk - hangul;
  // Seconds per character, averaged over the text, turned back into characters per second.
  const secondsPerChar =
    (cjk / CJK_CHARS_PER_SECOND + hangul / HANGUL_CHARS_PER_SECOND + other / CHARS_PER_SECOND) /
    letters.length;
  return 1 / secondsPerChar;
}

/**
 * Characters per request for `model` reading `text` at `speed`: about `PART_SECONDS` of speech, so fewer
 * characters for CJK text and for slow speeds (a faster speed never makes parts longer). Also within Seed
 * Audio's 3,000 characters, and within a small token context (4,096 for Kokoro) at two characters per token.
 */
export function chunkLimit(
  model: Pick<ModelInfo, 'id' | 'contextLength'> | undefined,
  { text = '', speed = 1 }: { text?: string; speed?: number | null } = {},
): number {
  const rate = Math.min(1, speed ?? 1);
  let limit = Math.floor(charsPerSecond(text.slice(0, 20_000)) * PART_SECONDS * rate);
  const context = model?.contextLength ?? 0;
  if (context > 0) limit = Math.min(limit, context * 2);
  if (model && /^bytedance-seed\/seed-audio/.test(model.id)) {
    limit = Math.min(limit, SEED_AUDIO_MAX_CHARS);
  }
  return Math.max(50, limit);
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

const capitalise = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * A readable name for a voice id: Kokoro's `af_alloy` is "Alloy (American English, female)", MAI-Voice's
 * `en-US-Harper:MAI-Voice-2.1` is "Harper (en-US)"; anything else is shown as it is.
 */
export function voiceLabel(id: string): string {
  const kokoro = KOKORO_VOICE.exec(id);
  const language = kokoro ? KOKORO_LANGUAGES[kokoro[1]!] : undefined;
  if (kokoro && language) {
    const gender = kokoro[2] === 'f' ? 'female' : 'male';
    return `${capitalise(kokoro[3]!)} (${language.name}, ${gender})`;
  }
  const azure = LOCALE_VOICE.exec(id);
  if (azure) return `${azure[3]} (${azure[1]}-${azure[2]})`;
  return id;
}
