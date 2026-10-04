/**
 * The Isolated image settings: their ranges, how a stored or restored value is read (anything invalid keeps the
 * current value), what the post-processing of one photo depends on, and the output file names.
 */
import { applyFilenamePattern } from '../../core/files';
import { isFiniteNumber } from '../../core/util';

export const OUTPUT_SIZES = [500, 1000, 1500, 2000, 2500, 3000] as const;
/** Longest side of the photo sent to the model; per-megapixel models bill the answer by its size. */
export const SEND_SIZES = [1024, 1536, 2048] as const;
export const CONCURRENCY = [1, 2, 3] as const;
export const OUTPUT_FORMATS = ['jpg', 'png'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** Margin as a fraction of the side; the forms show percent. */
export const MARGIN_RANGE = { min: 0, max: 0.3 } as const;
/** Every channel at or above this counts as background. */
export const THRESHOLD_RANGE = { min: 200, max: 255 } as const;
export const SHARPEN_RANGE = { min: 0.1, max: 2 } as const;
export const QUALITY_RANGE = { min: 50, max: 100 } as const;
const MAX_PATTERN_LENGTH = 120;

export interface IsolateSettings {
  /** Side of the square result in pixels. */
  size: number;
  /** Empty border on each side, as a fraction of `size`. */
  margin: number;
  whiteThreshold: number;
  sharpen: boolean;
  sharpenAmount: number;
  /** Ask the model to keep a soft shadow under the product. */
  shadow: boolean;
  format: OutputFormat;
  /** 50-100, for JPG. */
  jpegQuality: number;
  filenamePattern: string;
  sendSize: number;
  concurrency: number;
}

/** Used where neither the manifest nor the user says otherwise (the manifest repeats these). */
export const FALLBACK_SETTINGS: Readonly<IsolateSettings> = {
  size: 2000,
  margin: 0.08,
  whiteThreshold: 245,
  sharpen: true,
  sharpenAmount: 0.5,
  shadow: false,
  format: 'jpg',
  jpegQuality: 92,
  filenamePattern: '{name}-white.{ext}',
  sendSize: 1024,
  concurrency: 2,
};

const oneOf =
  <T>(list: readonly T[]) =>
  (value: unknown): value is T =>
    list.includes(value as T);
const within =
  (range: { min: number; max: number }, integer = false) =>
  (value: unknown): value is number =>
    isFiniteNumber(value) &&
    value >= range.min &&
    value <= range.max &&
    (!integer || Number.isInteger(value));
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isPattern = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= MAX_PATTERN_LENGTH;

const CHECKS: { [K in keyof IsolateSettings]: (value: unknown) => value is IsolateSettings[K] } = {
  size: oneOf<number>(OUTPUT_SIZES),
  margin: within(MARGIN_RANGE),
  whiteThreshold: within(THRESHOLD_RANGE, true),
  sharpen: isBoolean,
  sharpenAmount: within(SHARPEN_RANGE),
  shadow: isBoolean,
  format: oneOf<OutputFormat>(OUTPUT_FORMATS),
  jpegQuality: within(QUALITY_RANGE, true),
  filenamePattern: isPattern,
  sendSize: oneOf<number>(SEND_SIZES),
  concurrency: oneOf<number>(CONCURRENCY),
};

/**
 * `raw` read over `base`: each valid field of `raw` replaces `base`'s, anything missing, invalid or unknown is
 * ignored (stored options, saved prompts and History hold older or hand-edited snapshots).
 */
export function readSettings(
  raw: Record<string, unknown>,
  base: Readonly<IsolateSettings> = FALLBACK_SETTINGS,
): IsolateSettings {
  const next = { ...base };
  for (const key of Object.keys(CHECKS) as (keyof IsolateSettings)[]) {
    // Own fields only: an inherited `size` (a `__proto__` key in parsed JSON) is not the user's.
    const value = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (CHECKS[key](value)) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** One photo's own review choices; null follows the settings (for the threshold: automatic). */
export interface PhotoOverrides {
  margin: number | null;
  threshold: number | null;
}

/** What one photo's post-processing depends on: when it changes, the result is made again (no new request). */
export function processingKey(settings: IsolateSettings, photo: PhotoOverrides): string {
  return JSON.stringify([
    settings.size,
    photo.margin ?? settings.margin,
    photo.threshold ?? settings.whiteThreshold,
    photo.threshold === null,
    settings.sharpen ? settings.sharpenAmount : 0,
    settings.format,
    settings.format === 'jpg' ? settings.jpegQuality : 0,
  ]);
}

/** The pattern's extension placeholder is added when the pattern has none, so a file always gets its type. */
export function outputName(
  pattern: string,
  input: { fileName: string; n: number; format: OutputFormat; size: number },
): string {
  const stem = input.fileName.replace(/\.[^.]*$/, '').trim() || 'photo';
  const full = pattern.includes('{ext}') ? pattern : `${pattern}.{ext}`;
  return applyFilenamePattern(full, {
    name: stem,
    n: input.n,
    ext: input.format,
    size: input.size,
  });
}
