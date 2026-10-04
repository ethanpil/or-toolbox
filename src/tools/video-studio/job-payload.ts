/**
 * What a video job carries in IndexedDB `jobs` (JSON only): enough to place its clip on the timeline and to
 * settle its sequence step after a reload, or in another tab. The clip itself is downloaded when the job is done.
 */
import { isFiniteNumber, isRecord, isString } from '../../core/util';

export const VIDEO_JOB = 'video';

export interface VideoJobPayload {
  v: 1;
  model: string;
  /** The prompt as sent (names the clip, shown in the job list). */
  prompt: string;
  /** Short name for the job list. */
  label: string;
  /** The clip this one continues (Continue, Extend): the new clip goes right after it. */
  after: string | null;
  /** Its first frame repeats the previous clip's last frame. */
  continues: boolean;
  sequenceId: string | null;
  slotKey: string | null;
  /** Set once its clip is on the timeline (or its failure was recorded): never handled twice. */
  delivered: boolean;
}

/** What a finished job stores: the cost from the completed status (§7.3) and how many clips it made. */
export interface VideoJobResult {
  costUsd: number | null;
  outputs: number;
}

export function parsePayload(raw: unknown): VideoJobPayload | null {
  if (!isRecord(raw) || raw['v'] !== 1 || !isString(raw['model'])) return null;
  const text = (value: unknown): string => (isString(value) ? value : '');
  const nullable = (value: unknown): string | null => (isString(value) && value ? value : null);
  return {
    v: 1,
    model: raw['model'],
    prompt: text(raw['prompt']),
    label: text(raw['label']) || 'Video clip',
    after: nullable(raw['after']),
    continues: raw['continues'] === true,
    sequenceId: nullable(raw['sequenceId']),
    slotKey: nullable(raw['slotKey']),
    delivered: raw['delivered'] === true,
  };
}

export function parseResult(raw: unknown): VideoJobResult {
  const source = isRecord(raw) ? raw : {};
  const cost = source['costUsd'];
  const outputs = source['outputs'];
  return {
    costUsd: isFiniteNumber(cost) && cost >= 0 ? cost : null,
    outputs: isFiniteNumber(outputs) && outputs >= 0 ? outputs : 1,
  };
}

/**
 * Poll interval for a job `ageMs` old: quick at first (grok finishes 1 s clips in about 6 s), slowing to the
 * documented 30 s for jobs that take minutes (Seedance: 62 s for 4 s, §7.3).
 */
export function pollInterval(ageMs: number): number {
  return Math.round(Math.min(30_000, 2000 + Math.max(0, ageMs) / 10));
}
