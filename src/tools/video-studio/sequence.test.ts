import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from './format';
import {
  abandonStart,
  applyStatus,
  chainSource,
  claim,
  committedUsd,
  createRun,
  markDone,
  markFailed,
  markRunning,
  parseRun,
  pause,
  plan,
  releaseClaim,
  rerun,
  resume,
  type SequenceRun,
  type SequenceSpec,
  spentUsd,
  startsFromFrame,
  stepPrompt,
  stop,
  totalEstimate,
} from './sequence';

const spec = (patch: Partial<SequenceSpec> = {}): SequenceSpec => ({
  mode: 'chained',
  repeat: 1,
  style: '',
  capUsd: null,
  onFailure: 'stop',
  steps: [
    { id: 'a', prompt: 'One', imageRole: 'references' },
    { id: 'b', prompt: 'Two', imageRole: 'references' },
    { id: 'c', prompt: 'Three', imageRole: 'last-frame' },
  ],
  ...patch,
});

const start = (
  patch: Partial<SequenceSpec> = {},
  sourceClipId: string | null = null,
): SequenceRun =>
  createRun({
    id: 'run-1',
    spec: spec(patch),
    model: 'x-ai/grok-imagine-video',
    format: DEFAULT_FORMAT,
    sourceClipId,
    now: 1,
  });

const flat = (): number => 0.05;

/** Plans, claims and marks running what the plan starts; returns the run and the keys started. */
function step(run: SequenceRun, estimate = flat): { run: SequenceRun; started: string[] } {
  const next = plan(run, estimate);
  let updated = applyStatus(run, next, 2);
  for (const key of next.start) {
    updated = claim(updated, key, estimate(), 2)!;
    updated = markRunning(updated, key, { jobId: `job-${key}`, runId: `run-${key}` }, 3);
  }
  return { run: updated, started: next.start };
}

const finish = (run: SequenceRun, key: string, cost: number | null = 0.052): SequenceRun =>
  markDone(run, key, { jobId: `job-${key}`, clipId: `clip-${key}`, costUsd: cost }, 4);

const statuses = (run: SequenceRun): string[] => run.slots.map((slot) => slot.status);

