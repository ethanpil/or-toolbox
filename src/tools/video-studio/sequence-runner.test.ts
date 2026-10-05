import { describe, expect, it, vi } from 'vitest';
import type { VideoRequest } from '../../core/api/types';
import { ApiError, NetworkError, NoKeyError } from '../../core/errors';
import type { JobRecord, RunHandle, ToolStateStore } from '../../core/types';
import { abortError } from '../../core/util';
import { DEFAULT_FORMAT } from './format';
import type { VideoJobPayload } from './job-payload';
import { videoControls } from './params';
import {
  claim,
  createRun,
  markDone,
  markRunning,
  rerun,
  type SequenceRun,
  type SequenceSpec,
} from './sequence';
import { billedBy, createSequenceRunner, markSent, type RunnerDeps } from './sequence-runner';
import { createStore } from './store';
import type { TimelineClip } from './timeline';

const GROK = videoControls({
  id: 'grok',
  name: 'Grok',
  supported_durations: [1, 5],
  supported_frame_images: ['first_frame'],
});
const SEEDANCE = { ...GROK, id: 'seedance', name: 'Seedance', lastFrame: true };

function memoryState(): ToolStateStore {
  const data = new Map<string, unknown>();
  const store: ToolStateStore = {
    get: <T>(key: string) => Promise.resolve(structuredClone(data.get(key)) as T | undefined),
    set: (key, value) => {
      data.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...data.keys()]),
    update: async <T>(key: string, fn: (current: T | undefined) => unknown) => {
      const current = await store.get<T>(key);
      const next = (await fn(current)) as T | undefined;
      if (next === current) return current;
      if (next === undefined) await store.delete(key);
      else await store.set(key, next);
      return next;
    },
  };
  return store;
}

const spec = (patch: Partial<SequenceSpec> = {}): SequenceSpec => ({
  mode: 'chained',
  repeat: 1,
  style: '',
  capUsd: null,
  onFailure: 'stop',
  steps: ['a', 'b', 'c'].map((id) => ({
    id,
    prompt: `Step ${id}`,
    imageRole: 'references' as const,
  })),
  ...patch,
});

