/**
 * The edit request: the fixed instruction, and which `/images` fields a model takes, from
 * `ctx.models.imageControls(model)` (the one policy every image tool follows; docs/tool-authoring.md, "Image
 * models").
 */
import type { ImageRequest } from '../../core/api/types';
import type { ImageControlsResult } from '../../core/types';

/** The instruction every photo is sent with. It is fixed: the tool takes no notes that could weaken it. */
export function buildInstruction(options: { shadow: boolean }): string {
  return [
    'Edit this product photo into a clean e-commerce packshot.',
    'Keep the product exactly as it is: the same shape, proportions, colours, materials, logos, labels and text.',
    'Do not redraw, restyle, crop or add anything to the product.',
    'Remove everything else (background, surface, props, hands, other objects) and place the product on a pure white background (#FFFFFF).',
    'Keep the whole product in view, with empty white space around it.',
    'Make it sharp and evenly lit, without strong reflections.',
    options.shadow
      ? 'Keep a soft, natural shadow directly under the product.'
      : 'No shadow, reflection or gradient: the background is flat pure white everywhere.',
  ].join(' ');
}

/** Extra request fields a model takes, or why it cannot edit a photo at all. */
export type EditSupport =
  { ok: true; params: Pick<ImageRequest, 'n' | 'output_format'> } | { ok: false; reason: string };

/**
 * Whether `model` can edit one photo. `missing` (the image list was read and lacks it) and a model that takes no
 * single reference image are refused before the run. `unknown` (the list could not be read) tries the request
 * with the photo and the instruction only, nothing else. PNG is asked for where offered: a lossless answer keeps
 * JPEG noise out of the background the browser fills.
 */
export function editSupport(model: string, found: ImageControlsResult): EditSupport {
  if (found.status === 'missing') {
    return {
      ok: false,
      reason: `${model} does not edit images through OpenRouter's image endpoint. Choose another model.`,
    };
  }
  if (found.status === 'unknown') return { ok: true, params: {} };
  const { controls } = found;
  if (!controls.references || controls.references.max < 1 || controls.references.min > 1) {
    return {
      ok: false,
      reason: `${controls.name} cannot edit a photo (it takes no single reference image). Choose another model.`,
    };
  }
  return {
    ok: true,
    params: {
      ...(controls.n ? { n: 1 } : {}),
      ...(controls.outputFormats?.includes('png') ? { output_format: 'png' as const } : {}),
    },
  };
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
