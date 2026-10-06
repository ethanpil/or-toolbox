/**
 * Pre-run cost estimates in USD. Pure functions over catalog data; null when the price cannot be derived.
 * Units differ per model family and are not machine-readable (docs/openrouter-api.md §4.3, §5.4, §7.5), so the
 * heuristics below err on the high side. The real cost always arrives later as `usage.cost`.
 *
 * Free models are `:free` ids, answered before any of these run (`ModelsService.estimate`). Here a price of zero
 * is unknown, not free: image, decisions and media models list "0" for prices they bill another way, so an
 * estimate whose every price is zero is null.
 */

import type { RawModelEndpoint, RawVideoModel } from '../api/types';
import type { ModelInfo } from '../types';
import { isFiniteNumber, isRecord } from '../util';
import { priceNumber } from './normalize';

/** Gemini TTS produced 63 audio tokens for 20 characters; rounded up. */
const AUDIO_TOKENS_PER_CHARACTER = 3.5;
/** Very slow speech (real speech is ~15 characters/s), so per-second TTS prices are never underestimated. */
const SPEECH_CHARACTERS_PER_SECOND = 4;
/** UTF-8 can take 4 bytes per character; assumed when the byte count is not given. */
const MAX_UTF8_BYTES_PER_CHARACTER = 4;
/** Providers that bill TTS input per UTF-8 byte rather than per character (§4.3). */
const BYTE_PRICED_TTS = /^fish-audio\//;
/** A TTS completion price at or above this is per second of output (Seed Audio $0.0025/s), not per token. */
const PER_SECOND_COMPLETION_THRESHOLD = 0.0005;
/** Token-priced STT: Gemini bills 32 audio tokens per second; transcript tokens are a few per second. */
const STT_AUDIO_TOKENS_PER_SECOND = 32;
const STT_TEXT_TOKENS_PER_SECOND = 5;
/** An STT prompt price at or above this is per hour (MAI-Transcribe 0.1 and 0.36), billed in whole seconds. */
const PER_HOUR_THRESHOLD = 0.01;
/** One image token covers 16x16 pixels (1024x1024 = 4096 tokens), and per-image models bill a flat 4175. */
const PIXELS_PER_IMAGE_TOKEN = 256;
const MIN_IMAGE_TOKENS = 4175;
/** Tokens counted for one 1024x1024 reference image. */
const REFERENCE_IMAGE_TOKENS = 4096;
/** An input-image price at or above this is per image; below it is per token. */
const PER_IMAGE_THRESHOLD = 0.0005;
/** Seedance-style video tokens: width x height x seconds x 24 / 1024 (§7.3). */
const VIDEO_TOKEN_FRAMES = 24;

/** Flat prices for music models whose catalog price is "0" and whose description does not parse. */
const MUSIC_FLAT_PRICES: Readonly<Record<string, number>> = {
  'google/lyria-3-clip-preview': 0.04,
  'google/lyria-3-pro-preview': 0.08,
};

function price(raw: Record<string, unknown>, key: string): number {
  return priceNumber(raw[key]) ?? 0;
}

/**
 * Per-token prices for a request of `promptTokens`: the base prices raised by every `pricing.overrides` entry
 * that may apply (§9.3). Entries with `min_prompt_tokens` (long-context surcharges) apply from that size up;
 * entries without it (time windows) are assumed to apply, so a surcharge window is never missed.
 */
function tokenPrices(
  model: ModelInfo,
  promptTokens: number,
): { prompt: number; completion: number } | null {
  let { prompt, completion } = model.pricing;
  if (prompt === null || completion === null) return null;
  const overrides = model.pricing.raw['overrides'];
  if (Array.isArray(overrides)) {
    for (const override of overrides) {
      if (!isRecord(override)) continue;
      const min = override['min_prompt_tokens'];
      if (isFiniteNumber(min) && promptTokens < min) continue;
      prompt = Math.max(prompt, priceNumber(override['prompt']) ?? 0);
      completion = Math.max(completion, priceNumber(override['completion']) ?? 0);
    }
  }
  return { prompt, completion };
}

/** Which side of a token request carries audio (`EstimateInput` tokens `audio`). */
export interface AudioSides {
  /** The prompt includes audio: every prompt token is priced at the audio input rate when that is higher. */
  input?: boolean;
  /** The reply is audio: every completion token is priced at the audio output rate when that is higher. */
  output?: boolean;
}

/**
 * Token requests. Audio is priced per side, high: the prompt token count does not say how much of it is audio,
 * so with `audio.input` all of it is (`pricing.audio`), and with `audio.output` all of the completion
 * (`pricing.audio_output`).
 */
export function estimateTokens(
  model: ModelInfo,
  promptTokens: number,
  completionTokens: number,
  audio: AudioSides = {},
): number | null {
  const prices = tokenPrices(model, promptTokens);
  if (!prices) return null;
  const raw = model.pricing.raw;
  const prompt = audio.input ? Math.max(prices.prompt, price(raw, 'audio')) : prices.prompt;
  const completion = audio.output
    ? Math.max(prices.completion, price(raw, 'audio_output'))
    : prices.completion;
  if (prompt === 0 && completion === 0) return null;
  return promptTokens * prompt + completionTokens * completion;
}