describe('sequence runs', () => {
  it('expands steps into slots, repeated rounds in order', () => {
    const run = start({ repeat: 2 });
    expect(run.slots.map((slot) => slot.key)).toEqual(['0:a', '0:b', '0:c', '1:a', '1:b', '1:c']);
    expect(totalEstimate(run.spec, 0.05)).toBeCloseTo(0.3);
    expect(totalEstimate(run.spec, null)).toBeNull();
  });

  it('appends the shared style to every prompt', () => {
    expect(stepPrompt(spec({ style: 'Film grain' }), 'A boat ')).toBe(
      'A boat\n\nStyle: Film grain',
    );
    expect(stepPrompt(spec(), ' A boat ')).toBe('A boat');
    expect(stepPrompt(spec({ style: 'Noir' }), '')).toBe('Style: Noir');
  });

  it('runs chained steps one at a time, each after the one before is done', () => {
    let run = start();
    let next = step(run);
    expect(next.started).toEqual(['0:a']);
    run = next.run;
    // Nothing more while one is in flight.
    expect(step(run).started).toEqual([]);
    run = finish(run, '0:a');
    next = step(run);
    expect(next.started).toEqual(['0:b']);
    run = finish(next.run, '0:b');
    run = finish(step(run).run, '0:c');
    const done = plan(run, flat);
    expect(done).toEqual({ start: [], status: 'done', message: 'Finished: all 3 steps made.' });
  });

  it('runs independent steps up to three at once', () => {
    let run = start({
      mode: 'independent',
      steps: ['a', 'b', 'c', 'd', 'e'].map((id) => ({
        id,
        prompt: id,
        imageRole: 'references' as const,
      })),
    });
    const next = step(run);
    expect(next.started).toEqual(['0:a', '0:b', '0:c']);
    run = finish(next.run, '0:b');
    expect(step(run).started).toEqual(['0:d']);
  });

  it('continues chained steps from the last clip made, else the source clip', () => {
    let run = start({ onFailure: 'skip' }, 'upload-1');
    const has = (): boolean => true;
    expect(startsFromFrame(run, 0)).toBe(true);
    expect(chainSource(run, '0:a', has)).toBe('upload-1');
    run = finish(step(run).run, '0:a');
    expect(chainSource(run, '0:b', has)).toBe('clip-0:a');
    // Step b fails and is skipped: c continues from a's clip.
    run = markFailed(step(run).run, '0:b', { jobId: 'job-0:b', error: 'No.' }, 5);
    expect(run.status).toBe('running');
    expect(chainSource(run, '0:c', has)).toBe('clip-0:a');
    // A clip removed from the timeline is passed over.
    expect(chainSource(run, '0:c', (id) => id !== 'clip-0:a')).toBe('upload-1');
    expect(startsFromFrame(start(), 0)).toBe(false);
    expect(startsFromFrame(start({ mode: 'independent' }, 'upload-1'), 1)).toBe(false);
  });

  it('stops at a failed step when the rule says stop', () => {
    let run = step(start()).run;
    run = markFailed(run, '0:a', { jobId: 'job-0:a', error: 'The provider refused.' }, 5);
    expect(run.status).toBe('stopped');
    expect(run.message).toBe('Stopped: step 1 failed (The provider refused).');
    expect(step(run).started).toEqual([]);
    // A failure of another job is not this slot's.
    expect(markFailed(run, '0:a', { jobId: 'other', error: 'x' }, 6)).toBe(run);
  });

  it('settles a slot whose job finished before its id was recorded', () => {
    const run = start();
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const done = markDone(claimed, '0:a', { jobId: 'job-x', clipId: 'clip-x', costUsd: 0.05 }, 3);
    expect(done.slots[0]).toMatchObject({ status: 'done', jobId: 'job-x', clipId: 'clip-x' });
    // The late markRunning does not undo it.
    expect(markRunning(done, '0:a', { jobId: 'job-x', runId: 'r' }, 4)).toBe(done);
  });

  it('pauses, stops and resumes without losing pending steps', () => {
    let run = step(start()).run;
    run = pause(run, 5);
    expect(run.status).toBe('paused');
    run = finish(run, '0:a');
    expect(step(run).started).toEqual([]);
    run = resume(run, 6);
    expect(step(run).started).toEqual(['0:b']);
    run = stop(step(run).run, 7);
    expect(run.status).toBe('stopped');
    expect(statuses(run)).toEqual(['done', 'running', 'pending']);
    run = resume(finish(run, '0:b'), 8);
    expect(step(run).started).toEqual(['0:c']);
  });

  it('re-runs one finished step, even while paused, without redoing the others', () => {
    let run = finish(step(start()).run, '0:a');
    run = finish(step(run).run, '0:b');
    run = finish(step(run).run, '0:c');
    run = applyStatus(run, plan(run, flat), 9);
    expect(run.status).toBe('done');
    run = rerun(run, '0:b', 10)!;
    expect(run.status).toBe('running');
    expect(run.slots[1]).toMatchObject({ status: 'pending', attempt: 2, forced: true });
    const next = step(run);
    expect(next.started).toEqual(['0:b']);
    run = finish(next.run, '0:b', 0.06);
    expect(run.slots[1]?.spentUsd).toBeCloseTo(0.112);
    expect(plan(run, flat).status).toBe('done');
    // While paused, only the re-run step starts.
    let paused = pause(step(start({ mode: 'independent' })).run, 11);
    paused = finish(paused, '0:a');
    paused = rerun(paused, '0:a', 12)!;
    expect(step(paused).started).toEqual(['0:a']);
    expect(rerun(paused, '0:c', 13)).toBeNull(); // still running: nothing to re-run
  });

  it('a start refused before sending puts the step back and pauses with the reason', () => {
    const run = start();
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const released = releaseClaim(claimed, '0:a', 'Paused: no key.', 3);
    expect(released.slots[0]).toMatchObject({ status: 'pending', estimateUsd: null });
    expect(released).toMatchObject({ status: 'paused', message: 'Paused: no key.' });
    expect(claim(released, '0:b', 0.05, 4)?.slots[1]?.status).toBe('starting');
    expect(claim(claimed, '0:a', 0.05, 4)).toBeNull();
  });

  it('after a reload a step left starting fails and pauses the sequence, never sent again', () => {
    const run = start();
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const recovered = abandonStart(claimed, '0:a', 3);
    expect(recovered.slots[0]?.status).toBe('failed');
    expect(recovered.status).toBe('paused');
    expect(recovered.message).toContain('step 1 was being sent');
  });
});

