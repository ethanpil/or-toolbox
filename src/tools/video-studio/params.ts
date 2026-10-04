/**
 * Video studio's form and request rules, free of DOM so they are unit-tested on their own.
 *
 * - **Controls** come from `GET /videos/models` (docs/openrouter-api.md §7.5): durations, resolutions, aspect
 *   ratios, sizes, which frames a model takes, the audio flag and the seed flag. One policy, like the image
 *   tools: `ready` (listed), `missing` (the list was read and the model is not a generator in it: refuse before
 *   the run), `unknown` (the list could not be read: send the prompt and images only and let the request try).
 * - **The form keeps what the user asked for** and `effectiveFormat()` turns it into what the current model
 *   takes: a duration it does not offer becomes the nearest one, a resolution the cheapest offered, an aspect
 *   ratio 16:9 or the first offered, each with a note; a model switch loses no choice.
 * - **Frames win over references** (§7.2: with both, `frame_images` wins and the request is image-to-video), so a
 *   request never carries both: `buildVideoRequest()` drops the references and says so.
 * - **Native extend** sends the source as a `video_url` reference, which must be a public `https://` link
 *   (§0: `data:` video is refused). Models take one only when their SKUs are priced "with video input"
 *   (Seedance). `previous_job_id` is rejected by grok and Seedance mini and no model is confirmed to accept it,
 *   so `PREVIOUS_JOB_MODELS` is empty: generated clips are lengthened by Continue from last frame instead.
 */
import type { RawVideoModel, VideoReference, VideoRequest } from '../../core/api/types';
import { isString } from '../../core/util';
import { type ClipFormat, DEFAULT_FORMAT, parseFormat } from './format';
import { DEFAULT_SEQUENCE, parseSequenceSpec, type SequenceSpec } from './sequence';

/** Reference images per request. The catalog lists no limit for video; Seedance takes far more, grok several. */
export const VIDEO_REFERENCE_MAX = 4;
/**
 * Models known to accept `previous_job_id` (continuation of a completed job on the same model). None is
 * confirmed: grok-imagine-video and seedance-2.0-mini answer 400 "does not support previous_job_id" (§7.2), and
 * FLUX.3 Video, the likely one, was never probed. Add a model here once a request proves it.
 */
export const PREVIOUS_JOB_MODELS: ReadonlySet<string> = new Set<string>();
/**
 * Models known to make a clip from a last frame alone (no first frame). None is confirmed; the one-clip form has
 * no such mode either, so a sequence step that would send only a last frame is refused until a probe proves one.
 */
export const LAST_FRAME_ONLY_MODELS: ReadonlySet<string> = new Set<string>();
/** What Continue sends when the prompt is left empty. */
export const CONTINUE_PROMPT =
  'Continue the shot smoothly from this frame, keeping the same scene, subject, style and motion.';

export type ClipMode = 'text' | 'first' | 'first-last' | 'references' | 'continue' | 'extend';
export const CLIP_MODES: readonly ClipMode[] = [
  'text',
  'first',
  'first-last',
  'references',
  'continue',
  'extend',
];
export const MODE_LABELS: Record<ClipMode, string> = {
  text: 'Text only',
  first: 'First frame',
  'first-last': 'First and last frame',
  references: 'Reference images',
  continue: 'Continue a clip (from its last frame)',
  extend: 'Extend a clip (native, supported models)',
};

export type StudioTab = 'clip' | 'sequence';

/** Everything `getState().settings` holds: JSON-safe, round-trips exactly. */
export interface StudioSettings {
  tab: StudioTab;
  mode: ClipMode;
  format: ClipFormat;
  /** The public HTTPS link native extend sends. */
  extendUrl: string;
  sequence: SequenceSpec;
}

export const DEFAULT_SETTINGS: StudioSettings = {
  tab: 'clip',
  mode: 'text',
  format: DEFAULT_FORMAT,
  extendUrl: '',
  sequence: DEFAULT_SEQUENCE,
};

export interface VideoControls {
  id: string;
  name: string;
  durations: number[] | null;
  resolutions: string[] | null;
  aspectRatios: string[] | null;
  sizes: string[] | null;
  firstFrame: boolean;
  lastFrame: boolean;
  /** `generate_audio`: true makes sound (can be turned off), false is silent, null not listed (never sent). */
  audio: boolean | null;
  seed: boolean;
  /** Takes a video as an `input_references` entry (native extend). */
  videoInput: boolean;
  /** Accepts `previous_job_id` (see `PREVIOUS_JOB_MODELS`). */
  previousJob: boolean;
}

