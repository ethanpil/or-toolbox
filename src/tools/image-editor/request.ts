/**
 * Edit requests for `POST /images`. There is no mask parameter (docs/openrouter-api.md §0, §3.3): a masked edit
 * is sent as reference images plus an instruction that names the marked area:
 *
 * 1. `marked`: the picture with the area to change tinted magenta (`maskOverlay`),
 * 2. `plain`: the same picture untouched,
 * 3. `mask`: the mask as a black-and-white PNG, white = change.
 *
 * Models with fewer reference slots get the first ones that fit (the marked picture matters most). The
 * instruction says exactly which reference is which. Models decide; pixels outside the mask may still change,
 * which "Keep outside the mask" undoes in the browser.
 */
import type { ImageRequest } from '../../core/api/types';
import { closestAspect, type ImageModelControls } from '../../core/models/image-params';
import { type Margins, MAX_MARGIN_PERCENT } from './outpaint';

export type EditMode = 'inpaint' | 'outpaint' | 'whole';
export type ReferenceRole = 'marked' | 'plain' | 'mask';

export const EDIT_MODES: readonly { id: EditMode; label: string; detail: string }[] = [
  { id: 'inpaint', label: 'Inpaint', detail: 'change what you paint' },
  { id: 'outpaint', label: 'Outpaint', detail: 'extend the picture outward' },
  { id: 'whole', label: 'Whole image', detail: 'no mask, an instruction only' },
];

/** The tint of the marked area in the reference and on the canvas. */
export const MASK_COLOUR = '#FF00FF';
export const MASK_ALPHA = 0.5;

export const isEditMode = (value: unknown): value is EditMode =>
  value === 'inpaint' || value === 'outpaint' || value === 'whole';

/** The references a mode sends, cut to the model's limit. */
export function referenceRoles(mode: EditMode, max: number): ReferenceRole[] {
  const roles: ReferenceRole[] = mode === 'whole' ? ['plain'] : ['marked', 'plain', 'mask'];
  return roles.slice(0, Math.max(0, max));
}

const ORDINALS = ['first', 'second', 'third'];

/** "The first reference image shows …; the second …". */
function describeReferences(roles: readonly ReferenceRole[], outpaint: boolean): string {
  const area = outpaint ? 'the empty area to fill' : 'the area to change';
  const parts = roles.map((role, index) => {
    const which = `the ${ORDINALS[index] ?? `${index + 1}th`} reference image`;
    switch (role) {
      case 'marked':
        return `${which} shows the picture with ${area} tinted magenta`;
      case 'plain':
        return `${which} is the same picture without any marks`;
      case 'mask':
        return `${which} is a black-and-white mask where white is ${area}`;
    }
  });
  const sentence = parts.join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
}

/** The prompt for an edit: what is where, what to change, and what to leave alone. */
export function editInstruction(
  mode: EditMode,
  instruction: string,
  roles: readonly ReferenceRole[],
): string {
  const text = instruction.trim();
  if (mode === 'whole') {
    return `Edit the reference image: ${text || 'improve it'}. Return the whole edited picture, same framing.`;
  }
  const marked = roles.includes('marked') || roles.includes('mask');
  const outpaint = mode === 'outpaint';
  const lines = [describeReferences(roles, outpaint)];
  if (outpaint) {
    lines.push(
      `The picture has been placed on a larger canvas. Fill the ${marked ? 'marked' : 'grey'} area by extending the scene naturally beyond its edges${text ? `: ${text}` : '.'}`,
      'Keep the original part of the picture exactly as it is, and match its lighting, perspective and style.',
    );
  } else {
    lines.push(
      `Change only the marked area: ${text}.`,
      'Keep everything outside the marked area exactly as it is in the unmarked picture.',
    );
  }
  lines.push(
    'Return one picture with the same framing and proportions, without any magenta tint, mask or other marks.',
  );
  return lines.join('\n');
}

/** The `/images` body for an edit. `references` are data URLs in the order of `roles`. */
export function buildEditRequest(input: {
  model: string;
  mode: EditMode;
  instruction: string;
  roles: readonly ReferenceRole[];
  references: readonly string[];
  controls: Pick<ImageModelControls, 'aspectRatios' | 'outputFormats'>;
  width: number;
  height: number;
}): ImageRequest {
  const body: ImageRequest = {
    model: input.model,
    prompt: editInstruction(input.mode, input.instruction, input.roles),
    input_references: input.references.map((url) => ({ type: 'image_url', image_url: { url } })),
  };
  // The result is composited onto the picture, so ask for its shape and for a lossless file when offered.
  const aspect = closestAspect(input.width, input.height, input.controls.aspectRatios);
  if (aspect) body.aspect_ratio = aspect;
  if (input.controls.outputFormats?.includes('png')) body.output_format = 'png';
  return body;
}

/** The editor's form (everything but the instruction), as Prompts and History keep it. */
export interface EditorSettings {
  mode: EditMode;
  keepOutside: boolean;
  /** Pixels of soft edge inside the mask when compositing. */
  feather: number;
  /** `margins` or an aspect ratio such as `16:9`. */
  extend: string;
  margins: Margins;
}

export const MAX_FEATHER = 32;

export const DEFAULT_SETTINGS: EditorSettings = {
  mode: 'inpaint',
  keepOutside: true,
  feather: 6,
  extend: 'margins',
  margins: { top: 0, right: 25, bottom: 0, left: 25 },
};

const percent = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_MARGIN_PERCENT
    ? value
    : fallback;

export function parseSettings(settings: Record<string, unknown>): EditorSettings {
  const margins =
    typeof settings['margins'] === 'object' && settings['margins'] !== null
      ? (settings['margins'] as Record<string, unknown>)
      : {};
  const feather = settings['feather'];
  const defaults = DEFAULT_SETTINGS.margins;
  return {
    mode: isEditMode(settings['mode']) ? settings['mode'] : DEFAULT_SETTINGS.mode,
    keepOutside:
      typeof settings['keepOutside'] === 'boolean'
        ? settings['keepOutside']
        : DEFAULT_SETTINGS.keepOutside,
    feather:
      typeof feather === 'number' &&
      Number.isInteger(feather) &&
      feather >= 0 &&
      feather <= MAX_FEATHER
        ? feather
        : DEFAULT_SETTINGS.feather,
    extend:
      typeof settings['extend'] === 'string' &&
      /^(margins|\d+(\.\d+)?:\d+(\.\d+)?)$/.test(settings['extend'])
        ? settings['extend']
        : DEFAULT_SETTINGS.extend,
    margins: {
      top: percent(margins['top'], defaults.top),
      right: percent(margins['right'], defaults.right),
      bottom: percent(margins['bottom'], defaults.bottom),
      left: percent(margins['left'], defaults.left),
    },
  };
}

export function settingsRecord(settings: EditorSettings): Record<string, unknown> {
  return {
    mode: settings.mode,
    keepOutside: settings.keepOutside,
    feather: settings.feather,
    extend: settings.extend,
    margins: { ...settings.margins },
  };
}
