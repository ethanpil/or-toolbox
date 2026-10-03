/**
 * What a model costs, in the unit it is really billed in, from one place: the model picker, the tool header chip,
 * Settings and the Models page all show (and the Models page sorts and filters by) the same facts.
 *
 * The catalog's `pricing` has no unit field: `prompt` and `completion` are per token only for text-like models and
 * mean something else for speech, transcription, video and music (docs/openrouter-api.md §4.3, §5.4, §6.3, §7.5),
 * and images are billed per output image token. The rules below follow the same heuristics as the cost estimates
 * in src/core/models/estimate.ts; they decide the unit, and the real cost always arrives later as `usage.cost`.
 *
 * Pure and free of formatting: `describePrice` takes the money formatter, so src/ui/format.ts can delegate here
 * without an import cycle.
 */
import { estimateMusic } from '../core/models/estimate';
import { priceNumber } from '../core/models/normalize';
import type { ModelInfo } from '../core/types';

/** Only what pricing needs; `capabilities`, `outputModalities`, `id` and `description` sharpen the unit. */
export type PriceModel = Pick<ModelInfo, 'isFree' | 'pricing'> &
  Partial<Pick<ModelInfo, 'id' | 'description' | 'capabilities' | 'outputModalities'>>;

export type PriceUnit =
  | 'image'
  | 'character'
  | 'byte'
  | 'audio-hour'
  | 'speech-second'
  | 'clip'
  | 'request'
  | 'input-image';

/** A second price line of a token-priced model: its audio tokens, or the images it can draw. */
export type ExtraPrice =
  | { type: 'audio'; inputPerM: number; outputPerM: number | null }
  | { type: 'image'; perImage: number };

export type ModelPrice =
  | { kind: 'free' }
  /** USD per 1M tokens. */
  | { kind: 'tokens'; inputPerM: number; outputPerM: number; extras: ExtraPrice[] }
  /** USD per `unit` (per 1M for characters and bytes). */
  | { kind: 'unit'; unit: PriceUnit; amount: number }
  /** No single number: the price depends on the request (video) or is unknown (routers). */
  | { kind: 'varies'; note: string };

/** Micro-dollars: every amount is rounded to 1e-6 USD, so 0.1 + 0.2 and 0.0000001 * 1e6 compare as expected. */
export const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;
const perMillion = (usdPerUnit: number): number => roundUsd(usdPerUnit * 1_000_000);

/** Tokens of a 1 MP image: a flat 4175 for per-image models (estimate.ts MIN_IMAGE_TOKENS), 4096 per megapixel. */
const TOKENS_PER_IMAGE = 4175;
/** A speech `completion` price at or above this is per second of output (Seed Audio), not per audio token. */
const PER_SECOND_COMPLETION = 0.0005;
/** A transcription `prompt` price at or above this is per hour (MAI Transcribe); below it, per second. */
const PER_HOUR_PROMPT = 0.01;
const SECONDS_PER_HOUR = 3600;
/** Providers that bill speech input per UTF-8 byte rather than per character (docs §4.3). */
const BYTE_PRICED = /^fish-audio\//;

const VARIES = (note: string): ModelPrice => ({ kind: 'varies', note });

