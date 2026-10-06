/**
 * Image generation requests from a model's controls (`imageModelControls`, src/core/models/image-params.ts: the
 * model's `supported_parameters` from `GET /images/models`, docs/openrouter-api.md §3.2). A field the model does
 * not list is never sent (providers answer 400).
 *
 * The form keeps what the user asked for (`GenerationForm`); `buildRequests` sends only what the chosen model
 * takes, so switching models never loses a choice and never sends one the model refuses.
 */
import type { ImageRequest } from '../../core/api/types';
import { aspectValue, type ImageModelControls } from '../../core/models/image-params';

type ModelControls = ImageModelControls;

/** The user's choices, kept as asked (also what Prompts and History store). Empty strings: the model's default. */
export interface GenerationForm {
  prompt: string;
  /** Style notes and things to avoid are folded into the prompt (no model has a negative prompt field). */
  style: string;
  negative: string;
  aspectRatio: string;
  resolution: string;
  size: string;
  quality: string;
  outputFormat: string;
  transparent: boolean;
  /** The seed field; null when empty. */
  seed: number | null;
  /** Locked: every run uses this seed. Unlocked: each run draws a new one (shown in the field). */
  seedLocked: boolean;
  /** Images per Generate press. */
  count: number;
}

export const MAX_IMAGES = 4;
export const MAX_SEED = 2_147_483_647;

export const DEFAULT_FORM: GenerationForm = {
  prompt: '',
  style: '',
  negative: '',
  aspectRatio: '1:1',
  resolution: '',
  size: '',
  quality: '',
  outputFormat: '',
  transparent: false,
  seed: null,
  seedLocked: false,
  count: 1,
};

