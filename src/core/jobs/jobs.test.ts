import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_POLL_MS, MAX_POLL_FAILURES, MAX_POLL_MS } from '.';
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
    expect(await job(added.id)).toMatchObject({ result: 'clip-url', error: null });

    await advance(120_000);
    expect(handler.poll).toHaveBeenCalledTimes(2);
    expect(locks.held.size).toBe(0);
  });

  it('records a failure reported by the handler', async () => {
    core.jobs.register('video', scripted([{ state: 'failed', error: 'Content policy' }]));
    const added = await core.jobs.add(input);
    await until(async () => (await job(added.id))?.state === 'failed');
    expect((await job(added.id))?.error).toBe('Content policy');
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
      createdAt: Date.now(),
      updatedAt: Date.now(),
      attempts: 0,
      ...partial,
    };
    await (await getDb()).put('jobs', record);
    return record;
  }

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

  async function complete(): Promise<void> {
    core.jobs.register('video', scripted([{ state: 'succeeded', result: 'ok' }]));
    const added = await core.jobs.add(input);
    await until(async () => (await job(added.id))?.state === 'succeeded');
  }

  it('notifies when the page is hidden and permission is granted', async () => {
    stubNotification('granted');
    setVisibility('hidden');
    await complete();
    expect(NotificationSpy).toHaveBeenCalledExactlyOnceWith(
      'Video studio: finished',
      expect.objectContaining({ body: 'Your result is ready.' }),
    );
  });

  it('stays quiet when the page is visible', async () => {
    stubNotification('granted');
    await complete();
    expect(NotificationSpy).not.toHaveBeenCalled();
  });

  it('never asks for permission', async () => {
    stubNotification('default');
    setVisibility('hidden');
    await complete();
    expect(NotificationSpy).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
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