const clip = (id: string, patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  name: `${id}.mp4`,
  source: 'generated',
  jobId: `job-${id}`,
  remoteId: `gen-${id}`,
  keyId: 'k',
  model: 'grok',
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

interface Harness {
  deps: RunnerDeps;
  runner: ReturnType<typeof createSequenceRunner>;
  stored(): Promise<SequenceRun>;
  sent: VideoRequest[];
  begun: { preApproved: boolean; estimateUsd: number | null }[];
  failedRuns: unknown[];
  reported: unknown[];
  clips: Map<string, TimelineClip>;
  unusable: Set<string>;
  images: Map<string, number>;
}

async function harness(run: SequenceRun, patch: Partial<RunnerDeps> = {}): Promise<Harness> {
  const store = createStore(memoryState());
  await store.updateSequence(() => run);
  const sent: VideoRequest[] = [];
  const begun: Harness['begun'] = [];
  const failedRuns: unknown[] = [];
  const reported: unknown[] = [];
  const clips = new Map<string, TimelineClip>();
  const unusable = new Set<string>();
  const images = new Map<string, number>();
  let jobs = 0;
  const deps: RunnerDeps = {
    store,
    tabId: 'tab-1',
    now: () => 10,
    clip: (id) => clips.get(id),
    usable: (candidate) => !unusable.has(candidate.id),
    lastFrame: (candidate) => Promise.resolve(`data:image/png;base64,${candidate.id}`),
    controls: (model) => (model === 'seedance' ? SEEDANCE : GROK),
    estimate: (_model, _format, count) => Promise.resolve(0.05 + count * 0.002),
    images: {
      count: (stepId) => images.get(stepId) ?? 0,
      problem: () => null,
      dataUrls: (stepId) =>
        Promise.resolve(
          Array.from(
            { length: images.get(stepId) ?? 0 },
            (_, i) => `data:image/png;base64,${stepId}${i}`,
          ),
        ),
    },
    beginRun: (input) => {
      begun.push({ preApproved: input.preApproved, estimateUsd: input.estimateUsd });
      return Promise.resolve({
        id: `run-${begun.length}`,
        keyId: 'k',
        model: input.run.model,
        fail: (error: unknown) => {
          failedRuns.push(error);
          return Promise.resolve({});
        },
      } as unknown as RunHandle);
    },
    submit: (_handle, body, payload: VideoJobPayload) => {
      sent.push(body);
      jobs++;
      return Promise.resolve({ id: `job-${jobs}`, payload } as unknown as JobRecord);
    },
    claimAlive: (slot) => Promise.resolve(slot.claimedBy === 'tab-1'),
    starting: () => Promise.resolve(false),
    withStartLock: (_runId, _key, work) => work(),
    report: (error) => void reported.push(error),
    changed: () => undefined,
    ...patch,
  };
  const runner = createSequenceRunner(deps);
  return {
    deps,
    runner,
    stored: async () => (await store.sequence())!,
    sent,
    begun,
    failedRuns,
    reported,
    clips,
    unusable,
    images,
  };
}

const newRun = (
  patch: Partial<SequenceSpec> = {},
  sourceClipId: string | null = null,
  model = 'grok',
) =>
  createRun({ id: 'seq', spec: spec(patch), model, format: DEFAULT_FORMAT, sourceClipId, now: 1 });

/** Waits until every start the runner launched has settled. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('sequence runner', () => {
  it('starts the first step, pre-approved by the Start confirmation, and records its job', async () => {
    const t = await harness(newRun());
    await t.runner.advance();
    await settle();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatchObject({ model: 'grok', prompt: 'Step a' });
    expect(t.begun).toEqual([{ preApproved: true, estimateUsd: 0.05 }]);
    expect((await t.stored()).slots[0]).toMatchObject({ status: 'running', jobId: 'job-1' });
  });

  it('a re-run (forced) step is not pre-approved: it asks for itself', async () => {
    let run = newRun({ mode: 'independent' });
    run = markRunning(
      claim(run, '0:a', 0.05, 2)!,
      '0:a',
      { jobId: 'j', runId: 'r', attempt: 1 },
      3,
    );
    run = markDone(run, '0:a', { jobId: 'j', attempt: 1, clipId: 'c', costUsd: 0.05 }, 4);
    run = { ...rerun(run, '0:a', 5)!, status: 'paused' };
    const t = await harness(run);
    await t.runner.advance();
    await settle();
    expect(t.begun).toEqual([{ preApproved: false, estimateUsd: 0.05 }]);
  });

  it('a Pause while a step is starting sends nothing and leaves the sequence paused', async () => {
    let release!: () => void;
    const t = await harness(newRun({}, 'up'), {
      lastFrame: () =>
        new Promise((resolve) => {
          release = () => resolve('data:image/png;base64,F');
        }),
    });
    t.clips.set('up', clip('up'));
    void t.runner.advance();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await t.deps.store.updateSequence((run) =>
      run ? { ...run, status: 'paused', message: 'Paused.' } : run,
    );
    release();
    await settle();
    expect(t.sent).toEqual([]);
    const stored = await t.stored();
    expect(stored).toMatchObject({ status: 'paused', message: 'Paused.' });
    expect(stored.slots[0]).toMatchObject({ status: 'pending', claimedBy: null });
  });

  it('a Stop that lands after the run began aborts the run unsent; stopped stays stopped', async () => {
    const t = await harness(newRun(), {
      beginRun: async (input) => {
        await t.deps.store.updateSequence((run) =>
          run ? { ...run, status: 'stopped', message: 'Stopped by you.' } : run,
        );
        return {
          id: 'r',
          keyId: 'k',
          model: input.run.model,
          fail: (error: unknown) => {
            t.failedRuns.push(error);
            return Promise.resolve({});
          },
        } as unknown as RunHandle;
      },
    });
    await t.runner.advance();
    await settle();
    expect(t.sent).toEqual([]);
    expect(t.failedRuns).toHaveLength(1);
    expect((t.failedRuns[0] as Error).name).toBe('AbortError');
    expect(await t.stored()).toMatchObject({ status: 'stopped', message: 'Stopped by you.' });
  });

  it('the cap is checked again right before sending, against costs that came in meanwhile', async () => {
    let run = newRun({ mode: 'independent', capUsd: 0.12 });
    run = markRunning(
      claim(run, '0:a', 0.05, 2)!,
      '0:a',
      { jobId: 'j', runId: 'r', attempt: 1 },
      3,
    );
    const t = await harness(run, {
      beginRun: async (input) => {
        // Step a's job finished meanwhile and cost far more than its estimate.
        await t.deps.store.updateSequence((current) =>
          current
            ? markDone(current, '0:a', { jobId: 'j', attempt: 1, clipId: 'c', costUsd: 0.1 }, 4)
            : current,
        );
        return {
          id: 'r2',
          keyId: 'k',
          model: input.run.model,
          fail: () => Promise.resolve({}),
        } as unknown as RunHandle;
      },
    });
    await t.runner.advance();
    await settle();
    expect(t.sent).toEqual([]);
    const stored = await t.stored();
    expect(stored.status).toBe('stopped');
    expect(stored.message).toContain('over its $0.12 spend cap');
    expect(stored.slots.filter((slot) => slot.status === 'pending').length).toBeGreaterThan(0);
  });

  it('never sends a chained step from its prompt alone when its clip is gone', async () => {
    let run = newRun();
    run = markRunning(
      claim(run, '0:a', 0.05, 2)!,
      '0:a',
      { jobId: 'j', runId: 'r', attempt: 1 },
      3,
    );
    run = markDone(run, '0:a', { jobId: 'j', attempt: 1, clipId: 'gone', costUsd: 0.05 }, 4);
    const t = await harness(run);
    t.clips.set('gone', clip('gone', { source: 'upload' }));
    t.unusable.add('gone');
    await t.runner.advance();
    await settle();
    expect(t.sent).toEqual([]);
    const stored = await t.stored();
    expect(stored.status).toBe('paused');
    expect(stored.blocker).toMatchObject({ slotKey: '0:b', kind: 'source-missing' });
    expect(stored.message).toContain('gone.mp4, the clip it continues, is no longer available');
  });

  it('pauses when a step has fewer images than it had (lost in a reload)', async () => {
    const run = { ...newRun({ mode: 'independent' }), stepImages: { a: 2 } };
    const t = await harness(run);
    t.images.set('a', 0);
    await t.runner.advance();
    await settle();
    const stored = await t.stored();
    expect(stored.blocker).toMatchObject({ slotKey: '0:a', kind: 'images-lost' });
    expect(t.sent.map((body) => body.prompt)).not.toContain('Step a');
  });

  it('sends a step whose images the user removed on purpose (the stored count follows them)', async () => {
    const run = { ...newRun({ mode: 'independent' }), stepImages: {} };
    const t = await harness(run);
    await t.runner.advance();
    await settle();
    expect(t.sent.map((body) => body.prompt)).toContain('Step a');
  });

  it('a start failure follows the failure rule: skip goes on, stop stops', async () => {
    const failing = { problem: (stepId: string) => (stepId === 'a' ? 'Remove 1.' : null) };
    const skip = await harness({
      ...newRun({ mode: 'independent', onFailure: 'skip' }),
      stepImages: { a: 1 },
    });
    skip.images.set('a', 1);
    skip.deps.images.problem = failing.problem;
    await skip.runner.advance();
    await settle();
    const skipped = await skip.stored();
    expect(skipped.slots[0]).toMatchObject({ status: 'failed', error: 'Step 1: Remove 1.' });
    expect(skipped.status).toBe('running');
    expect(skip.sent.map((body) => body.prompt)).toEqual(['Step b', 'Step c']);

    const stop = await harness({ ...newRun({ onFailure: 'stop' }), stepImages: { a: 1 } });
    stop.images.set('a', 1);
    stop.deps.images.problem = failing.problem;
    await stop.runner.advance();
    await settle();
    expect((await stop.stored()).status).toBe('stopped');
    expect(stop.sent).toEqual([]);
  });

  it('pauses for errors that need the user (no key), and reports them', async () => {
    const t = await harness(newRun(), { beginRun: () => Promise.reject(new NoKeyError()) });
    await t.runner.advance();
    await settle();
    const stored = await t.stored();
    expect(stored.status).toBe('paused');
    expect(stored.message).toContain('Paused before step 1: Add an OpenRouter key');
    expect(stored.slots[0]?.status).toBe('pending');
    expect(t.reported).toHaveLength(1);
  });

  it('a send that may have reached OpenRouter counts as spent and is never sent again by itself', async () => {
    // The API client marks a paid request that may have gone through (`outcomeUnknown`).
    const unknown = <E extends ApiError | NetworkError>(error: E): E => {
      error.outcomeUnknown = true;
      return error;
    };
    const t = await harness(newRun({ onFailure: 'skip', capUsd: 1 }), {
      submit: () => Promise.reject(unknown(new NetworkError())),
    });
    await t.runner.advance();
    await settle();
    const stored = await t.stored();
    expect(stored.slots[0]).toMatchObject({
      status: 'failed',
      spentUsd: 0.05,
      spentEstimated: true,
    });
    expect(billedBy(new ApiError('Bad', 400))).toBe('no');
    expect(billedBy(new ApiError('Busy', 503))).toBe('no');
    expect(billedBy(unknown(new ApiError('Gateway', 502)))).toBe('maybe');
    // Not marked: the client knows nothing was billed (an all-free request).
    expect(billedBy(new ApiError('Gateway', 502))).toBe('no');
    expect(billedBy(new NetworkError())).toBe('no');
    // Stopped while the request was on its way: it may have arrived.
    expect(billedBy(abortError())).toBe('maybe');
    // Accepted by OpenRouter, then not followed here (its job could not be stored).
    const lost = new NoKeyError();
    markSent(lost);
    expect(billedBy(lost)).toBe('maybe');
  });

  it('refuses a step that would send only a last frame', async () => {
    const run = {
      ...newRun(
        { mode: 'independent', steps: [{ id: 'a', prompt: 'End here', imageRole: 'last-frame' }] },
        null,
        'seedance',
      ),
      stepImages: { a: 1 },
    };
    const t = await harness(run);
    t.images.set('a', 1);
    await t.runner.advance();
    await settle();
    expect(t.sent).toEqual([]);
    expect((await t.stored()).slots[0]?.error).toContain('without starting from one');
  });

  it('recovers starts of closed tabs only: adopts their job, or fails them as maybe billed', async () => {
    let run = newRun({ mode: 'independent' });
    run = claim(run, '0:a', 0.05, 2, 'gone-tab')!;
    run = claim(run, '0:b', 0.05, 2, 'gone-tab')!;
    run = claim(run, '0:c', 0.05, 2, 'live-tab')!;
    const t = await harness(run, {
      claimAlive: (slot) => Promise.resolve(slot.claimedBy === 'live-tab'),
    });
    const queued = {
      id: 'job-b',
      runId: 'run-b',
      state: 'running',
      payload: { v: 1, model: 'grok', sequenceId: 'seq', slotKey: '0:b', attempt: 1 },
    } as unknown as JobRecord;
    await t.runner.recover([queued]);
    const stored = await t.stored();
    expect(stored.slots[0]).toMatchObject({ status: 'failed', spentEstimated: true });
    expect(stored.slots[1]).toMatchObject({ status: 'running', jobId: 'job-b' });
    expect(stored.slots[2]?.status).toBe('starting');
    expect(stored.status).toBe('paused');
  });
});