export function estimateDecision(model: ModelInfo, inputTokens: number): number | null {
  // Billing is input tokens only (§8.2).
  const prices = tokenPrices(model, inputTokens);
  return prices && prices.prompt > 0 ? inputTokens * prices.prompt : null;
}

/**
 * TTS from the provider endpoints. The catalog shows only the cheapest endpoint and routing is not controllable,
 * so the most expensive endpoint is used (§0); without endpoint prices there is no estimate (null), never the
 * cheapest catalog price. `prompt` is per character, per UTF-8 byte for Fish Audio, per token for Gemini (per
 * character overestimates tokens safely); `completion` is per audio token, or per second of output when large.
 */
export function estimateSpeech(
  input: { model: string; characters: number; bytes?: number },
  endpoints: RawModelEndpoint[],
): number | null {
  const sources = endpoints.map((e) => (isRecord(e.pricing) ? e.pricing : {}));
  if (!sources.some((p) => priceNumber(p['prompt']) !== null)) return null;
  const prompt = Math.max(...sources.map((p) => price(p, 'prompt')));
  const completion = Math.max(...sources.map((p) => price(p, 'completion')));
  if (prompt === 0 && completion === 0) return null;
  const { characters } = input;
  const units = BYTE_PRICED_TTS.test(input.model)
    ? (input.bytes ?? characters * MAX_UTF8_BYTES_PER_CHARACTER)
    : characters;
  const output =
    completion >= PER_SECOND_COMPLETION_THRESHOLD
      ? completion * (characters / SPEECH_CHARACTERS_PER_SECOND)
      : completion * characters * AUDIO_TOKENS_PER_CHARACTER;
  return units * prompt + output;
}

export function estimateTranscription(
  seconds: number,
  pricing: Record<string, unknown>,
): number | null {
  const prompt = priceNumber(pricing['prompt']);
  if (prompt === null) return null;
  const completion = price(pricing, 'completion');
  if (prompt === 0 && completion === 0) return null;
  if (completion > 0) {
    return (
      seconds * STT_AUDIO_TOKENS_PER_SECOND * prompt +
      seconds * STT_TEXT_TOKENS_PER_SECOND * completion
    );
  }
  const billed = Math.ceil(seconds);
  return prompt >= PER_HOUR_THRESHOLD ? (billed / 3600) * prompt : billed * prompt;
}

/**
 * Images: `image_output` is USD per output image token. Per-megapixel models bill width x height / 256 tokens,
 * per-image models a flat 4175 (so 1 MP is the floor). References add the input-image price; a model that lists
 * none (per-megapixel FLUX) is charged for each reference as for one more output image, which is high (klein
 * billed $0.001 for a 1024x1024 reference against $0.014 for the output). A zero price is unknown, not free.
 */
export function estimateImage(
  model: ModelInfo,
  input: {
    images: number;
    width?: number;
    height?: number;
    references?: number;
    requests?: number;
  },
): number | null {
  const raw = model.pricing.raw;
  const perToken = priceNumber(raw['image_output']) ?? priceNumber(raw['image_token']);
  if (perToken === null || perToken === 0) return null;
  const pixels = input.width && input.height ? input.width * input.height : 0;
  const tokens = Math.max(MIN_IMAGE_TOKENS, Math.ceil(pixels / PIXELS_PER_IMAGE_TOKEN));
  let total = input.images * tokens * perToken;
  const references = input.references ?? 0;
  if (references > 0) {
    const imagePrice = price(raw, 'image');
    const listed =
      (imagePrice >= PER_IMAGE_THRESHOLD ? imagePrice : imagePrice * REFERENCE_IMAGE_TOKENS) +
      (model.pricing.prompt ?? 0) * REFERENCE_IMAGE_TOKENS;
    const perReference = listed > 0 ? listed : tokens * perToken;
    // Every request uploads its references again: one request with `n`, or one per image.
    total += references * Math.max(1, input.requests ?? 1) * perReference;
  }
  return total;
}

/** Flat per-song price: from the description ("$0.08 per song"), else the known table. */
export function estimateMusic(model: Pick<ModelInfo, 'id' | 'description'>): number | null {
  const match = /\$\s?(\d+(?:\.\d+)?)\s*(?:per|\/)\s*(?:song|clip)/i.exec(model.description);
  if (match?.[1]) return Number(match[1]);
  return MUSIC_FLAT_PRICES[model.id] ?? null;
}

// --- video ----------------------------------------------------------------------------------------

type VideoUnit = 'usd-per-second' | 'cents-per-second' | 'usd-per-token' | 'min-cents';

interface VideoSku {
  unit: VideoUnit;
  value: number;
  resolution: string | null;
  audio: 'with' | 'without' | null;
}