export function modelPrice(model: PriceModel): ModelPrice {
  if (model.isFree) return { kind: 'free' };
  const raw = model.pricing.raw;
  const outputs = model.outputModalities ?? [];
  const capabilities = model.capabilities ?? [];
  const id = model.id ?? '';

  // `pricing.prompt`/`completion` are null for speech, transcription, video and music, so read the raw strings
  // first and fall back to the normalized numbers (the catalog's `request` and per-input-image `image`).
  const number = (key: 'prompt' | 'completion' | 'request' | 'image'): number | null =>
    priceNumber(raw[key]) ?? model.pricing[key];
  const prompt = number('prompt');
  const completion = number('completion');

  if (outputs.includes('speech') || capabilities.includes('tts')) {
    const p = prompt ?? 0;
    const c = completion ?? 0;
    if (c >= PER_SECOND_COMPLETION)
      return { kind: 'unit', unit: 'speech-second', amount: roundUsd(c) };
    if (c > 0) return tokens(p, c, []);
    if (p > 0) {
      return {
        kind: 'unit',
        unit: BYTE_PRICED.test(id) ? 'byte' : 'character',
        amount: perMillion(p),
      };
    }
    return VARIES('Price varies');
  }

  if (outputs.includes('transcription') || capabilities.includes('stt')) {
    const p = prompt ?? 0;
    const c = completion ?? 0;
    if (c > 0) return tokens(p, c, []);
    if (p >= PER_HOUR_PROMPT) return { kind: 'unit', unit: 'audio-hour', amount: roundUsd(p) };
    if (p > 0) return { kind: 'unit', unit: 'audio-hour', amount: roundUsd(p * SECONDS_PER_HOUR) };
    return VARIES('Price varies');
  }

  if (outputs.includes('video') || capabilities.includes('video')) {
    return VARIES('Billed per second of video');
  }

  if (capabilities.includes('music') || id.startsWith('google/lyria-')) {
    const flat = estimateMusic({ id, description: model.description ?? '' });
    return flat === null
      ? VARIES('Billed per song or clip')
      : { kind: 'unit', unit: 'clip', amount: roundUsd(flat) };
  }

  const image = priceNumber(raw['image_output']) ?? priceNumber(raw['image_token']);
  const perImage = image !== null && image > 0 ? roundUsd(image * TOKENS_PER_IMAGE) : null;

  if (prompt !== null && completion !== null && (prompt > 0 || completion > 0)) {
    const extras: ExtraPrice[] = [];
    const audioIn = priceNumber(raw['audio']);
    const audioOut = priceNumber(raw['audio_output']);
    if ((audioIn ?? 0) > 0 || (audioOut ?? 0) > 0) {
      extras.push({
        type: 'audio',
        inputPerM: perMillion(audioIn ?? 0),
        outputPerM: audioOut !== null && audioOut > 0 ? perMillion(audioOut) : null,
      });
    }
    if (perImage !== null) extras.push({ type: 'image', perImage });
    return tokens(prompt, completion, extras);
  }

  if (perImage !== null) return { kind: 'unit', unit: 'image', amount: perImage };
  const request = number('request');
  if (request !== null && request > 0)
    return { kind: 'unit', unit: 'request', amount: roundUsd(request) };
  const inputImage = number('image');
  if (inputImage !== null && inputImage > 0) {
    return { kind: 'unit', unit: 'input-image', amount: roundUsd(inputImage) };
  }
  return VARIES('Price varies');
}

function tokens(prompt: number, completion: number, extras: ExtraPrice[]): ModelPrice {
  return {
    kind: 'tokens',
    inputPerM: perMillion(prompt),
    outputPerM: perMillion(completion),
    extras,
  };
}

/** One line for the price, and further lines (audio tokens, image output) for places with room. */
export function describePrice(
  price: ModelPrice,
  usd: (amount: number) => string,
): { text: string; extras: string[] } {
  switch (price.kind) {
    case 'free':
      return { text: 'Free', extras: [] };
    case 'varies':
      return { text: price.note, extras: [] };
    case 'tokens':
      return {
        text: `${usd(price.inputPerM)} in · ${usd(price.outputPerM)} out per 1M tokens`,
        extras: price.extras.map((extra) =>
          extra.type === 'image'
            ? `Image output: ≈ ${usd(extra.perImage)} per image`
            : `Audio: ${usd(extra.inputPerM)} in${
                extra.outputPerM === null ? '' : ` · ${usd(extra.outputPerM)} out`
              } per 1M tokens`,
        ),
      };
    case 'unit': {
      const amount = usd(price.amount);
      const text: Record<PriceUnit, string> = {
        image: `≈ ${amount} per image`,
        character: `${amount} per 1M characters`,
        byte: `${amount} per 1M bytes of text`,
        'audio-hour': `${amount} per hour of audio`,
        'speech-second': `${amount} per second of speech`,
        clip: `${amount} per clip or song`,
        request: `${amount} per request`,
        'input-image': `${amount} per input image`,
      };
      return { text: text[price.unit], extras: [] };
    }
  }
}

const UNIT_GROUP: Record<PriceUnit, number> = {
  image: 2,
  character: 3,
  byte: 4,
  'audio-hour': 5,
  'speech-second': 6,
  clip: 7,
  request: 8,
  'input-image': 9,
};

/**
 * A price that can be sorted and filtered: `group` is the unit (free 0, tokens 1, then one group per other unit)
 * and `amount` is in that unit, so prices are only ever compared with prices of the same kind (input plus output
 * per 1M tokens for the token group). Null when there is no number.
 */
export function comparablePrice(price: ModelPrice): { group: number; amount: number } | null {
  switch (price.kind) {
    case 'free':
      return { group: 0, amount: 0 };
    case 'tokens':
      return { group: 1, amount: roundUsd(price.inputPerM + price.outputPerM) };
    case 'unit':
      return { group: UNIT_GROUP[price.unit], amount: price.amount };
    case 'varies':
      return null;
  }
}
