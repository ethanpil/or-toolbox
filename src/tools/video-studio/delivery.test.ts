import { describe, expect, it } from 'vitest';
import { placeDelivery, repairSlots } from './delivery';
import { DEFAULT_FORMAT } from './format';
import type { VideoJobPayload } from './job-payload';
import { claim, createRun, markDone, markRunning, rerun, type SequenceRun } from './sequence';
import type { TimelineClip } from './timeline';

const payload = (patch: Partial<VideoJobPayload> = {}): VideoJobPayload => ({
  v: 1,
  model: 'm',
  prompt: 'p',
  label: 'l',
  after: null,
  continues: false,
  sequenceId: null,
  slotKey: null,
  attempt: 1,
  delivered: false,
  ...patch,
});

const draft = (id: string, patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  name: `${id}.mp4`,
  source: 'generated',
  jobId: `job-${id}`,
  remoteId: `gen-${id}`,
  keyId: 'k',
  model: 'm',
  prompt: '',
  duration: 1,
  trimStart: 0,
  trimEnd: 0,
  continues: false,
  dropFirstFrame: false,
  included: true,
  sequenceId: null,
  slotKey: null,
  attempt: 1,
  expired: false,
  staleSource: false,
  createdAt: 1,
  ...patch,
});

const sequence = (): SequenceRun =>
  createRun({
    id: 'seq',
    spec: {
      mode: 'chained',
      repeat: 1,
      style: '',
      capUsd: null,
      onFailure: 'stop',
      steps: ['a', 'b', 'c'].map((id) => ({ id, prompt: id, imageRole: 'references' as const })),
    },
    model: 'm',
    format: DEFAULT_FORMAT,
    sourceClipId: null,
    now: 1,
  });

const running = (run: SequenceRun, key: string, jobId: string): SequenceRun => {
  const attempt = run.slots.find((slot) => slot.key === key)!.attempt;
  return markRunning(claim(run, key, 0.05, 2)!, key, { jobId, runId: 'r', attempt }, 3);
};

/** Delivers job `job-<jobOf>` for slot `key` (current attempt) with a new clip `id`. */
const deliver = (clips: TimelineClip[], run: SequenceRun, key: string, id: string, jobOf = id) => {
  const attempt = run.slots.find((slot) => slot.key === key)!.attempt;
  return placeDelivery(
    clips,
    run,
    {
      jobId: `job-${jobOf}`,
      costUsd: 0.05,
      payload: payload({ sequenceId: 'seq', slotKey: key, attempt, continues: key !== '0:a' }),
    },
    draft(id, {
      sequenceId: 'seq',
      slotKey: key,
      attempt,
      continues: key !== '0:a',
      dropFirstFrame: key !== '0:a',
    }),
    5,
  );
};

describe('delivering a finished job', () => {
  it('places a clip after its source and completes nothing else', () => {
    const result = placeDelivery(
      [draft('src'), draft('other')],
      null,
      { jobId: 'job-new', costUsd: 0.05, payload: payload({ after: 'src', continues: true }) },
      draft('new', { jobId: 'job-new' }),
      5,
    );
    expect(result.clips.map((clip) => clip.id)).toEqual(['src', 'new', 'other']);
    expect(result.clip.id).toBe('new');
    expect(result.run).toBeNull();
  });

  it('places a sequence clip and completes its slot in the same update', () => {
    const run = running(sequence(), '0:a', 'job-a1');
    const result = deliver([], run, '0:a', 'a1');
    expect(result.clips.map((clip) => clip.id)).toEqual(['a1']);
    expect(result.run?.slots[0]).toMatchObject({ status: 'done', clipId: 'a1', spentUsd: 0.05 });
  });

  it('is idempotent: a clip already placed (the page closed before the slot was written) still completes it', () => {
    const run = running(sequence(), '0:a', 'job-a1');
    const placed = deliver([], run, '0:a', 'a1');
    // The slot write was lost: deliver again with the clip already there.
    const again = deliver(placed.clips, run, '0:a', 'a1-dup', 'a1');
    expect(again.clips.map((clip) => clip.id)).toEqual(['a1']);
    expect(again.clip.id).toBe('a1');
    expect(again.run?.slots[0]).toMatchObject({ status: 'done', clipId: 'a1' });
  });

  it('a re-run take replaces the old one in place; the chained clip after it is marked as continuing the old take', () => {
    let run = running(sequence(), '0:a', 'job-a1');
    let state = deliver([], run, '0:a', 'a1');
    run = running(state.run!, '0:b', 'job-b1');
    state = deliver(state.clips, run, '0:b', 'b1');
    run = running(rerun(state.run!, '0:a', 6)!, '0:a', 'job-a2');
    state = deliver(state.clips, run, '0:a', 'a2');
    expect(state.clips.map((clip) => [clip.id, clip.included])).toEqual([
      ['a2', true],
      ['a1', false],
      ['b1', true],
    ]);
    // b1 continued a1's last frame: it no longer repeats the clip before it.
    expect(state.clips[2]).toMatchObject({ staleSource: true, dropFirstFrame: false });
    expect(state.run?.slots[0]).toMatchObject({ status: 'done', clipId: 'a2', attempt: 2 });
    expect(state.run?.slots[1]?.stale).toBe(true);
  });

  it('a job of an older attempt lands on the timeline left out, without settling the current attempt', () => {
    let run = running(sequence(), '0:a', 'job-a1');
    let state = deliver([], run, '0:a', 'a1');
    run = claim(rerun(state.run!, '0:a', 6)!, '0:a', 0.05, 7)!;
    state = placeDelivery(
      state.clips,
      run,
      {
        jobId: 'job-late',
        costUsd: 0.05,
        payload: payload({ sequenceId: 'seq', slotKey: '0:a', attempt: 1 }),
      },
      draft('late', { jobId: 'job-late', sequenceId: 'seq', slotKey: '0:a', attempt: 1 }),
      8,
    );
    expect(state.clips.map((clip) => [clip.id, clip.included])).toEqual([
      ['a1', true],
      ['late', false],
    ]);
    expect(state.run?.slots[0]?.status).toBe('starting');
  });
});

describe('repair on load', () => {
  it('completes a slot whose clip is already on the timeline', () => {
    const run = running(sequence(), '0:a', 'job-a1');
    const clips = [draft('a1', { jobId: 'job-a1', sequenceId: 'seq', slotKey: '0:a', attempt: 1 })];
    const repaired = repairSlots(run, clips, () => 0.052);
    expect(repaired.slots[0]).toMatchObject({ status: 'done', clipId: 'a1', spentUsd: 0.052 });
    // Nothing to repair: the same run.
    expect(repairSlots(repaired, clips, () => 0.052)).toBe(repaired);
    expect(
      repairSlots(
        markDone(run, '0:a', { jobId: 'job-a1', attempt: 1, clipId: 'a1', costUsd: 0.05 }, 4),
        [],
        () => null,
      ).slots[0]?.status,
    ).toBe('done');
  });
});