/** Interprets one `pricing_skus` key; null for SKUs that do not apply to plain generation. */
function parseSku(key: string, rawValue: string): VideoSku | null {
  const value = priceNumber(rawValue);
  if (value === null) return null;
  const k = key.toLowerCase();
  // Reference, continuation and video-input surcharges, and per-image input prices, are out of scope.
  if (/reference|continuation|with_video_input|image_input|megapixel/.test(k)) return null;
  let unit: VideoUnit;
  if (k === 'minimum_cents_per_generation') unit = 'min-cents';
  else if (k.startsWith('cents_per_') && k.includes('second')) unit = 'cents-per-second';
  else if (k.startsWith('video_tokens')) unit = 'usd-per-token';
  else if (k.includes('duration_seconds')) unit = 'usd-per-second';
  else return null;
  const resolution = /(?:^|_)(\d{3,4}p|\dk)(?=_|$)/.exec(k)?.[1] ?? null;
  const audio = k.includes('without_audio') ? 'without' : k.includes('with_audio') ? 'with' : null;
  return { unit, value, resolution, audio };
}

/** Short side in pixels for a resolution label. */
function shortSide(resolution: string): number | null {
  const r = resolution.toLowerCase();
  const p = /^(\d{3,4})p$/.exec(r);
  if (p?.[1]) return Number(p[1]);
  if (r === '4k') return 2160;
  if (r === '2k') return 1440;
  if (r === '1k') return 1024;
  return null;
}

/**
 * Video from `/videos/models` pricing SKUs. Picks the most specific SKU for the resolution and audio choice; when
 * the resolution is unknown, the most expensive matching SKU, and when the audio choice is unknown, the dearer of
 * with and without audio. Token-priced models (Seedance) use an area-preserving frame size: a 480p clip is about
 * 480 x 853 pixels whatever the aspect ratio (1:1 at 480p is 640 x 640).
 */
export function estimateVideo(
  model: RawVideoModel,
  input: { seconds: number; resolution?: string; withAudio?: boolean; images?: number },
): number | null {
  const skus = Object.entries(model.pricing_skus ?? {})
    .map(([key, value]) => parseSku(key, value))
    .filter((sku): sku is VideoSku => sku !== null);
  const wantRes = input.resolution?.toLowerCase();
  let cost: number | null;
  if (input.withAudio !== undefined) {
    cost = videoCost(model, skus, input.seconds, wantRes, input.withAudio ? 'with' : 'without');
  } else {
    const costs = (['with', 'without'] as const)
      .map((audio) => videoCost(model, skus, input.seconds, wantRes, audio))
      .filter((value): value is number => value !== null);
    cost = costs.length > 0 ? Math.max(...costs) : null;
  }
  return cost === null ? null : cost + imageInputCost(model, input.images ?? 0);
}

/**
 * Per-image input charge (`cents_per_image_input`, Grok: the recorded $0.052 is $0.05 for 1 s plus $0.002 for its
 * first frame). Other image surcharges (`reference_images`) have no documented unit and stay out.
 */
function imageInputCost(model: RawVideoModel, images: number): number {
  if (!(images > 0)) return 0;
  const raw = model.pricing_skus?.['cents_per_image_input'];
  const cents = raw === undefined ? null : priceNumber(raw);
  return cents === null ? 0 : (cents / 100) * images;
}

function videoCost(
  model: RawVideoModel,
  skus: VideoSku[],
  seconds: number,
  wantRes: string | undefined,
  wantAudio: 'with' | 'without',
): number | null {
  const applicable = skus.filter(
    (sku) =>
      sku.unit !== 'min-cents' &&
      (!wantRes || !sku.resolution || sku.resolution === wantRes) &&
      (!sku.audio || sku.audio === wantAudio),
  );
  if (applicable.length === 0) return null;
  const specificity = (sku: VideoSku): number =>
    (wantRes && sku.resolution === wantRes ? 1 : 0) + (sku.audio === wantAudio ? 1 : 0);
  const best = Math.max(...applicable.map(specificity));

  // Without a chosen resolution, assume the largest the model offers (1080p when it lists none).
  const sides = (model.supported_resolutions ?? [])
    .map((r) => shortSide(r) ?? 0)
    .filter((side) => side > 0);
  const maxSide = sides.length > 0 ? Math.max(...sides) : 1080;
  const costs = applicable
    .filter((sku) => specificity(sku) === best)
    .map((sku) => {
      if (sku.unit === 'usd-per-second') return sku.value * seconds;
      if (sku.unit === 'cents-per-second') return (sku.value / 100) * seconds;
      const side = shortSide(sku.resolution ?? wantRes ?? '') ?? maxSide;
      const tokens = ((side * side * 16) / 9) * seconds * (VIDEO_TOKEN_FRAMES / 1024);
      return sku.value * tokens;
    });
  let total = Math.max(...costs);
  const minimum = skus.find((sku) => sku.unit === 'min-cents');
  if (minimum) total = Math.max(total, minimum.value / 100);
  return total;
}