/** The prompt sent: the description, then the style notes and what to avoid. */
export function foldPrompt(form: Pick<GenerationForm, 'prompt' | 'style' | 'negative'>): string {
  return [
    form.prompt.trim(),
    form.style.trim() && `Style: ${form.style.trim()}`,
    form.negative.trim() && `Avoid: ${form.negative.trim()}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** An explicit size as `WIDTHxHEIGHT`, or null. */
export function parseSize(size: string): { width: number; height: number } | null {
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The long side in pixels for a resolution tier. */
function longSide(resolution: string | null): number {
  switch (resolution) {
    case '512':
      return 512;
    case '768':
      return 768;
    case '1.5K':
      return 1536;
    case '2K':
      return 2048;
    case '4K':
      return 4096;
    default:
      return 1024;
  }
}

/** What one request asks for, after dropping everything the model does not take. */
export interface Effective {
  aspectRatio: string | null;
  resolution: string | null;
  size: string | null;
  quality: string | null;
  outputFormat: string | null;
  background: string | null;
  /** Why a choice could not be honoured (shown under the form). */
  notes: string[];
}

/** Two sizes written as `WIDTHxHEIGHT` (spaces or × allowed) are the same pixels. */
const sameSize = (a: string, b: string): boolean => {
  const first = parseSize(a);
  const second = parseSize(b);
  return (
    first !== null &&
    second !== null &&
    first.width === second.width &&
    first.height === second.height
  );
};

const pick = (wanted: string, values: string[] | null): string | null =>
  wanted && values?.includes(wanted) ? wanted : null;

export function effective(form: GenerationForm, controls: ModelControls): Effective {
  const notes: string[] = [];
  const explicit = parseSize(form.size);
  const wanted = explicit ? `${explicit.width}x${explicit.height}` : null;
  let size: string | null = null;
  if (wanted) {
    // Listed sizes are compared as numbers: "1024 x 1024" is the listed 1024x1024.
    const sizes = controls.sizes;
    if (sizes === true || sizes?.some((entry) => sameSize(entry, wanted))) size = wanted;
    else if (sizes === null) {
      notes.push('This model takes no exact size, so the aspect ratio and resolution are used.');
    } else {
      notes.push(
        `${wanted} is not one of this model’s sizes (${sizes?.join(', ')}), so the aspect ratio and resolution are used.`,
      );
    }
  }
  let outputFormat = pick(form.outputFormat, controls.outputFormats);
  let background: string | null = null;
  if (form.transparent) {
    if (controls.backgrounds?.includes('transparent')) {
      background = 'transparent';
      // Transparency needs PNG or WebP (§3.2): one is always sent when the model lists it, never left to the
      // model's default (the order of the list says nothing about the default).
      if (outputFormat !== 'png' && outputFormat !== 'webp') {
        const lossless = ['png', 'webp'].find((format) => controls.outputFormats?.includes(format));
        if (lossless) outputFormat = lossless;
        else if (controls.outputFormats) {
          background = null;
          notes.push('This model makes JPEG only, which cannot be transparent.');
        } else {
          notes.push(
            'This model does not say which file format it makes; transparency needs PNG or WebP.',
          );
        }
      }
    } else notes.push('This model cannot make transparent backgrounds.');
  }
  return {
    // Explicit pixels are authoritative; a mismatched resolution or aspect ratio is a 400 (§3.2).
    aspectRatio: size ? null : pick(form.aspectRatio, controls.aspectRatios),
    resolution: size ? null : pick(form.resolution, controls.resolutions),
    size,
    quality: pick(form.quality, controls.qualities),
    outputFormat,
    background,
    notes,
  };
}

/**
 * How `count` images are asked for: one request with `n` when the model takes that many, else requests of at
 * most `n.max` each (one image each, without `n`, when the model makes one at a time).
 */
export function planRequests(count: number, controls: Pick<ModelControls, 'n'>): number[] {
  const total = Math.max(1, Math.min(MAX_IMAGES, Math.floor(count)));
  const per = controls.n && controls.n.max > 1 ? controls.n.max : 1;
  const plan: number[] = [];
  for (let left = total; left > 0; left -= per) plan.push(Math.min(per, left));
  return plan;
}

/** Approximate output size, for per-megapixel estimates (the long side from the tier, the shape from the ratio). */
export function approxDimensions(value: Effective): { width: number; height: number } {
  const explicit = value.size ? parseSize(value.size) : null;
  if (explicit) return explicit;
  const side = longSide(value.resolution);
  const ratio = (value.aspectRatio ? aspectValue(value.aspectRatio) : null) ?? 1;
  return ratio >= 1
    ? { width: side, height: Math.round(side / ratio) }
    : { width: Math.round(side * ratio), height: side };
}

export interface RequestPlan {
  body: ImageRequest;
  /** Images this request asks for. */
  images: number;
}

/**
 * The requests for one Generate press. `seed` is the run's seed (null: none); with several requests each gets
 * `seed + i`, or a locked seed would make the same picture every time.
 */
export function buildRequests(input: {
  model: string;
  form: GenerationForm;
  controls: ModelControls;
  references: readonly string[];
  seed: number | null;
}): RequestPlan[] {
  const { model, form, controls, references, seed } = input;
  const value = effective(form, controls);
  const prompt = foldPrompt(form);
  const sendable = controls.references ? references.slice(0, controls.references.max) : [];
  return planRequests(form.count, controls).map((images, index) => {
    const body: ImageRequest = { model, prompt };
    if (controls.n && images > 1) body.n = images;
    if (value.aspectRatio) body.aspect_ratio = value.aspectRatio;
    if (value.resolution) body.resolution = value.resolution;
    if (value.size) body.size = value.size;
    if (value.quality) body.quality = value.quality;
    if (value.outputFormat)
      body.output_format = value.outputFormat as ImageRequest['output_format'];
    if (value.background) body.background = value.background as ImageRequest['background'];
    if (controls.seed && seed !== null) body.seed = (seed + index) % (MAX_SEED + 1);
    if (controls.streaming) body.stream = true;
    if (sendable.length > 0) {
      body.input_references = sendable.map((url) => ({ type: 'image_url', image_url: { url } }));
    }
    return { body, images };
  });
}

/** Reads a stored form: unknown or invalid fields fall back to the defaults. */
export function parseForm(prompt: string, settings: Record<string, unknown>): GenerationForm {
  const text = (
    key: 'style' | 'negative' | 'aspectRatio' | 'resolution' | 'size' | 'quality' | 'outputFormat',
  ): string => {
    const value = settings[key];
    return typeof value === 'string' ? value : DEFAULT_FORM[key];
  };
  const seed = settings['seed'];
  const count = settings['count'];
  const validSeed =
    typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED
      ? seed
      : null;
  return {
    prompt,
    style: text('style'),
    negative: text('negative'),
    aspectRatio: text('aspectRatio'),
    resolution: text('resolution'),
    size: text('size'),
    quality: text('quality'),
    outputFormat: text('outputFormat'),
    transparent: settings['transparent'] === true,
    seed: validSeed,
    // A lock always has a seed: a locked run sends exactly that seed.
    seedLocked: settings['seedLocked'] === true && validSeed !== null,
    count:
      typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= MAX_IMAGES
        ? count
        : 1,
  };
}

/** The form without its prompt: the `settings` of a snapshot. */
export function formSettings(form: GenerationForm): Record<string, unknown> {
  return {
    style: form.style,
    negative: form.negative,
    aspectRatio: form.aspectRatio,
    resolution: form.resolution,
    size: form.size,
    quality: form.quality,
    outputFormat: form.outputFormat,
    transparent: form.transparent,
    seed: form.seed,
    seedLocked: form.seedLocked,
    count: form.count,
  };
}

/**
 * The settings a run records (History, Recent prompts): the form with the seed the run used, locked, so
 * reopening the run reproduces its pictures. Without a seed (the model takes none) the form as asked.
 */
export function runSettings(form: GenerationForm, seed: number | null): Record<string, unknown> {
  return seed === null ? formSettings(form) : formSettings({ ...form, seed, seedLocked: true });
}