export type ControlsResult =
  { status: 'ready'; controls: VideoControls } | { status: 'unknown' } | { status: 'missing' };

const nonEmpty = <T>(values: readonly T[] | null | undefined): T[] | null =>
  values && values.length > 0 ? [...values] : null;

/** What a `/videos/models` entry offers. */
export function videoControls(raw: RawVideoModel): VideoControls {
  const frames = raw.supported_frame_images ?? [];
  const skus = Object.keys(raw.pricing_skus ?? {});
  return {
    id: raw.id,
    name: raw.name?.trim() || raw.id,
    durations: nonEmpty(
      (raw.supported_durations ?? [])
        .filter((d) => Number.isInteger(d) && d > 0)
        .sort((a, b) => a - b),
    ),
    resolutions: nonEmpty(raw.supported_resolutions),
    aspectRatios: nonEmpty(raw.supported_aspect_ratios),
    sizes: nonEmpty(raw.supported_sizes),
    firstFrame: frames.includes('first_frame'),
    lastFrame: frames.includes('last_frame'),
    audio: typeof raw.generate_audio === 'boolean' ? raw.generate_audio : null,
    seed: raw.seed === true,
    videoInput: skus.some((sku) => /with_video_input/.test(sku)),
    previousJob: PREVIOUS_JOB_MODELS.has(raw.id),
  };
}

/**
 * The model's controls from the list: `null` list = it could not be read (`unknown`). Editors and upscalers have
 * no durations and cannot generate from a prompt, so they count as `missing`.
 */
export function controlsFor(list: readonly RawVideoModel[] | null, id: string): ControlsResult {
  if (list === null || list.length === 0) return { status: 'unknown' };
  const raw = list.find((entry) => entry.id === id);
  if (!raw || !raw.supported_durations || raw.supported_durations.length === 0) {
    return { status: 'missing' };
  }
  return { status: 'ready', controls: videoControls(raw) };
}

// --- resolutions ------------------------------------------------------------------------------------------

/** Short side in pixels of a resolution label, for ordering (`480p` → 480, `2K` → 1440). */
export function resolutionRank(resolution: string): number {
  const r = resolution.toLowerCase();
  const p = /^(\d{3,4})p$/.exec(r);
  if (p?.[1]) return Number(p[1]);
  if (r === '4k') return 2160;
  if (r === '2k') return 1440;
  if (r === '1k') return 1024;
  return Number.MAX_SAFE_INTEGER;
}

const cheapest = (values: readonly string[]): string =>
  [...values].sort((a, b) => resolutionRank(a) - resolutionRank(b))[0]!;

/** The offered duration nearest to `wanted` (the shorter one on a tie). */
export function nearestDuration(durations: readonly number[], wanted: number): number {
  let best = durations[0]!;
  for (const value of durations) {
    const gap = Math.abs(value - wanted);
    const bestGap = Math.abs(best - wanted);
    if (gap < bestGap || (gap === bestGap && value < best)) best = value;
  }
  return best;
}

// --- effective values -------------------------------------------------------------------------------------

export interface EffectiveFormat {
  /** Seconds sent (and estimated); null when the model's durations are unknown (not sent). */
  duration: number | null;
  resolution: string | null;
  aspectRatio: string | null;
  size: string | null;
  /** `generate_audio` to send, or null to leave the model's default. */
  generateAudio: boolean | null;
  /** For the estimate: true/false when known, null when the model does not say. */
  withAudio: boolean | null;
  seed: number | null;
  notes: string[];
}

