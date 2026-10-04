/**
 * Putting a finished job's clip on the timeline and settling its sequence step, as ONE update of both records
 * (the tool writes them in one locked store step). Idempotent: a clip already on the timeline for that job is
 * reused and its step settled again, so a page that closed between the two writes leaves nothing stuck, and
 * `repairSlots` settles, on load, steps whose clips are already placed.
 *
 * A Re-run's take goes where the old take was; the old one stays on the timeline, left out of the join, and the
 * chained clip after it is marked as continuing the old take (its first frame no longer repeats the clip before
 * it, so it is not dropped). A job of an older attempt lands left out, without settling the current attempt.
 */
import type { VideoJobPayload } from './job-payload';
import { markDone, markStale, nextChained, type SequenceRun } from './sequence';
import {
  insertClip,
  type Placement,
  slotPlacement,
  type TimelineClip,
  updateClip,
} from './timeline';

export interface FinishedJob {
  jobId: string;
  costUsd: number | null;
  payload: VideoJobPayload;
}

export interface Delivered {
  clips: TimelineClip[];
  run: SequenceRun | null;
  /** The clip on the timeline for this job (the draft, or the one already there). */
  clip: TimelineClip;
}

export function placeDelivery(
  clips: readonly TimelineClip[],
  run: SequenceRun | null,
  job: FinishedJob,
  draft: TimelineClip,
  now: number,
): Delivered {
  const { payload } = job;
  const inSequence = run !== null && payload.sequenceId === run.id && payload.slotKey !== null;
  const slot = inSequence
    ? run.slots.find((candidate) => candidate.key === payload.slotKey)
    : undefined;
  const settle = (current: SequenceRun | null, clipId: string): SequenceRun | null =>
    current && slot
      ? markDone(
          current,
          slot.key,
          { jobId: job.jobId, attempt: payload.attempt, clipId, costUsd: job.costUsd },
          now,
        )
      : current;

  const existing = clips.find((clip) => clip.jobId === job.jobId);
  if (existing) return { clips: [...clips], run: settle(run, existing.id), clip: existing };

  let list = [...clips];
  let next = run;
  let clip = draft;
  const onTimeline = (id: string | null): id is string =>
    id !== null && list.some((candidate) => candidate.id === id);
  if (run && slot) {
    const current = payload.attempt === slot.attempt;
    if (!current) {
      // A late job of an older attempt: kept (it was paid for), left out of the join.
      clip = { ...draft, included: false };
      list = insertClip(list, clip, onTimeline(slot.clipId) ? { after: slot.clipId } : 'end');
    } else if (onTimeline(slot.clipId)) {
      const old = slot.clipId;
      list = insertClip(list, clip, { before: old });
      list = updateClip(list, old, { included: false });
      const after = nextChained(run, slot.key);
      const continued = after?.clipId
        ? list.find((candidate) => candidate.id === after.clipId)
        : undefined;
      if (after && continued?.continues) {
        list = updateClip(list, continued.id, { staleSource: true, dropFirstFrame: false });
        next = markStale(next!, after.key, now);
      }
    } else {
      const placement: Placement = slotPlacement(
        list,
        run.slots.map((candidate) => candidate.key),
        run.id,
        slot.key,
      );
      list = insertClip(list, clip, placement);
    }
    return { clips: list, run: current ? settle(next, clip.id) : next, clip };
  }
  list = insertClip(
    list,
    clip,
    payload.after && onTimeline(payload.after) ? { after: payload.after } : 'end',
  );
  return { clips: list, run, clip };
}

/**
 * Steps still starting or running whose clip (same sequence, step and attempt) is already on the timeline are
 * done: settle them. `costOf` gives the clip's job cost when known. Returns `run` itself when nothing changed.
 */
export function repairSlots(
  run: SequenceRun,
  clips: readonly TimelineClip[],
  costOf: (jobId: string) => number | null,
): SequenceRun {
  let next = run;
  for (const slot of run.slots) {
    if (slot.status !== 'starting' && slot.status !== 'running') continue;
    const clip = clips.find(
      (candidate) =>
        candidate.sequenceId === run.id &&
        candidate.slotKey === slot.key &&
        candidate.attempt === slot.attempt &&
        candidate.jobId !== null,
    );
    if (!clip?.jobId) continue;
    next = markDone(
      next,
      slot.key,
      { jobId: clip.jobId, attempt: slot.attempt, clipId: clip.id, costUsd: costOf(clip.jobId) },
      Date.now(),
    );
  }
  return next;
}
