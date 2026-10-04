/**
 * The size and sound of every clip (duration, resolution, aspect ratio, exact size, audio, seed), shared by single
 * clips and sequences. What the user asked for; `effectiveFormat()` in params.ts says what a model takes of it.
 */
import { isFiniteNumber, isRecord, isString } from '../../core/util';

export type AudioChoice = 'model' | 'on' | 'off';

export interface ClipFormat {
  /** Seconds. */
  duration: number;
  /** null: the cheapest the model offers. */
  resolution: string | null;
  aspectRatio: string;
  /** `WIDTHxHEIGHT`, replacing resolution and aspect ratio; null for none. */
  size: string | null;
  audio: AudioChoice;
  seed: number | null;
}

/** Duration asked for when nothing else was chosen. */
export const DEFAULT_DURATION = 5;
export const MAX_SEED = 4_294_967_295;

export const DEFAULT_FORMAT: ClipFormat = {
  duration: DEFAULT_DURATION,
  resolution: null,
  aspectRatio: '16:9',
  size: null,
  audio: 'model',
  seed: null,
};

export function parseSize(text: string): { width: number; height: number } | null {
  const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(text);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** A stored format, tolerant of missing and foreign values. */
export function parseFormat(raw: unknown): ClipFormat {
  const source = isRecord(raw) ? raw : {};
  const duration = source['duration'];
  const seed = source['seed'];
  const audio = source['audio'];
  return {
    duration:
      isFiniteNumber(duration) && Number.isInteger(duration) && duration >= 1 && duration <= 120
        ? duration
        : DEFAULT_FORMAT.duration,
    resolution:
      isString(source['resolution']) && source['resolution'] ? source['resolution'] : null,
    aspectRatio:
      isString(source['aspectRatio']) && source['aspectRatio']
        ? source['aspectRatio']
        : DEFAULT_FORMAT.aspectRatio,
    size: isString(source['size']) && parseSize(source['size']) ? source['size'] : null,
    audio: audio === 'on' || audio === 'off' ? audio : 'model',
    seed:
      isFiniteNumber(seed) && Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED ? seed : null,
  };
}
