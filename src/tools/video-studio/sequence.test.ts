import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMAT } from './format';
import {
  abandonStart,
  applySpecEdit,
  applyStatus,
  block,
  chainSourceOf,
  chooseSource,
  claim,
  committedUsd,
  createRun,
  dropStepImages,
  markDone,
  markFailed,
  markRunning,
  markStale,
  nextChained,
  ownsJob,
  parseRun,
  pause,
  plan,
  releaseClaim,
  rerun,
  resume,
  returnClaim,
  type SequenceRun,
  type SequenceSpec,
  spentIsEstimate,
  spentUsd,
  stepPrompt,
  stop,
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

const steps = (ids: string[]) =>
  ids.map((id) => ({ id, prompt: id, imageRole: 'references' as const }));

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
const attemptOf = (run: SequenceRun, key: string): number =>
  run.slots.find((slot) => slot.key === key)!.attempt;
const job = (run: SequenceRun, key: string): string => `job-${key}-${attemptOf(run, key)}`;

/** Plans, claims and marks running what the plan starts; returns the run and the keys started. */
function step(run: SequenceRun, estimate = flat): { run: SequenceRun; started: string[] } {
  const next = plan(run, estimate);
  let updated = applyStatus(run, next, 2);
  for (const key of next.start) {
    updated = claim(updated, key, estimate(), 2, 'tab')!;
    updated = markRunning(
      updated,
      key,
      { jobId: job(updated, key), runId: `run-${key}`, attempt: attemptOf(updated, key) },
      3,
    );
  }
  return { run: updated, started: next.start };
}

const finish = (run: SequenceRun, key: string, cost: number | null = 0.052): SequenceRun =>
  markDone(
    run,
    key,
    {
      jobId: job(run, key),
      attempt: attemptOf(run, key),
      clipId: `clip-${key}-${attemptOf(run, key)}`,
      costUsd: cost,
    },
    4,
  );

const fail = (
  run: SequenceRun,
  key: string,
  error: string,
  billed: 'no' | 'maybe' | number = 'no',
): SequenceRun =>
  markFailed(run, key, { jobId: job(run, key), attempt: attemptOf(run, key), error, billed }, 5);

const statuses = (run: SequenceRun): string[] => run.slots.map((slot) => slot.status);

describe('sequence runs', () => {
  it('expands steps into slots, repeated rounds in order', () => {
    const run = start({ repeat: 2 });
    expect(run.slots.map((slot) => slot.key)).toEqual(['0:a', '0:b', '0:c', '1:a', '1:b', '1:c']);
    expect(run.blocker).toBeNull();
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
    expect(step(run).started).toEqual([]);
    run = finish(run, '0:a');
    next = step(run);
    expect(next.started).toEqual(['0:b']);
    run = finish(next.run, '0:b');
    run = finish(step(run).run, '0:c');
    expect(plan(run, flat)).toEqual({
      start: [],
      status: 'done',
      message: 'Finished: all 3 steps made.',
    });
  });

  it('runs independent steps up to three at once', () => {
    let run = start({ mode: 'independent', steps: steps(['a', 'b', 'c', 'd', 'e']) });
    const next = step(run);
    expect(next.started).toEqual(['0:a', '0:b', '0:c']);
    run = finish(next.run, '0:b');
    expect(step(run).started).toEqual(['0:d']);
  });

  it("a claim records the claiming tab and forgets the previous attempt's job", () => {
    let run = finish(step(start()).run, '0:a');
    run = rerun(run, '0:a', 5)!;
    run = claim(run, '0:a', 0.05, 6, 'tab-2')!;
    expect(run.slots[0]).toMatchObject({
      status: 'starting',
      attempt: 2,
      jobId: null,
      runId: null,
      claimedBy: 'tab-2',
      claimedAt: 6,
    });
  });

  it('a re-run job that finishes before its id was recorded settles the re-run, not the old take', () => {
    let run = finish(step(start()).run, '0:a');
    run = claim(rerun(run, '0:a', 5)!, '0:a', 0.05, 6)!;
    // The old attempt's job does not own the slot any more.
    expect(ownsJob(run.slots[0]!, 'job-0:a-1', 1)).toBe(false);
    const done = markDone(
      run,
      '0:a',
      { jobId: 'job-new', attempt: 2, clipId: 'clip-2', costUsd: 0.05 },
      7,
    );
    expect(done.slots[0]).toMatchObject({
      status: 'done',
      jobId: 'job-new',
      clipId: 'clip-2',
      attempt: 2,
    });
    // A late markRunning of that attempt does not undo it; an old attempt cannot mark it running.
    expect(markRunning(done, '0:a', { jobId: 'job-new', runId: 'r', attempt: 2 }, 8)).toBe(done);
    expect(markRunning(run, '0:a', { jobId: 'x', runId: 'r', attempt: 1 }, 8)).toBe(run);
  });

  it('stops at a failed step when the rule says stop; skip goes on', () => {
    let run = step(start()).run;
    run = fail(run, '0:a', 'The provider refused.');
    expect(run.status).toBe('stopped');
    expect(run.message).toBe('Stopped: step 1 failed (The provider refused).');
    expect(step(run).started).toEqual([]);
    expect(
      markFailed(run, '0:a', { jobId: 'other', attempt: 1, error: 'x', billed: 'no' }, 6),
    ).toBe(run);

    let skip = step(start({ onFailure: 'skip' })).run;
    skip = fail(skip, '0:a', 'No.');
    expect(skip.status).toBe('running');
    expect(step(skip).started).toEqual(['0:b']);
  });

  it('a failed start (nothing queued yet) follows the failure rule too', () => {
    const run = start({ onFailure: 'skip' });
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const failed = markFailed(
      claimed,
      '0:a',
      { jobId: null, attempt: 1, error: 'Bad frame.', billed: 'no' },
      3,
    );
    expect(failed.slots[0]?.status).toBe('failed');
    expect(failed.status).toBe('running');
    const stopping = markFailed(
      claim(start(), '0:a', 0.05, 2)!,
      '0:a',
      { jobId: null, attempt: 1, error: 'Bad frame.', billed: 'no' },
      3,
    );
    expect(stopping.status).toBe('stopped');
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
    let paused = pause(step(start({ mode: 'independent' })).run, 11);
    paused = finish(paused, '0:a');
    paused = rerun(paused, '0:a', 12)!;
    expect(step(paused).started).toEqual(['0:a']);
    expect(rerun(paused, '0:c', 13)).toBeNull();
  });

  it('a start refused before sending puts the step back; running pauses, stopped stays stopped', () => {
    const run = start();
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const released = releaseClaim(claimed, '0:a', 'Paused: no key.', 3);
    expect(released.slots[0]).toMatchObject({
      status: 'pending',
      estimateUsd: null,
      claimedBy: null,
    });
    expect(released).toMatchObject({ status: 'paused', message: 'Paused: no key.' });
    const stopped = releaseClaim(stop(claimed, 3), '0:a', 'Could not read the frame.', 4);
    expect(stopped.status).toBe('stopped');
    // Returning a claim (Pause or Stop came first) changes nothing else.
    const quiet = returnClaim(pause(claimed, 3), '0:a', 4);
    expect(quiet).toMatchObject({
      status: 'paused',
      message: 'Paused: steps already sent still finish.',
    });
    expect(quiet.slots[0]?.status).toBe('pending');
  });

  it('after a reload a step left starting fails as maybe billed and pauses the sequence', () => {
    const run = start();
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:a', 0.05, 2)!;
    const recovered = abandonStart(claimed, '0:a', 3);
    expect(recovered.slots[0]).toMatchObject({
      status: 'failed',
      spentUsd: 0.05,
      spentEstimated: true,
    });
    expect(recovered.status).toBe('paused');
    expect(recovered.message).toContain('step 1 was being sent');
  });
});

describe('chain sources and blockers', () => {
  it('continues the nearest clip made, else the source clip; a missing one is expected, not dropped', () => {
    let run = start({ onFailure: 'skip' }, 'upload-1');
    expect(chainSourceOf(run, '0:a')).toEqual({ expected: true, clipId: 'upload-1' });
    run = finish(step(run).run, '0:a');
    expect(chainSourceOf(run, '0:b')).toEqual({ expected: true, clipId: 'clip-0:a-1' });
    // Step b fails and is skipped: c continues a's clip.
    run = fail(step(run).run, '0:b', 'No.');
    expect(chainSourceOf(run, '0:c')).toEqual({ expected: true, clipId: 'clip-0:a-1' });
    // Without a source, the first step starts from its prompt; a later one with nothing before is missing one.
    const plain = fail(step(start({ onFailure: 'skip' })).run, '0:a', 'No.');
    expect(chainSourceOf(plain, '0:a')).toEqual({ expected: false, clipId: null });
    expect(chainSourceOf(plain, '0:b')).toEqual({ expected: true, clipId: null });
    expect(chainSourceOf(start({ mode: 'independent' }, 'upload-1'), '0:b')).toEqual({
      expected: false,
      clipId: null,
    });
  });

  it('a blocked step waits for the user: another clip, or no first frame', () => {
    const run = finish(step(start()).run, '0:a');
    const claimed = claim(applyStatus(run, plan(run, flat), 2), '0:b', 0.05, 2)!;
    const blocked = block(
      claimed,
      '0:b',
      { kind: 'source-missing', message: 'Clip 1 is gone.' },
      3,
    );
    expect(blocked).toMatchObject({ status: 'paused', message: 'Clip 1 is gone.' });
    expect(blocked.blocker).toEqual({
      slotKey: '0:b',
      kind: 'source-missing',
      message: 'Clip 1 is gone.',
    });
    expect(blocked.slots[1]?.status).toBe('pending');
    expect(step(blocked).started).toEqual([]);

    const other = chooseSource(blocked, '0:b', 'upload-9', 4);
    expect(other).toMatchObject({ status: 'running', blocker: null });
    expect(chainSourceOf(other, '0:b')).toEqual({ expected: true, clipId: 'upload-9' });
    const none = chooseSource(blocked, '0:b', null, 4);
    expect(chainSourceOf(none, '0:b')).toEqual({ expected: false, clipId: null });
    expect(block(stop(claimed, 3), '0:b', { kind: 'source-missing', message: 'x' }, 4).status).toBe(
      'stopped',
    );
  });

  it('a step whose images were lost can go without them', () => {
    let run = createRun({
      id: 'r',
      spec: spec(),
      model: 'm',
      format: DEFAULT_FORMAT,
      sourceClipId: null,
      stepImages: { a: 2 },
      now: 1,
    });
    run = block(
      claim(run, '0:a', 0.05, 2)!,
      '0:a',
      { kind: 'images-lost', message: 'Images lost.' },
      3,
    );
    const without = dropStepImages(run, 'a', 4);
    expect(without.stepImages).toEqual({});
    expect(without).toMatchObject({ status: 'running', blocker: null });
  });

  it('a re-run marks the chained step after it as made from the old take', () => {
    let run = finish(step(start()).run, '0:a');
    run = finish(step(run).run, '0:b');
    expect(nextChained(run, '0:a')?.key).toBe('0:b');
    run = markStale(run, '0:b', 5);
    expect(run.slots[1]?.stale).toBe(true);
    // Re-running it clears the mark once its new take is made.
    run = finish(step(rerun(run, '0:b', 6)!).run, '0:b');
    expect(run.slots[1]?.stale).toBe(false);
    expect(nextChained(start({ mode: 'independent' }), '0:a')).toBeNull();
  });
});

describe('edits', () => {
  it('writes only the edited fields over the stored run, for steps it has', () => {
    const base = start();
    const stored = { ...base, spec: { ...base.spec, capUsd: 0.1, style: 'Noir' } };
    const edited = applySpecEdit(
      stored,
      {
        steps: [
          { id: 'b', prompt: 'Two, better' },
          { id: 'zz', prompt: 'not here' },
        ],
        stepImages: { a: 1, zz: 3 },
      },
      5,
    );
    expect(edited.spec.steps.map((s) => s.prompt)).toEqual(['One', 'Two, better', 'Three']);
    // A field this tab did not edit (the cap lowered elsewhere) stays as stored.
    expect(edited.spec.capUsd).toBe(0.1);
    expect(edited.spec.style).toBe('Noir');
    expect(edited.stepImages).toEqual({ a: 1 });
    expect(applySpecEdit(edited, { capUsd: 0.2, stepImages: { a: 0 } }, 6)).toMatchObject({
      spec: { capUsd: 0.2 },
      stepImages: {},
    });
  });
});

describe('spend cap', () => {
  it('stops before the step that would pass the cap, counting actual costs and steps in flight', () => {
    let run = start({ capUsd: 0.12, steps: steps(['a', 'b', 'c', 'd']) });
    run = finish(step(run).run, '0:a', 0.052);
    expect(committedUsd(run)).toBeCloseTo(0.052);
    run = step(run).run;
    expect(committedUsd(run)).toBeCloseTo(0.102);
    run = finish(run, '0:b', 0.052);
    const next = plan(run, flat);
    expect(next.start).toEqual([]);
    expect(next.status).toBe('stopped');
    expect(next.message).toBe(
      'Stopped before step 3: it would bring this sequence to about $0.15, over its $0.12 spend cap ($0.10 spent so far).',
    );
    expect(spentUsd(run)).toBeCloseTo(0.104);
  });

  it('counts steps that may have been billed at their reservation, shown as an estimate', () => {
    let run = start({ capUsd: 0.12, onFailure: 'skip', steps: steps(['a', 'b', 'c', 'd']) });
    // Sent, then the connection dropped: maybe billed.
    run = fail(step(run).run, '0:a', 'Network.', 'maybe');
    expect(spentUsd(run)).toBeCloseTo(0.05);
    expect(spentIsEstimate(run)).toBe(true);
    // Refused (a 400): not billed.
    run = fail(step(run).run, '0:b', 'Bad request.', 'no');
    expect(spentUsd(run)).toBeCloseTo(0.05);
    // 0.05 maybe spent + 0.05 fits; after another maybe-billed failure the next step would not.
    expect(plan(run, flat).start).toEqual(['0:c']);
    run = fail(step(run).run, '0:c', 'x', 'maybe');
    expect(committedUsd(run)).toBeCloseTo(0.1);
    const capped = plan(run, flat);
    expect(capped.status).toBe('stopped');
    expect(capped.message).toContain('(≈ $0.10 spent so far)');
  });

  it('starts only as many parallel steps as the cap allows', () => {
    const run = start({ mode: 'independent', capUsd: 0.1, steps: steps(['a', 'b', 'c']) });
    const next = plan(run, flat);
    expect(next.start).toEqual(['0:a', '0:b']);
    expect(next.status).toBe('stopped');
  });

  it('counts an unknown cost at its estimate, and stops when a step cannot be estimated', () => {
    let run = start({ capUsd: 1 });
    run = finish(step(run, () => 0.3).run, '0:a', null);
    expect(spentUsd(run)).toBeCloseTo(0.3);
    expect(spentIsEstimate(run)).toBe(true);
    const next = plan(run, () => null);
    expect(next.status).toBe('stopped');
    expect(next.message).toContain('cannot be estimated');
    expect(plan(start(), () => null).start).toEqual(['0:a']);
  });
});

describe('stored runs', () => {
  it('round-trips through JSON and rejects broken records', () => {
    let run = finish(step(start({ repeat: 2, capUsd: 2 }, 'upload-1')).run, '0:a');
    run = block(
      claim(run, '0:b', 0.05, 5, 'tab')!,
      '0:b',
      { kind: 'source-missing', message: 'Gone.' },
      6,
    );
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
    expect(
      parseRun({ ...withImages, blocker: { slotKey: 'x', kind: 'nope', message: 'm' } })?.blocker,
    ).toBeNull();
    expect(parseRun(null)).toBeNull();
    expect(parseRun({ v: 2 })).toBeNull();
    expect(parseRun({ ...run, slots: [] })).toBeNull();
    const repaired = parseRun({
      ...run,
      status: 'weird',
      slots: [{ key: 'k', stepId: 'a', status: '?' }],
    });
    expect(repaired?.status).toBe('paused');
    expect(repaired?.slots[0]).toMatchObject({
      status: 'pending',
      attempt: 1,
      spentUsd: 0,
      stale: false,
    });
  });
});
