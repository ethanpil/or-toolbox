import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_MS, JOB_COST_META, MAX_JOB_AGE_MS, MAX_POLL_FAILURES, MAX_POLL_MS } from '.';
import type { CoreServices, JobPollResult, JobRecord } from '../types';
import { ApiError, InvalidInputError, KeyLockedError, NetworkError, type OrError } from '../errors';
import { getDb } from '../storage/db';
import {
  FakeLockManager,
  createTestCore,
  isolateChannels,
  resetDb,
  settle,
  until,
} from '../testing/state-fakes';

type Step = JobPollResult<string> | Error | Promise<JobPollResult<string>>;

/** A handler that answers each poll with the next scripted step (then "running" forever). */
function scripted(steps: Step[] = [], intervalMs?: number | ((job: JobRecord) => number)) {
  const poll = vi.fn((job: JobRecord<unknown, string>, signal: AbortSignal) => {
    void job;
    void signal;
    const step = steps.shift() ?? { state: 'running' as const };
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  });
  return { poll, intervalMs };
}

const input = {
  tool: 'video-studio' as const,
  type: 'video',
  payload: { prompt: 'a cat' },
  keyId: 'k1',
  remoteId: 'vid-1',
};

let core: CoreServices;
let locks: FakeLockManager;

const job = async (id: string) => (await getDb()).get('jobs', id);