describe('spend cap', () => {
  it('stops before the step that would pass the cap, counting actual costs and steps in flight', () => {
    let run = start({
      capUsd: 0.12,
      steps: ['a', 'b', 'c', 'd'].map((id) => ({
        id,
        prompt: id,
        imageRole: 'references' as const,
      })),
    });
    run = finish(step(run).run, '0:a', 0.052);
    expect(committedUsd(run)).toBeCloseTo(0.052);
    // 0.052 spent + 0.05 = 0.102: allowed.
    run = step(run).run;
    expect(committedUsd(run)).toBeCloseTo(0.102);
    run = finish(run, '0:b', 0.052);
    // 0.104 spent + 0.05 = 0.154 > 0.12: stopped, nothing started.
    const next = plan(run, flat);
    expect(next.start).toEqual([]);
    expect(next.status).toBe('stopped');
    expect(next.message).toBe(
      'Stopped before step 3: it would bring this sequence to about $0.15, over its $0.12 spend cap ($0.10 spent so far).',
    );
    expect(spentUsd(run)).toBeCloseTo(0.104);
  });

  it('starts only as many parallel steps as the cap allows', () => {
    const run = start({
      mode: 'independent',
      capUsd: 0.1,
      steps: ['a', 'b', 'c'].map((id) => ({ id, prompt: id, imageRole: 'references' as const })),
    });
    const next = plan(run, flat);
    expect(next.start).toEqual(['0:a', '0:b']);
    expect(next.status).toBe('stopped');
  });

  it('counts an unknown cost at its estimate, and stops when a step cannot be estimated', () => {
    let run = start({ capUsd: 1 });
    run = finish(step(run, () => 0.3).run, '0:a', null);
    expect(spentUsd(run)).toBeCloseTo(0.3);
    const next = plan(run, () => null);
    expect(next.status).toBe('stopped');
    expect(next.message).toContain('cannot be estimated');
    // Without a cap an unknown estimate does not stop anything.
    expect(plan(start(), () => null).start).toEqual(['0:a']);
  });
});

describe('stored runs', () => {
  it('round-trips through JSON and rejects broken records', () => {
    const run = finish(step(start({ repeat: 2, capUsd: 2 }, 'upload-1')).run, '0:a');
    expect(parseRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
    const withImages = createRun({
      id: 'r',
      spec: spec(),
      model: 'm',
      format: DEFAULT_FORMAT,
      sourceClipId: null,
      stepImages: { a: 2, c: 1 },
      now: 1,
    });
    expect(parseRun(JSON.parse(JSON.stringify(withImages)))?.stepImages).toEqual({ a: 2, c: 1 });
    expect(parseRun({ ...withImages, stepImages: { a: -1, b: 'x', c: 1.5 } })?.stepImages).toEqual({
      c: 1,
    });
    expect(parseRun(null)).toBeNull();
    expect(parseRun({ v: 2 })).toBeNull();
    expect(parseRun({ ...run, slots: [] })).toBeNull();
    const repaired = parseRun({
      ...run,
      status: 'weird',
      slots: [{ key: 'k', stepId: 'a', status: '?' }],
    });
    expect(repaired?.status).toBe('paused');
    expect(repaired?.slots[0]).toMatchObject({ status: 'pending', attempt: 1, spentUsd: 0 });
  });
});
