/**
 * The clip timeline: ordered clips with trims, the "drop the repeated first frame" switch for clips that continue
 * the one before, and whether each goes into the join. Pure operations on JSON-safe records, stored in
 * `ctx.state` so a reload (or another tab) has the same order. The videos themselves are memory-only: a
 * generated clip is downloaded again from OpenRouter after a reload while it is still there (retention is only
 * known to be at least 18 minutes, docs/openrouter-api.md §7.4); an upload must be added again.
 */
import { isFiniteNumber, isRecord, isString } from '../../core/util';

export interface TimelineClip {
  id: string;
  /** File name, e.g. `harbour-at-dawn-1.mp4`. */
  name: string;
  source: 'generated' | 'upload';
  /** Local job id (generated clips). */
  jobId: string | null;
  /** OpenRouter's job id, for downloading the clip again. */
  remoteId: string | null;
  keyId: string | null;
  model: string | null;
  prompt: string;
  /** Seconds, once the video was read; null before. */
  duration: number | null;
  /** Seconds cut from the start and the end in the join. */
  trimStart: number;
  trimEnd: number;
  /** Its first frame repeats the previous clip's last frame (Continue, chained steps). */
  continues: boolean;
  /** Leave that repeated frame out of the join. */
  dropFirstFrame: boolean;
  /** Goes into the join (a replaced re-run take stays on the timeline, left out). */
  included: boolean;
  sequenceId: string | null;
  slotKey: string | null;
  /** The sequence step's attempt that made it (1 outside sequences). */
  attempt: number;
  /** OpenRouter no longer has it (a download answered 404): it cannot be played, joined or continued here. */
  expired: boolean;
  /** It continued a take of the step before that a Re-run has since replaced. */
  staleSource: boolean;
  createdAt: number;
}

/** Where a new clip goes. */
export type Placement = { after: string } | { before: string } | 'end';

/** Shortest part of a clip a trim may leave. */
export const MIN_PLAY_SECONDS = 0.1;
/** Frame rate assumed for "one frame" when a clip's own is unknown (the generators make 24 fps). */
export const ASSUMED_FPS = 24;

export function insertClip(
  clips: readonly TimelineClip[],
  clip: TimelineClip,
  placement: Placement,
): TimelineClip[] {
  const next = clips.filter((existing) => existing.id !== clip.id);
  let index = next.length;
  if (placement !== 'end') {
    const anchor =
      'after' in placement
        ? next.findIndex((existing) => existing.id === placement.after)
        : next.findIndex((existing) => existing.id === placement.before);
    if (anchor >= 0) index = 'after' in placement ? anchor + 1 : anchor;
  }
  next.splice(index, 0, clip);
  return next;
}

/** Moves a clip `delta` places (clamped); the same array when it cannot move. */
export function moveClip(
  clips: readonly TimelineClip[],
  id: string,
  delta: number,
): readonly TimelineClip[] {
  const from = clips.findIndex((clip) => clip.id === id);
  if (from < 0) return clips;
  const to = Math.min(clips.length - 1, Math.max(0, from + delta));
  if (to === from) return clips;
  const next = [...clips];
  const [clip] = next.splice(from, 1);
  next.splice(to, 0, clip!);
  return next;
}

export function removeClip(clips: readonly TimelineClip[], id: string): TimelineClip[] {
  return clips.filter((clip) => clip.id !== id);
}

export function updateClip(
  clips: readonly TimelineClip[],
  id: string,
  patch: Partial<Omit<TimelineClip, 'id'>>,
): TimelineClip[] {
  return clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip));
}

/**
 * Trims that leave at least `MIN_PLAY_SECONDS` of the clip: negative or unknown values become 0, and when the
 * two together would leave too little, the end trim gives way first, then the start trim.
 */
export function clampTrim(
  duration: number | null,
  trimStart: number,
  trimEnd: number,
): { trimStart: number; trimEnd: number } {
  let start = Number.isFinite(trimStart) ? Math.max(0, trimStart) : 0;
  let end = Number.isFinite(trimEnd) ? Math.max(0, trimEnd) : 0;
  if (duration === null || !(duration > 0)) return { trimStart: start, trimEnd: end };
  const room = Math.max(0, duration - MIN_PLAY_SECONDS);
  start = Math.min(start, room);
  end = Math.min(end, room - start);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  return { trimStart: round(start), trimEnd: round(end) };
}

/** Seconds a clip adds to the join, or null while its length is unknown. */
export function playLength(clip: TimelineClip, fps = ASSUMED_FPS): number | null {
  if (clip.duration === null) return null;
  const dropped = clip.continues && clip.dropFirstFrame ? 1 / fps : 0;
  return Math.max(0, clip.duration - clip.trimStart - clip.trimEnd - dropped);
}