/** Advance fake time, then let IndexedDB and the poll loops catch up. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

function setLocks(value: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', { value, configurable: true });
}

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  locks = new FakeLockManager();
  setLocks(locks);
  core = createTestCore().core;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setLocks(undefined);
});

describe('polling', () => {
  it('polls a new job right away, records progress and the result, then stops', async () => {
    const handler = scripted([
      { state: 'running', progress: 0.5, remoteStatus: 'in_progress' },
      { state: 'succeeded', result: 'clip-url' },
    ]);
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    expect(added).toMatchObject({ state: 'queued', remoteId: 'vid-1', attempts: 0, result: null });

    await until(async () => (await job(added.id))?.progress === 0.5);
    expect(await job(added.id)).toMatchObject({ state: 'running', remoteStatus: 'in_progress' });
    await settle();

    await advance(DEFAULT_POLL_MS - 1);
    expect(handler.poll).toHaveBeenCalledTimes(1);
    await advance(1);
    await until(async () => (await job(added.id))?.state === 'succeeded');
    expect(await job(added.id)).toMatchObject({
      result: 'clip-url',
      error: null,
      failureKind: null,
    });

    await advance(120_000);
    expect(handler.poll).toHaveBeenCalledTimes(2);
    expect(locks.held.size).toBe(0);
  });

  it('records a failure reported by the handler as remote', async () => {
    core.jobs.register('video', scripted([{ state: 'failed', error: 'Content policy' }]));
    const added = await core.jobs.add(input);
    await until(async () => (await job(added.id))?.state === 'failed');
    expect(await job(added.id)).toMatchObject({ error: 'Content policy', failureKind: 'remote' });
  });

  it('uses the handler interval, fixed or per job', async () => {
    const fixed = scripted([], 1000);
    core.jobs.register('fixed', fixed);
    await core.jobs.add({ ...input, type: 'fixed' });
    const perJob = scripted([], (j) => ((j.payload as { slow?: boolean }).slow ? 30_000 : 2000));
    core.jobs.register('per-job', perJob);
    await core.jobs.add({ ...input, type: 'per-job', payload: { slow: true } });
    await settle();

    for (let i = 0; i < 10; i++) await advance(1000);
    expect(fixed.poll).toHaveBeenCalledTimes(11);
    expect(perJob.poll).toHaveBeenCalledTimes(1);
    await advance(20_000);
    expect(perJob.poll).toHaveBeenCalledTimes(2);
  });

  it('backs off on errors up to 60 s, counts attempts, and recovers', async () => {
    const handler = scripted([
      new Error('1'),
      new Error('2'),
      new Error('3'),
      new Error('4'),
      { state: 'running', progress: 0.1 },
    ]);
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    await until(async () => (await job(added.id))?.attempts === 1);
    await settle();

    const expectCallsAfter = async (ms: number, calls: number) => {
      await advance(ms - 1);
      expect(handler.poll).toHaveBeenCalledTimes(calls - 1);
      await advance(1);
      expect(handler.poll).toHaveBeenCalledTimes(calls);
    };
    await expectCallsAfter(10_000, 2);
    await expectCallsAfter(20_000, 3);
    await expectCallsAfter(40_000, 4);
    await expectCallsAfter(60_000, 5); // 80 s capped at 60 s
    expect((await job(added.id))?.attempts).toBe(4);
    await expectCallsAfter(DEFAULT_POLL_MS, 6); // success resets the backoff
  });
});

describe('resume, cancel and changes', () => {
  async function seed(partial: Partial<JobRecord>): Promise<JobRecord> {
    const record: JobRecord = {
      id: crypto.randomUUID(),
      tool: 'video-studio',
      type: 'video',
      state: 'running',
      runId: null,
      keyId: 'k1',
      remoteId: 'r',
      groupId: null,
      payload: {},
      result: null,
      progress: null,
      remoteStatus: null,
      error: null,
      failureKind: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      ...partial,
    };
    await (await getDb()).put('jobs', record);
    return record;
  }

  it('reads records stored before failureKind existed as null', async () => {
    const old: Partial<JobRecord> = { ...(await seed({ state: 'failed', error: 'x' })) };
    delete old.failureKind;
    await (await getDb()).put('jobs', old as JobRecord);
    expect((await core.jobs.get(old.id!))?.failureKind).toBeNull();
    expect((await core.jobs.list()).map((j) => j.failureKind)).toEqual([null]);
    const seen: JobRecord[] = [];
    core.jobs.subscribe((j) => seen.push(j));
    core.bus.emit({ type: 'jobs-changed', id: old.id! });
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ state: 'failed', failureKind: null });
  });

  it('clears the failure kind when a job leaves the failed state', async () => {
    const failed = await seed({ state: 'failed', error: 'x', failureKind: 'gave-up' });
    expect((await core.jobs.update(failed.id, { payload: { delivered: true } })).failureKind).toBe(
      'gave-up',
    );
    expect((await core.jobs.update(failed.id, { state: 'cancelled' })).failureKind).toBeNull();
  });

  it('resumes only open jobs of registered types after a reload', async () => {
    const open = await seed({ state: 'running' });
    const queued = await seed({ state: 'queued' });
    await seed({ state: 'succeeded' });
    await seed({ state: 'running', type: 'unregistered' });

    const page = createTestCore().core;
    const handler = scripted();
    page.jobs.register('video', handler);
    page.jobs.resume();
    page.jobs.resume(); // idempotent
    await until(() => handler.poll.mock.calls.length === 2);
    await settle();
    expect(handler.poll.mock.calls.map(([j]) => j.id).sort()).toEqual([open.id, queued.id].sort());
  });

  it('cancel stops polling and marks the job cancelled', async () => {
    const handler = scripted();
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    await until(() => handler.poll.mock.calls.length === 1);
    await core.jobs.cancel(added.id);
    expect((await job(added.id))?.state).toBe('cancelled');
    await advance(60_000);
    expect(handler.poll).toHaveBeenCalledTimes(1);
  });

  it('never lets a late poll overwrite a cancel from another tab', async () => {
    let answer!: (result: JobPollResult<string>) => void;
    const pending = new Promise<JobPollResult<string>>((resolve) => (answer = resolve));
    core.jobs.register('video', scripted([pending]));
    const added = await core.jobs.add(input);
    await settle();

    await createTestCore().core.jobs.cancel(added.id); // another tab
    answer({ state: 'succeeded', result: 'too late' });
    await settle();
    expect(await job(added.id)).toMatchObject({ state: 'cancelled', result: null });
  });

  it('updates, lists, gets and removes', async () => {
    const a = await core.jobs.add({ ...input, groupId: 'seq' });
    vi.setSystemTime(Date.now() + 10);
    const b = await core.jobs.add({ ...input, tool: 'chat', groupId: 'seq' });
    const updated = await core.jobs.update(a.id, {
      state: 'running',
      progress: 0.3,
      remoteStatus: 'x',
    });
    expect(updated).toMatchObject({ id: a.id, progress: 0.3, createdAt: a.createdAt });
    expect(await core.jobs.get(a.id)).toEqual(updated);

    expect((await core.jobs.list()).map((j) => j.id)).toEqual([a.id, b.id]);
    expect((await core.jobs.list({ tool: 'chat' })).map((j) => j.id)).toEqual([b.id]);
    expect((await core.jobs.list({ groupId: 'seq', states: ['queued'] })).map((j) => j.id)).toEqual(
      [b.id],
    );
    await core.jobs.remove(a.id);
    expect(await core.jobs.get(a.id)).toBeUndefined();
    await expect(core.jobs.update(a.id, {})).rejects.toThrow('no longer exists');
  });

  it('notifies subscribers with the job on every change, from any tab', async () => {
    const seen: string[] = [];
    core.jobs.subscribe((j) => seen.push(`${j.id}:${j.state}`));
    const added = await core.jobs.add(input);
    await createTestCore().core.jobs.update(added.id, { state: 'running' });
    await until(() => seen.length === 2);
    expect(seen).toEqual([`${added.id}:queued`, `${added.id}:running`]);
  });
});

describe('one tab polls a job at a time', () => {
  it('lets only the lock holder poll, and another tab takes over when it goes away', async () => {
    const tabA = core;
    const tabB = createTestCore().core;
    let hang = false;
    const pollA = vi.fn(() =>
      hang ? new Promise<never>(() => undefined) : Promise.resolve({ state: 'running' as const }),
    );
    const handlerB = scripted();
    tabA.jobs.register('video', { poll: pollA });
    tabB.jobs.register('video', handlerB);
    tabA.jobs.resume();
    tabB.jobs.resume();

    const added = await tabA.jobs.add(input);
    await until(() => pollA.mock.calls.length === 1);
    await settle();
    for (let i = 0; i < 4; i++) await advance(DEFAULT_POLL_MS);
    expect(pollA).toHaveBeenCalledTimes(5);
    expect(handlerB.poll).not.toHaveBeenCalled();

    // Tab A freezes and its lock is released, as when the tab closes.
    hang = true;
    await advance(DEFAULT_POLL_MS);
    locks.held.delete(`ortoolbox:job:${added.id}`);
    await advance(DEFAULT_POLL_MS);
    await advance(DEFAULT_POLL_MS);
    expect(handlerB.poll).toHaveBeenCalled();
  });

  it('polls without the lock where the Web Locks API is missing', async () => {
    setLocks(undefined);
    const tabB = createTestCore().core;
    const handlerA = scripted();
    const handlerB = scripted();
    core.jobs.register('video', handlerA);
    tabB.jobs.register('video', handlerB);
    tabB.jobs.resume();
    await core.jobs.add(input);
    await until(() => handlerA.poll.mock.calls.length >= 1 && handlerB.poll.mock.calls.length >= 1);
  });
});

describe('completion notification', () => {
  const NotificationSpy = vi.fn();
  const requestPermission = vi.fn();

  function stubNotification(permission: NotificationPermission): void {
    NotificationSpy.mockClear();
    requestPermission.mockClear();
    vi.stubGlobal(
      'Notification',
      Object.assign(
        function Notification(title: string, options: NotificationOptions) {
          NotificationSpy(title, options);
        },
        { permission, requestPermission },
      ),
    );
  }

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  }
  afterEach(() => setVisibility('visible'));

  async function complete(notify?: boolean): Promise<void> {
    core.jobs.register('video', scripted([{ state: 'succeeded', result: 'ok' }]));
    const added = await core.jobs.add({ ...input, notify });
    await until(async () => (await job(added.id))?.state === 'succeeded');
    await settle();
  }

  it('notifies a job that opted in when the page is hidden and permission is granted', async () => {
    stubNotification('granted');
    setVisibility('hidden');
    await complete(true);
    expect(NotificationSpy).toHaveBeenCalledExactlyOnceWith(
      'Video studio: finished',
      expect.objectContaining({ body: 'Your result is ready.' }),
    );
  });

  it('still notifies a job whose tool this build does not know', async () => {
    stubNotification('granted');
    setVisibility('hidden');
    core.jobs.register('video', scripted([{ state: 'succeeded', result: 'ok' }]));
    const added = await core.jobs.add({
      ...input,
      tool: 'removed-tool' as typeof input.tool,
      notify: true,
    });
    await until(async () => (await job(added.id))?.state === 'succeeded');
    await settle();
    expect(NotificationSpy).toHaveBeenCalledExactlyOnceWith(
      'Job: finished',
      expect.objectContaining({ body: 'Your result is ready.' }),
    );
  });

  it('never notifies a job that did not opt in', async () => {
    stubNotification('granted');
    setVisibility('hidden');
    await complete();
    expect(NotificationSpy).not.toHaveBeenCalled();
  });

  it('stays quiet when the page is visible', async () => {
    stubNotification('granted');
    await complete(true);
    expect(NotificationSpy).not.toHaveBeenCalled();
  });

  it('never asks for permission', async () => {
    stubNotification('default');
    setVisibility('hidden');
    await complete(true);
    expect(NotificationSpy).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('says when it gave up rather than that the job failed', async () => {
    stubNotification('granted');
    setVisibility('hidden');
    core.jobs.register('video', scripted([new ApiError('Video not found', 404)]));
    const added = await core.jobs.add({ ...input, notify: true });
    await until(async () => (await job(added.id))?.state === 'failed');
    await settle();
    expect(NotificationSpy).toHaveBeenCalledExactlyOnceWith(
      'Video studio: stopped checking',
      expect.objectContaining({ body: 'Video not found' }),
    );
  });

  it("shows one notification for a 'group' once none of its jobs is open, at most once", async () => {
    stubNotification('granted');
    setVisibility('hidden');
    const answers: Record<string, JobPollResult<string>> = {};
    core.jobs.register('video', {
      poll: (j: JobRecord) => {
        const n = (j.payload as { n: string }).n;
        return Promise.resolve(answers[n] ?? { state: 'running' as const });
      },
    });
    const add = (n: string) =>
      core.jobs.add({ ...input, payload: { n }, groupId: 'seq', notify: 'group' });
    const a = await add('a');
    const b = await add('b');
    await core.jobs.add({ ...input, payload: { n: 'other' }, groupId: 'other' }); // never notifies
    await until(async () => (await job(b.id))?.state === 'running');
    await settle();

    answers['a'] = { state: 'succeeded', result: 'ok' };
    answers['other'] = { state: 'succeeded', result: 'ok' };
    await advance(DEFAULT_POLL_MS);
    await until(async () => (await job(a.id))?.state === 'succeeded');
    await settle();
    expect(NotificationSpy).not.toHaveBeenCalled(); // b is still open

    answers['b'] = { state: 'failed', error: 'Content policy' };
    await advance(DEFAULT_POLL_MS);
    await until(async () => (await job(b.id))?.state === 'failed');
    await settle();
    expect(NotificationSpy).toHaveBeenCalledExactlyOnceWith(
      'Video studio: finished with failures',
      expect.objectContaining({ body: '1 ready, 1 failed.', tag: 'ortoolbox-job-group-seq' }),
    );

    const c = await add('c'); // a re-run in the same group
    answers['c'] = { state: 'succeeded', result: 'ok' };
    await until(async () => (await job(c.id))?.state === 'succeeded');
    await settle();
    expect(NotificationSpy).toHaveBeenCalledOnce();
  });
});

describe("booking a job's cost on its run", () => {
  const begin = () =>
    core.runs.begin({ tool: 'video-studio', model: 'v/video', prompt: 'a cat', estimateUsd: 0.5 });

  async function startJob(steps: Step[]) {
    const run = await begin();
    core.jobs.register('video', scripted(steps));
    const added = await core.jobs.add({ ...input, runId: run.id });
    run.handOff(added.id);
    return { run, added };
  }

  it('books the usage of a succeeded job before the job is final, so a failed download still counts', async () => {
    // Another tab sees the job succeed, re-attaches the run and fails it (its download failed).
    const other = createTestCore().core;
    let claimed = false;
    let costSeen = -1;
    other.jobs.subscribe((j) => {
      if (j.state !== 'succeeded' || claimed) return;
      claimed = true;
      void other.runs.reattach(j.runId!).then((handle) => {
        costSeen = handle!.totals.costUsd;
        return handle!.fail(new Error('The download failed.'));
      });
    });
    const { run } = await startJob([
      { state: 'succeeded', result: 'clip', usage: { costUsd: 0.2 } },
    ]);
    await until(async () => (await (await getDb()).get('runs', run.id))?.status === 'error');
    expect(costSeen).toBeCloseTo(0.2);
    expect(await (await getDb()).get('runs', run.id)).toMatchObject({
      usage: { requests: 1, costUsd: 0.2, costUnknown: false },
    });
    expect(await core.stats.monthSpend()).toBeCloseTo(0.2);
  });

  it('books the reservation when the provider reported no cost', async () => {
    const { run, added } = await startJob([
      { state: 'succeeded', result: 'clip', usage: { costUsd: null } },
    ]);
    await until(async () => (await job(added.id))?.state === 'succeeded');
    await (await core.runs.reattach(run.id))!.finish();
    expect(await core.stats.monthSpend()).toBeCloseTo(0.5);
  });

  it('never books twice when the final write is retried', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the right `this` below
    const original = IDBObjectStore.prototype.put;
    let failed = false;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      const record = args[0] as JobRecord;
      if (this.name === 'jobs' && record.state === 'succeeded' && !failed) {
        failed = true;
        throw new DOMException('io', 'UnknownError');
      }
      return original.apply(this, args);
    });
    const succeeded = { state: 'succeeded', result: 'clip', usage: { costUsd: 0.2 } } as const;
    const { run, added } = await startJob([succeeded, succeeded]);
    await until(() => failed);
    await settle();
    await advance(MAX_POLL_MS);
    await until(async () => (await job(added.id))?.state === 'succeeded');
    await (await core.runs.reattach(run.id))!.finish();
    expect(await core.stats.monthSpend()).toBeCloseTo(0.2);
  });

  it('leaves the cost to the tool when the handler reports none', async () => {
    const { run, added } = await startJob([{ state: 'succeeded', result: 'clip' }]);
    await until(async () => (await job(added.id))?.state === 'succeeded');
    const handle = (await core.runs.reattach(run.id))!;
    expect(handle.totals.requests).toBe(0);
    handle.addUsage({
      model: handle.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0.3,
      costEstimated: false,
      latencyMs: 1,
    });
    await handle.finish();
    expect(await core.stats.monthSpend()).toBeCloseTo(0.3);
  });

  it('never books twice when another tab takes the job over after the cost was stored', async () => {
    // Tab A stored the cost on the run, then closed before it could mark the job final.
    const run = await begin();
    const added = await core.jobs.add({ ...input, runId: run.id });
    run.handOff(added.id);
    const marked = run.checkpoint({ meta: { [JOB_COST_META]: added.id } });
    run.addUsage({
      model: run.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0.2,
      costEstimated: false,
      latencyMs: 1,
    });
    await marked;
    locks.release(`ortoolbox:run:${run.id}`);

    // Tab B polls the job, sees it succeed, and finishes the run.
    const other = createTestCore().core;
    other.jobs.register(
      'video',
      scripted([{ state: 'succeeded', result: 'clip', usage: { costUsd: 0.2 } }]),
    );
    other.jobs.resume();
    await until(async () => (await job(added.id))?.state === 'succeeded');
    await (await other.runs.reattach(run.id))!.finish();
    expect(await core.stats.monthSpend()).toBeCloseTo(0.2);
  });

  it('gives a job up after MAX_JOB_AGE_MS, booking its reservation', async () => {
    const run = await begin();
    core.jobs.register('video', scripted([], 30 * 60_000));
    const added = await core.jobs.add({ ...input, runId: run.id });
    run.handOff(added.id);
    for (let elapsed = 0; elapsed <= MAX_JOB_AGE_MS; elapsed += 30 * 60_000) {
      await advance(30 * 60_000);
    }
    await until(async () => (await job(added.id))?.state === 'failed');
    expect(await job(added.id)).toMatchObject({
      failureKind: 'gave-up',
      error: 'Stopped checking: the job did not finish in time.',
    });
    await (await core.runs.reattach(run.id))!.fail(new Error('gave up'));
    expect(await core.stats.monthSpend()).toBeCloseTo(0.5);
  });

  it('books the reservation when it gives up, and nothing for a remote failure', async () => {
    const gaveUp = await startJob([new ApiError('Video not found', 404)]);
    await until(async () => (await job(gaveUp.added.id))?.failureKind === 'gave-up');
    await (await core.runs.reattach(gaveUp.run.id))!.fail(new Error('Video not found'));
    expect(await core.stats.monthSpend()).toBeCloseTo(0.5);

    const remote = await startJob([{ state: 'failed', error: 'Content policy' }]);
    await until(async () => (await job(remote.added.id))?.failureKind === 'remote');
    await (await core.runs.reattach(remote.run.id))!.fail(new Error('Content policy'));
    expect(await core.stats.monthSpend()).toBeCloseTo(0.5);
  });
});

describe('poll failures', () => {
  it('keeps polling after a storage error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = scripted();
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    await until(() => handler.poll.mock.calls.length === 1);
    await settle();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the right `this` below
    const original = IDBObjectStore.prototype.get;
    let failures = 1;
    vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['get']>
    ) {
      if (this.name === 'jobs' && failures-- > 0) throw new DOMException('io', 'UnknownError');
      return original.apply(this, args);
    });
    await advance(DEFAULT_POLL_MS); // the read fails: back off
    expect(handler.poll).toHaveBeenCalledTimes(1);
    await advance(2 * DEFAULT_POLL_MS);
    expect(handler.poll).toHaveBeenCalledTimes(2);
    expect((await job(added.id))?.state).toBe('running');
  });

  it('fails the job on a non-retryable API error', async () => {
    core.jobs.register('video', scripted([new ApiError('Video not found', 404)]));
    const added = await core.jobs.add(input);
    await until(async () => (await job(added.id))?.state === 'failed');
    expect((await job(added.id))?.error).toBe('Video not found');
  });

  it('fails the job after 20 failed polls in a row', async () => {
    const handler = scripted(Array.from({ length: 30 }, () => new NetworkError()));
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    for (let i = 0; i < 25 && (await job(added.id))?.state !== 'failed'; i++) {
      await settle();
      await advance(MAX_POLL_MS);
    }
    expect(handler.poll).toHaveBeenCalledTimes(MAX_POLL_FAILURES);
    expect(await job(added.id)).toMatchObject({
      state: 'failed',
      attempts: MAX_POLL_FAILURES,
      error: 'Network error. Check your connection and try again.',
    });
  });

  it('pauses while the keys are locked and resumes when they change', async () => {
    const handler = scripted([new KeyLockedError(), { state: 'succeeded', result: 'ok' }]);
    core.jobs.register('video', handler);
    const added = await core.jobs.add(input);
    await until(() => handler.poll.mock.calls.length === 1);
    await advance(10 * MAX_POLL_MS);
    expect(handler.poll).toHaveBeenCalledTimes(1);
    expect((await job(added.id))?.state).toBe('queued');

    core.bus.emit({ type: 'keys-changed' }); // unlocked
    await until(async () => (await job(added.id))?.state === 'succeeded');
  });

  it('reports a missing job with an OrError', async () => {
    const error = (await core.jobs.update('missing', {}).catch((e: unknown) => e)) as OrError;
    expect(error).toBeInstanceOf(InvalidInputError);
    expect(error.code).toBe('invalid-input');
  });
});