/** What the current model takes of the form, with a note for each substitution. */
export function effectiveFormat(
  format: ClipFormat,
  controls: VideoControls | null,
): EffectiveFormat {
  const notes: string[] = [];
  if (!controls) {
    return {
      duration: null,
      resolution: null,
      aspectRatio: null,
      size: null,
      generateAudio: null,
      withAudio: null,
      seed: null,
      notes,
    };
  }
  let duration: number | null = null;
  if (controls.durations) {
    duration = nearestDuration(controls.durations, format.duration);
    if (duration !== format.duration) {
      notes.push(`${format.duration} s is not offered by ${controls.name}: ${duration} s is used.`);
    }
  }
  const sized = format.size && controls.sizes?.includes(format.size) ? format.size : null;
  if (format.size && !sized) {
    notes.push(
      `${format.size} is not offered by ${controls.name}: the resolution and shape are used.`,
    );
  }
  let resolution: string | null = null;
  let aspectRatio: string | null = null;
  if (!sized) {
    if (controls.resolutions) {
      resolution =
        format.resolution && controls.resolutions.includes(format.resolution)
          ? format.resolution
          : cheapest(controls.resolutions);
      if (format.resolution && resolution !== format.resolution) {
        notes.push(
          `${format.resolution} is not offered by ${controls.name}: ${resolution} is used.`,
        );
      }
    }
    if (controls.aspectRatios) {
      aspectRatio = controls.aspectRatios.includes(format.aspectRatio)
        ? format.aspectRatio
        : controls.aspectRatios.includes('16:9')
          ? '16:9'
          : controls.aspectRatios[0]!;
      if (aspectRatio !== format.aspectRatio) {
        notes.push(
          `${format.aspectRatio} is not offered by ${controls.name}: ${aspectRatio} is used.`,
        );
      }
    }
  }
  let generateAudio: boolean | null = null;
  let withAudio: boolean | null = null;
  if (controls.audio === true) {
    generateAudio = format.audio === 'model' ? null : format.audio === 'on';
    withAudio = format.audio !== 'off';
  } else if (controls.audio === false) {
    withAudio = false;
    if (format.audio === 'on') notes.push(`${controls.name} makes silent video.`);
  }
  return {
    duration,
    resolution,
    aspectRatio,
    size: sized,
    generateAudio,
    withAudio,
    seed: controls.seed ? format.seed : null,
    notes,
  };
}

// --- requests ---------------------------------------------------------------------------------------------

export interface RequestInput {
  model: string;
  prompt: string;
  format: ClipFormat;
  /** null: the model's options could not be read (only the prompt and images are sent). */
  controls: VideoControls | null;
  firstFrame?: string | null;
  lastFrame?: string | null;
  /** Image `data:` URLs. */
  references?: readonly string[];
  /** A public HTTPS video link (native extend). */
  videoUrl?: string | null;
  previousJobId?: string | null;
}

export interface BuiltRequest {
  body: VideoRequest;
  notes: string[];
  /** Images in the request (frames and references), for per-image charges. */
  images: number;
}

/** The `POST /videos` body for a form and its inputs. Frames and references never travel together. */
export function buildVideoRequest(input: RequestInput): BuiltRequest {
  const value = effectiveFormat(input.format, input.controls);
  const notes = [...value.notes];
  const body: VideoRequest = { model: input.model };
  const prompt = input.prompt.trim();
  if (prompt) body.prompt = prompt;
  if (value.duration !== null) body.duration = value.duration;
  if (value.size) body.size = value.size;
  else {
    if (value.resolution) body.resolution = value.resolution;
    if (value.aspectRatio) body.aspect_ratio = value.aspectRatio;
  }
  if (value.generateAudio !== null) body.generate_audio = value.generateAudio;
  if (value.seed !== null) body.seed = value.seed;

  const frames: NonNullable<VideoRequest['frame_images']> = [];
  if (input.firstFrame) {
    frames.push({
      type: 'image_url',
      image_url: { url: input.firstFrame },
      frame_type: 'first_frame',
    });
  }
  if (input.lastFrame) {
    frames.push({
      type: 'image_url',
      image_url: { url: input.lastFrame },
      frame_type: 'last_frame',
    });
  }
  const references: VideoReference[] = [];
  if (frames.length > 0) {
    body.frame_images = frames;
    if (input.references && input.references.length > 0) {
      notes.push('Reference images are not sent with frames: frames take precedence.');
    }
  } else {
    for (const url of (input.references ?? []).slice(0, VIDEO_REFERENCE_MAX)) {
      references.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (input.videoUrl) references.push({ type: 'video_url', video_url: { url: input.videoUrl } });
  if (references.length > 0) body.input_references = references;
  if (input.previousJobId) body.previous_job_id = input.previousJobId;
  const images = frames.length + references.filter((ref) => ref.type === 'image_url').length;
  return { body, notes, images };
}

// --- mode rules -------------------------------------------------------------------------------------------

/** Whether a link may be sent as a video reference: a public `https://` URL. */
export function isPublicHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'https:' && url.hostname.includes('.');
  } catch {
    return false;
  }
}