/** The clips that go into the join, in order. */
export function joinable(clips: readonly TimelineClip[]): TimelineClip[] {
  return clips.filter((clip) => clip.included && !clip.expired);
}

/** Total length of the join, or null while a clip's length is unknown. */
export function joinLength(clips: readonly TimelineClip[]): number | null {
  let total = 0;
  for (const clip of joinable(clips)) {
    const length = playLength(clip);
    if (length === null) return null;
    total += length;
  }
  return total;
}

export interface JoinPart {
  id: string;
  trimStart?: number;
  trimEnd?: number;
  dropFirstFrame?: boolean;
}

/** What `concatVideos` gets for each included clip, in order (only the options that apply). */
export function joinPlan(clips: readonly TimelineClip[]): JoinPart[] {
  return joinable(clips).map((clip) => ({
    id: clip.id,
    ...(clip.trimStart > 0 ? { trimStart: clip.trimStart } : {}),
    ...(clip.trimEnd > 0 ? { trimEnd: clip.trimEnd } : {}),
    ...(clip.continues && clip.dropFirstFrame ? { dropFirstFrame: true } : {}),
  }));
}

/**
 * Where a sequence step's clip goes: after the clip of the nearest earlier step that has one on the timeline,
 * else before the nearest later one, else at the end. So clips of independent steps that finish out of order still
 * line up in step order.
 */
export function slotPlacement(
  clips: readonly TimelineClip[],
  slotKeys: readonly string[],
  sequenceId: string,
  key: string,
): Placement {
  const index = slotKeys.indexOf(key);
  const clipOf = (slot: string | undefined): TimelineClip | undefined =>
    slot === undefined
      ? undefined
      : clips.find(
          (clip) => clip.sequenceId === sequenceId && clip.slotKey === slot && clip.included,
        );
  for (let i = index - 1; i >= 0; i--) {
    const clip = clipOf(slotKeys[i]);
    if (clip) return { after: clip.id };
  }
  for (let i = index + 1; i < slotKeys.length; i++) {
    const clip = clipOf(slotKeys[i]);
    if (clip) return { before: clip.id };
  }
  return 'end';
}

// --- parsing ----------------------------------------------------------------------------------------------

function parseClip(raw: unknown): TimelineClip | null {
  if (!isRecord(raw) || !isString(raw['id']) || !raw['id']) return null;
  const text = (value: unknown, fallback = ''): string => (isString(value) ? value : fallback);
  const nullable = (value: unknown): string | null => (isString(value) && value ? value : null);
  const seconds = (value: unknown): number => (isFiniteNumber(value) && value > 0 ? value : 0);
  const duration = raw['duration'];
  const created = raw['createdAt'];
  return {
    id: raw['id'],
    name: text(raw['name'], 'clip.mp4'),
    source: raw['source'] === 'upload' ? 'upload' : 'generated',
    jobId: nullable(raw['jobId']),
    remoteId: nullable(raw['remoteId']),
    keyId: nullable(raw['keyId']),
    model: nullable(raw['model']),
    prompt: text(raw['prompt']),
    duration: isFiniteNumber(duration) && duration > 0 ? duration : null,
    trimStart: seconds(raw['trimStart']),
    trimEnd: seconds(raw['trimEnd']),
    continues: raw['continues'] === true,
    dropFirstFrame: raw['dropFirstFrame'] === true,
    included: raw['included'] !== false,
    sequenceId: nullable(raw['sequenceId']),
    slotKey: nullable(raw['slotKey']),
    attempt: isFiniteNumber(raw['attempt']) && raw['attempt'] >= 1 ? Math.floor(raw['attempt']) : 1,
    expired: raw['expired'] === true,
    staleSource: raw['staleSource'] === true,
    createdAt: isFiniteNumber(created) ? created : 0,
  };
}

/** The stored timeline, validated (bad entries and repeated ids are dropped). */
export function parseTimeline(raw: unknown): TimelineClip[] {
  const list = isRecord(raw) && raw['v'] === 1 && Array.isArray(raw['clips']) ? raw['clips'] : [];
  const seen = new Set<string>();
  const clips: TimelineClip[] = [];
  for (const entry of list) {
    const clip = parseClip(entry);
    if (!clip || seen.has(clip.id)) continue;
    seen.add(clip.id);
    clips.push(clip);
  }
  return clips;
}

export function timelineJson(clips: readonly TimelineClip[]): { v: 1; clips: TimelineClip[] } {
  return { v: 1, clips: [...clips] };
}
