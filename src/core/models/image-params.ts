/**
 * What an image model takes, read from its `supported_parameters` in `GET /images/models` (docs/openrouter-api.md
 * §3.2): each key is a request field, its value a descriptor (`{type:'enum', values}`, `{type:'range', min,
 * max}` or `{type:'boolean'}`); a missing key means the field is not supported, and sending it is a 400 from
 * the provider. The image tools build their forms and requests from `imageModelControls()`.
 */
import type { RawImageModel } from '../api/types';
import { isFiniteNumber, isRecord } from '../util';

export interface Range {
  min: number;
  max: number;
}

/** What a form may offer for one model. null: the field is not supported (never send it). */
export interface ImageModelControls {
  id: string;
  name: string;
  aspectRatios: string[] | null;
  resolutions: string[] | null;
  /** Explicit `WIDTHxHEIGHT` sizes: a list, `true` for any size, null when unsupported. */
  sizes: string[] | true | null;
  qualities: string[] | null;
  outputFormats: string[] | null;
  backgrounds: string[] | null;
  seed: boolean;
  /** Images per request; null: one per request (the field is not sent). */
  n: Range | null;
  /** Reference images (`input_references`); null: none can be sent. `min >= 1`: the model needs them. */
  references: Range | null;
  /** Streams partial images (OpenAI models). */
  streaming: boolean;
}

function enumValues(descriptor: unknown): string[] | null {
  if (!isRecord(descriptor) || descriptor['type'] !== 'enum') return null;
  const values = descriptor['values'];
  if (!Array.isArray(values)) return null;
  const strings = values.filter((value): value is string => typeof value === 'string' && !!value);
  return strings.length > 0 ? strings : null;
}

function range(descriptor: unknown): Range | null {
  if (!isRecord(descriptor) || descriptor['type'] !== 'range') return null;
  const { min, max } = descriptor;
  if (!isFiniteNumber(min) || !isFiniteNumber(max) || max < min || max < 0) return null;
  return { min: Math.max(0, Math.ceil(min)), max: Math.floor(max) };
}

/** True when the descriptor says the field is supported in any form. */
const supported = (descriptor: unknown): boolean =>
  isRecord(descriptor) && typeof descriptor['type'] === 'string';

export function imageModelControls(model: RawImageModel): ImageModelControls {
  const params = isRecord(model.supported_parameters) ? model.supported_parameters : {};
  const n = range(params['n']);
  return {
    id: model.id,
    name: model.name || model.id,
    aspectRatios: enumValues(params['aspect_ratio']),
    resolutions: enumValues(params['resolution']),
    sizes: enumValues(params['size']) ?? (supported(params['size']) ? true : null),
    qualities: enumValues(params['quality']),
    outputFormats: enumValues(params['output_format']),
    backgrounds: enumValues(params['background']),
    seed: supported(params['seed']),
    n: n && n.max >= 1 ? { min: Math.max(1, n.min), max: n.max } : null,
    references: range(params['input_references']),
    streaming: model.supports_streaming === true,
  };
}

/**
 * Controls for a model when `GET /images/models` could not be read (offline, an outage): nothing beyond the
 * prompt is sent, so a request cannot fail on a field the model does not take.
 */
export function bareImageControls(id: string): ImageModelControls {
  return {
    id,
    name: id,
    aspectRatios: null,
    resolutions: null,
    sizes: null,
    qualities: null,
    outputFormats: null,
    backgrounds: null,
    seed: false,
    n: null,
    references: null,
    streaming: false,
  };
}

/** `16:9` → 16/9 (`2.35:1` works); null for `auto` or anything else. */
export function aspectValue(aspect: string): number | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (!match) return null;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * The offered aspect ratio closest to `width` x `height` (compared on a log scale, so 2:1 and 1:2 are equally
 * far from 1:1), or null when none is a ratio. For edits, so the model answers in the picture's own shape.
 */
export function closestAspect(
  width: number,
  height: number,
  values: readonly string[] | null,
): string | null {
  if (!values || width <= 0 || height <= 0) return null;
  const target = Math.log(width / height);
  let best: { value: string; distance: number } | null = null;
  for (const value of values) {
    const ratio = aspectValue(value);
    if (ratio === null) continue;
    const distance = Math.abs(Math.log(ratio) - target);
    if (!best || distance < best.distance) best = { value, distance };
  }
  return best?.value ?? null;
}