/** A generated clip's OpenRouter job, for `previous_job_id`. */
export interface SourceJob {
  remoteId: string | null;
  model: string | null;
}

export interface ModeInputs {
  prompt: string;
  firstFrame: boolean;
  lastFrame: boolean;
  references: number;
  /** A source clip whose video this page has or can download (Continue, or Extend falling back to it). */
  source: boolean;
  sourceJob?: SourceJob | null;
  extendUrl: string;
}

/**
 * How Extend runs: the footage itself as a public HTTPS `video_url` reference (models priced "with video
 * input"), `previous_job_id` for a clip this model generated (models in `PREVIOUS_JOB_MODELS`), or else Continue
 * from the last frame, which every image-to-video model can do.
 */
export type ExtendPlan = 'native' | 'previous-job' | 'continue';

export function extendPlan(
  controls: VideoControls | null,
  extendUrl: string,
  sourceJob?: SourceJob | null,
): ExtendPlan {
  if (controls?.videoInput && isPublicHttpsUrl(extendUrl)) return 'native';
  if (controls?.previousJob && sourceJob?.remoteId && sourceJob.model === controls.id) {
    return 'previous-job';
  }
  return 'continue';
}

/** What Extend will do, in a sentence for the form. */
export function extendNote(
  plan: ExtendPlan,
  controls: VideoControls | null,
  extendUrl: string,
): string {
  const name = controls?.name ?? 'This model';
  if (plan === 'native')
    return 'Native extend: the link is sent as a video reference, so the model continues the footage itself.';
  if (plan === 'previous-job')
    return `Native extend: ${name} continues its own job on OpenRouter (previous_job_id).`;
  if (controls && !controls.videoInput) {
    return `${name} cannot extend a video natively, so the clip is continued from its last frame instead.`;
  }
  return extendUrl.trim()
    ? 'That is not a public https:// link, so the clip is continued from its last frame instead.'
    : 'Without a public https:// link (an uploaded or generated clip cannot be sent as video), the clip is continued from its last frame instead.';
}

/** Why a single clip cannot be made with these inputs, or null. Checked before anything is sent. */
export function modeProblem(
  mode: ClipMode,
  controls: VideoControls | null,
  inputs: ModeInputs,
): string | null {
  const name = controls?.name ?? 'This model';
  const plan = extendPlan(controls, inputs.extendUrl, inputs.sourceJob);
  const needsFirst =
    mode === 'first' ||
    mode === 'first-last' ||
    mode === 'continue' ||
    (mode === 'extend' && plan === 'continue');
  if (controls && needsFirst && !controls.firstFrame) {
    return mode === 'extend' || mode === 'continue'
      ? `${name} cannot start from an image, so it cannot continue a clip. Choose another model.`
      : `${name} cannot start from an image. Choose another model or "Text only".`;
  }
  if (mode === 'first-last' && controls && !controls.lastFrame) {
    return `${name} takes a first frame only. Choose "First frame" or a model that takes both.`;
  }
  switch (mode) {
    case 'text':
      return inputs.prompt.trim() ? null : 'Describe the video first.';
    case 'first':
      return inputs.firstFrame ? null : 'Add a first frame.';
    case 'first-last':
      if (!inputs.firstFrame) return 'Add a first frame.';
      return inputs.lastFrame ? null : 'Add a last frame.';
    case 'references':
      if (inputs.references === 0) return 'Add at least one reference image.';
      return inputs.prompt.trim() ? null : 'Describe the video first.';
    case 'continue':
      return inputs.source ? null : 'Choose or upload the clip to continue.';
    case 'extend':
      if (plan === 'native') return null;
      return inputs.source ? null : 'Choose or upload the clip to extend.';
  }
}

// --- settings (getState / applyState) ---------------------------------------------------------------------

const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

/** A stored or saved snapshot's settings, tolerant of older and foreign shapes. */
export function parseSettings(raw: Record<string, unknown>): StudioSettings {
  return {
    tab: oneOf(raw['tab'], ['clip', 'sequence'] as const, 'clip'),
    mode: oneOf(raw['mode'], CLIP_MODES, 'text'),
    format: parseFormat(raw['format']),
    extendUrl: isString(raw['extendUrl']) ? raw['extendUrl'] : '',
    sequence: parseSequenceSpec(raw['sequence']),
  };
}

/** The JSON form of the settings (what `parseSettings` reads back unchanged). */
export function settingsJson(settings: StudioSettings): Record<string, unknown> {
  return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
}
