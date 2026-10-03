/**
 * Catalog entry → ModelInfo, and the capability rules (docs/openrouter-api.md §9.2 "Locating each kind"):
 * text = text output (Lyria excluded); vision = text output + image input; image = image output (the
 * `openrouter/*` routers excluded, `/images` does not serve them); tts = `speech`; stt = `transcription`;
 * video = `video`; music = audio output on a `google/lyria-` id; decisions = `decisions`.
 */

import type { RawModel } from '../api/types';
import type { Capability, ModelInfo, ModelPricing } from '../types';
import { isFreeModelId } from './free';

/** USD from a catalog price string. `"-1"` (routers), negatives, blanks and junk become null. */
export function priceNumber(value: unknown): number | null {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isMusicModelId(id: string): boolean {
  return id.startsWith('google/lyria-');
}

function outputs(raw: RawModel): string[] {
  return raw.architecture?.output_modalities ?? [];
}

function inputs(raw: RawModel): string[] {
  return raw.architecture?.input_modalities ?? [];
}

export function capabilitiesOf(raw: RawModel): Capability[] {
  const out = outputs(raw);
  const music = out.includes('audio') && isMusicModelId(raw.id);
  const caps: Capability[] = [];
  if (out.includes('text') && !music) {
    caps.push('text');
    if (inputs(raw).includes('image')) caps.push('vision');
  }
  if (out.includes('image') && !raw.id.startsWith('openrouter/')) caps.push('image');
  if (out.includes('speech')) caps.push('tts');
  if (out.includes('transcription')) caps.push('stt');
  if (out.includes('video')) caps.push('video');
  if (music) caps.push('music');
  if (out.includes('decisions')) caps.push('decisions');
  return caps;
}

/**
 * `prompt`/`completion` are per token only for token-billed models. For speech, transcription, video and music
 * the same fields hold per-character, per-second or meaningless "0" prices (§4.3, §5.4, §7.5, §6.3), so they are
 * null in ModelPricing and estimates read `pricing.raw` instead.
 */
function tokenPriced(raw: RawModel): boolean {
  const out = outputs(raw);
  return !(
    out.includes('speech') ||
    out.includes('transcription') ||
    out.includes('video') ||
    isMusicModelId(raw.id)
  );
}

export function normalizePricing(raw: RawModel): ModelPricing {
  const pricing = raw.pricing ?? {};
  const perToken = tokenPriced(raw);
  return {
    prompt: perToken ? priceNumber(pricing['prompt']) : null,
    completion: perToken ? priceNumber(pricing['completion']) : null,
    image: priceNumber(pricing['image']),
    request: priceNumber(pricing['request']),
    raw: pricing,
  };
}

export function normalizeModel(raw: RawModel): ModelInfo {
  const contextLength = raw.context_length ?? raw.top_provider?.context_length ?? null;
  const voices = raw.supported_voices;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    author: (raw.id.split('/')[0] ?? '').replace(/^~/, ''),
    description: raw.description ?? '',
    created: raw.created ?? 0,
    // `0` means "not applicable" on many media models.
    contextLength: contextLength && contextLength > 0 ? contextLength : null,
    maxCompletionTokens: raw.top_provider?.max_completion_tokens ?? null,
    inputModalities: inputs(raw),
    outputModalities: outputs(raw),
    supportedParameters: raw.supported_parameters ?? [],
    // `[]` appears on an STT model, so an empty list means "no voices" (§4.2).
    supportedVoices: Array.isArray(voices) && voices.length > 0 ? voices : null,
    pricing: normalizePricing(raw),
    isFree: isFreeModelId(raw.id),
    expirationDate: raw.expiration_date ?? null,
    capabilities: capabilitiesOf(raw),
    raw,
  };
}
