/**
 * The edit request: the fixed instruction, and which `/images` parameters a model takes (its
 * `supported_parameters` from `GET /images/models`: an absent key is unsupported, and sending one makes routing
 * refuse the request; docs/openrouter-api.md §3.2).
 */
import type { ImageRequest, RawImageModel } from '../../core/api/types';
import { isFiniteNumber, isRecord } from '../../core/util';

/** The instruction every photo is sent with. `notes` is the user's optional line about this batch. */
export function buildInstruction(options: { shadow: boolean; notes: string }): string {
  const parts = [
    'Edit this product photo into a clean e-commerce packshot.',
    'Keep the product exactly as it is: the same shape, proportions, colours, materials, logos, labels and text.',
    'Do not redraw, restyle, crop or add anything to the product.',
    'Remove everything else (background, surface, props, hands, other objects) and place the product on a pure white background (#FFFFFF).',
    'Keep the whole product in view, with empty white space around it.',
    'Make it sharp and evenly lit, without strong reflections.',
    options.shadow
      ? 'Keep a soft, natural shadow directly under the product.'
      : 'No shadow, reflection or gradient: the background is flat pure white everywhere.',
  ];
  const notes = options.notes.trim();
  return notes ? `${parts.join(' ')}\n\nAbout these photos: ${notes}` : parts.join(' ');
}

/** Extra request fields a model takes, or why it cannot edit a photo at all. */
export type EditSupport =
  { ok: true; params: Pick<ImageRequest, 'n' | 'output_format'> } | { ok: false; reason: string };

function range(descriptor: unknown): { min: number; max: number } | null {
  if (!isRecord(descriptor) || descriptor['type'] !== 'range') return null;
  const { min, max } = descriptor;
  return isFiniteNumber(min) && isFiniteNumber(max) ? { min, max } : null;
}

function enumValues(descriptor: unknown): unknown[] {
  if (!isRecord(descriptor) || descriptor['type'] !== 'enum') return [];
  return Array.isArray(descriptor['values']) ? descriptor['values'] : [];
}

/**
 * Whether `model` can edit one photo, from the `/images` model list (`models`; undefined or empty when it
 * could not be read, and then the request is tried as it is). PNG is asked for where offered: a lossless
 * answer keeps JPEG noise out of the background the browser fills.
 */
export function editSupport(
  model: string,
  models: readonly RawImageModel[] | undefined,
): EditSupport {
  if (!models || models.length === 0) return { ok: true, params: {} };
  const entry = models.find((candidate) => candidate.id === model);
  if (!entry) {
    return {
      ok: false,
      reason: `${model} does not edit images through OpenRouter's image endpoint. Choose another model.`,
    };
  }
  const parameters = isRecord(entry.supported_parameters) ? entry.supported_parameters : {};
  const references = range(parameters['input_references']);
  if (!references || references.max < 1 || references.min > 1) {
    return {
      ok: false,
      reason: `${entry.name || model} cannot edit a photo (it takes no single reference image). Choose another model.`,
    };
  }
  const params: Pick<ImageRequest, 'n' | 'output_format'> = {};
  if ('n' in parameters) params.n = 1;
  if (enumValues(parameters['output_format']).includes('png')) params.output_format = 'png';
  return { ok: true, params };
}

export function buildRequest(
  model: string,
  instruction: string,
  photoDataUrl: string,
  params: Pick<ImageRequest, 'n' | 'output_format'>,
): ImageRequest {
  return {
    model,
    prompt: instruction,
    ...params,
    input_references: [{ type: 'image_url', image_url: { url: photoDataUrl } }],
  };
}
