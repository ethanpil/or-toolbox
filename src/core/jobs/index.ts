/**
 * Persistent job queue (IndexedDB `jobs`) for long-running remote work such as video generation. Polling
 * survives reloads (`resume()` at page start) and only one tab polls a job at a time: the poller holds the
 * Web Lock `ortoolbox:job:<id>` (requested with `ifAvailable`); other tabs retry at the poll interval, so one
 * of them takes over when the polling tab closes. Without the Web Locks API every tab polls.
 *
 * Failures: storage errors are logged and retried with backoff. A poll error backs off (×2 per failure, up
 * to 60 s) and counts in `attempts`; a non-retryable error (4xx other than 408/429, no key, invalid input)
 * or MAX_POLL_FAILURES failures in a row mark the job `failed` with `failureKind: 'gave-up'` (a handler's own
 * `failed` is `'remote'`), and so does a job still running MAX_JOB_AGE_MS after it was added (a remote status
 * that never ends). KeyLockedError pauses polling until the keys change (unlock) instead. Results are
 * applied with a read-modify-write that skips jobs that became final meanwhile, so a cancel from another tab is
 * never overwritten by a late poll.
 *
 * Cost: before a job is marked final, its run (`runId`) is re-attached and given what the end says about cost:
 * a `succeeded` result's `usage`, or an unknown cost when the core gave up (the work may still bill). It is
 * stored before the job turns final, so whichever tab then finishes the run books it, and the same write marks
 * the run (`meta.jobCostBooked`), so a tab that takes the job over never books it twice.
 */

import type {
  CoreServices,
  JobHandler,
  JobPollResult,
  JobRecord,
  JobState,
  JobUsage,
  JobsService,
} from '../types';
import { ApiError, InvalidInputError, KeyLockedError, OrError, userMessage } from '../errors';
import { getDb } from '../storage/db';
import { HOUR_MS, MAX_TIMEOUT_MS, isFiniteNumber, sleep, webLocks } from '../util';
import { findTool } from '../../tools/registry';

export const DEFAULT_POLL_MS = 5000;
export const MAX_POLL_MS = 60_000;
export const MAX_POLL_FAILURES = 20;
/**
 * A job still running this long after it was added is given up (`JobHandler.maxAgeMs` overrides it). The probed
 * video jobs took about a minute, so 3 hours only ends a job whose remote status never ends (the API client reads
 * an unknown video status as pending).
 */
export const MAX_JOB_AGE_MS = 3 * HOUR_MS;
/** The run meta key that records which job's cost was booked on the run (see `bookOnRun`). */
export const JOB_COST_META = 'jobCostBooked';

const FINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];
export const isFinalState = (state: JobState): boolean => FINAL_STATES.includes(state);

type AnyHandler = JobHandler<unknown, unknown>;

/** The poll interval, doubled per consecutive failure, capped at MAX_POLL_MS. */
function intervalFor(handler: AnyHandler, job: JobRecord, failures: number): number {
  const base =
    typeof handler.intervalMs === 'function'
      ? handler.intervalMs(job)
      : (handler.intervalMs ?? DEFAULT_POLL_MS);
  return Math.min(Math.max(0, base) * 2 ** failures, MAX_POLL_MS);
}

/** Backoff after a storage error, before the job (and so its handler) is known. */
const backoff = (failures: number): number =>
  Math.min(DEFAULT_POLL_MS * 2 ** failures, MAX_POLL_MS);

/** Waits `ms`, or less if `signal` aborts. Never rejects. */
const pause = (ms: number, signal: AbortSignal): Promise<void> =>
  sleep(Math.min(ms, MAX_TIMEOUT_MS), signal).catch(() => undefined);

/** Errors that will not go away by polling again. */
function isPermanent(error: unknown): boolean {
  if (error instanceof ApiError) return !error.retryable;
  return (
    error instanceof OrError && ['no-key', 'invalid-key', 'invalid-input'].includes(error.code)
  );
}

/** Moved to util.ts; re-exported for the modules that import it from here. */
export { webLocks };

/** Records stored before `failureKind` existed read as null. */
const normalize = (job: JobRecord): JobRecord => ({ ...job, failureKind: job.failureKind ?? null });

/** Notifications are shown only while the page is hidden and permission was already granted (never asked). */
function canNotify(): boolean {
  try {
    return (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    );
  } catch {
    return false;
  }
}

function showNotification(title: string, body: string, tag: string): void {
  try {
    new Notification(title, { body, tag });
  } catch {
    // Some browsers only allow notifications from a service worker; the in-page state still updates.
  }
}

/** The tool's name; a job stored by a build that had a tool this one lacks is still announced. */
const toolName = (tool: string): string => findTool(tool)?.name ?? 'Job';

/** One job's notification: finished, failed (remote) or stopped checking (gave up). */
function notifyJob(job: JobRecord): void {
  const name = toolName(job.tool);
  const [title, body] =
    job.state === 'succeeded'
      ? [`${name}: finished`, 'Your result is ready.']
      : job.failureKind === 'gave-up'
        ? [`${name}: stopped checking`, job.error ?? 'The job stopped answering.']
        : [`${name}: failed`, job.error ?? 'The job failed.'];
  showNotification(title, body, `ortoolbox-job-${job.id}`);
}

/** A group's one notification, summing up its ended jobs (cancelled ones left out). */
function notifyGroup(job: JobRecord, group: JobRecord[], groupId: string): void {
  const name = toolName(job.tool);
  const ok = group.filter((j) => j.state === 'succeeded').length;
  const failed = group.filter((j) => j.state === 'failed').length;
  const title =
    failed === 0
      ? `${name}: finished`
      : ok === 0
        ? `${name}: failed`
        : `${name}: finished with failures`;
  const body =
    failed > 0
      ? `${ok} ready, ${failed} failed.`
      : ok === 1
        ? 'Your result is ready.'
        : `${ok} results are ready.`;
  showNotification(title, body, `ortoolbox-job-group-${groupId}`);
}

export function createJobsService(core: CoreServices): JobsService {
  const handlers = new Map<string, AnyHandler>();
  /** Jobs this tab is polling, or waiting for the lock to poll. */
  const pollers = new Map<string, AbortController>();
  /** The last record this tab saw of each job: the body of its tombstone when it is removed. */
  const known = new Map<string, JobRecord>();
  const subscribers = new Set<(job: JobRecord) => void>();
  let resumed = false;

  const changed = (id: string): void => core.bus.emit({ type: 'jobs-changed', id });

  /** Ids already reported removed, so a reset followed by per-job events reports each removal once. */
  const removed = new Set<string>();

  const remember = <T extends JobRecord | undefined>(job: T): T => {
    if (job) {
      known.set(job.id, job);
      removed.delete(job.id);
    }
    return job;
  };

  const read = async (id: string): Promise<JobRecord | undefined> => {
    const stored = await (await getDb()).get('jobs', id);
    return remember(stored && normalize(stored));
  };

  const dispatch = (job: JobRecord): void => {
    for (const fn of [...subscribers]) {
      try {
        fn(job);
      } catch (error) {
        console.error(error);
      }
    }
  };

  /** Reports a removed job once, as the last known record marked `removed`. */
  const tombstone = (id: string): void => {
    const last = known.get(id);
    known.delete(id);
    if (removed.has(id)) return;
    removed.add(id);
    // When this tab never saw the job, only id, state and removed are meaningful (see JobsService).
    dispatch({ ...(last ?? ({ id } as JobRecord)), state: 'cancelled', removed: true });
  };

  /** Read-modify-write; `onlyIfOpen` skips jobs that are already final. */
  const write = async (
    id: string,
    patch: Partial<JobRecord>,
    onlyIfOpen = false,
  ): Promise<JobRecord | undefined> => {
    const db = await getDb();
    const tx = db.transaction('jobs', 'readwrite');
    const stored = await tx.store.get(id);
    if (!stored || (onlyIfOpen && isFinalState(stored.state))) {
      await tx.done;
      return undefined;
    }
    const next: JobRecord = {
      ...stored,
      ...patch,
      id: stored.id,
      createdAt: stored.createdAt,
      updatedAt: Date.now(),
    };
    // Only a failed job has a failure kind (a cancelled, reopened or succeeded one has none).
    next.failureKind = next.state === 'failed' ? (next.failureKind ?? null) : null;
    await tx.store.put(next);
    await tx.done;
    remember(next);
    changed(id);
    return next;
  };

  /** Resolves on the next `keys-changed` (e.g. unlock), or when `signal` aborts. */
  const keysChanged = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = (): void => {
        off();
        signal.removeEventListener('abort', done);
        resolve();
      };
      const off = core.bus.on('keys-changed', done);
      signal.addEventListener('abort', done, { once: true });
    });

  /** Jobs whose cost this page has added to their run, so a retried final write never adds it twice. */
  const booked = new Set<string>();

  /**
   * Adds what a job's end says about cost to its run and waits until that is stored. Called before the job is
   * marked final, so a tab that finishes the run when it sees the job end (`runs.reattach`) books it too. The run's
   * meta records it (`JOB_COST_META`) in the same write as the cost, so a tab that takes the job over after this
   * one closed between that write and the job's final write never adds it again.
   */
  const bookOnRun = async (job: JobRecord, usage: JobUsage): Promise<void> => {
    if (!job.runId || booked.has(job.id)) return;
    const record = await (await getDb()).get('runs', job.runId);
    if (record?.meta?.[JOB_COST_META] === job.id) {
      booked.add(job.id);
      return;
    }
    const run = await core.runs.reattach(job.runId);
    if (!run) return; // already final
    const cost = isFiniteNumber(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null;
    booked.add(job.id);
    // The write starts here and reads the run's state when it happens, so it carries the usage added next too.
    const stored = run.checkpoint({ meta: { [JOB_COST_META]: job.id } });
    run.addUsage({
      model: run.model,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: cost ?? 0,
      costEstimated: cost !== null && usage.costEstimated === true,
      costUnknown: cost === null, // unknown is never free: the run books its reservation
      latencyMs: Math.max(0, Date.now() - job.createdAt),
    });
    await stored;
  };

  /** Groups this page has shown its one notification for. */
  const notifiedGroups = new Set<string>();

  /** The notification for a job that just ended by polling, if it opted in (`notify`). */
  const notifyEnd = async (job: JobRecord): Promise<void> => {
    if (!job.notify || !canNotify()) return;
    const groupId = job.notify === 'group' ? job.groupId : null;
    if (!groupId) return notifyJob(job);
    if (notifiedGroups.has(groupId)) return;
    const group = await (await getDb()).getAllFromIndex('jobs', 'groupId', groupId);
    if (notifiedGroups.has(groupId) || group.some((j) => !isFinalState(j.state))) return;
    notifiedGroups.add(groupId);
    notifyGroup(job, group, groupId);
  };

  const ended = (job: JobRecord | undefined): void => {
    if (job) void notifyEnd(job).catch((error: unknown) => console.error(error));
  };

  /** Writes a poll result; true when the job is now final (or gone). */
  const apply = async (job: JobRecord, result: JobPollResult<unknown>): Promise<boolean> => {
    if (result.state === 'running') {
      const progress = result.progress === undefined ? job.progress : result.progress;
      const remoteStatus = result.remoteStatus ?? job.remoteStatus;
      if (
        job.state !== 'running' ||
        progress !== job.progress ||
        remoteStatus !== job.remoteStatus
      ) {
        return !(await write(job.id, { state: 'running', progress, remoteStatus }, true));
      }
      return false;
    }
    if (result.state === 'succeeded' && result.usage) await bookOnRun(job, result.usage);
    ended(
      await write(
        job.id,
        result.state === 'succeeded'
          ? { state: 'succeeded', result: result.result, error: null }
          : { state: 'failed', error: result.error, failureKind: 'remote' },
        true,
      ),
    );
    return true;
  };

  const pollLoop = async (id: string, signal: AbortSignal): Promise<void> => {
    let failures = 0;
    while (!signal.aborted) {
      let job: JobRecord | undefined;
      try {
        job = await read(id);
      } catch (error) {
        console.error(error);
        await pause(backoff(++failures), signal);
        continue;
      }
      if (!job || isFinalState(job.state)) return;
      const handler = handlers.get(job.type);
      if (!handler) return;

      let result: JobPollResult<unknown>;
      try {
        result = await handler.poll(job, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof KeyLockedError) {
          await keysChanged(signal);
          continue;
        }
        failures++;
        const permanent = isPermanent(error) || failures >= MAX_POLL_FAILURES;
        try {
          const patch: Partial<JobRecord> = { attempts: job.attempts + 1 };
          if (permanent) {
            // The core gives up; the remote work may still finish and bill.
            await bookOnRun(job, { costUsd: null });
            Object.assign(patch, {
              state: 'failed',
              error: userMessage(error),
              failureKind: 'gave-up',
            });
          }
          const done = await write(id, patch, true);
          if (permanent) ended(done);
        } catch (storageError) {
          console.error(storageError);
        }
        if (permanent) return;
        await pause(intervalFor(handler, job, failures), signal);
        continue;
      }
      if (signal.aborted) return;
      failures = 0;

      try {
        if (await apply(job, result)) return;
        if (Date.now() - job.createdAt > (handler.maxAgeMs ?? MAX_JOB_AGE_MS)) {
          // The core gives up; the remote work may still finish and bill.
          await bookOnRun(job, { costUsd: null });
          ended(
            await write(
              id,
              {
                state: 'failed',
                error: 'Stopped checking: the job did not finish in time.',
                failureKind: 'gave-up',
              },
              true,
            ),
          );
          return;
        }
      } catch (error) {
        console.error(error);
        await pause(intervalFor(handler, job, ++failures), signal);
        continue;
      }
      await pause(intervalFor(handler, job, 0), signal);
    }
  };

  /** Polls under the job's lock; while another tab holds it, checks back at the poll interval. */
  const acquireAndPoll = async (id: string, signal: AbortSignal): Promise<void> => {
    const locks = webLocks();
    while (!signal.aborted) {
      const job = await read(id);
      const handler = job && handlers.get(job.type);
      if (!job || !handler || isFinalState(job.state)) return;
      if (!locks) return pollLoop(id, signal);

      let held = false;
      try {
        await locks.request(`ortoolbox:job:${id}`, { ifAvailable: true }, async (lock) => {
          if (!lock) return;
          held = true;
          await pollLoop(id, signal);
        });
      } catch {
        // The Locks API refused (e.g. an opaque origin): poll without it.
        if (!held) await pollLoop(id, signal);
        return;
      }
      if (held) return;
      await pause(intervalFor(handler, job, 0), signal);
    }
  };

  const startPolling = (job: JobRecord): void => {
    if (pollers.has(job.id) || isFinalState(job.state) || !handlers.has(job.type)) return;
    ensureWired(); // a data reset must be able to stop this poller
    const controller = new AbortController();
    pollers.set(job.id, controller);
    void acquireAndPoll(job.id, controller.signal)
      .catch((error: unknown) => console.error(error))
      .finally(() => {
        if (pollers.get(job.id) === controller) pollers.delete(job.id);
      });
  };

  const stopPolling = (id: string): void => {
    pollers.get(id)?.abort();
    pollers.delete(id);
  };

  let wired = false;
  const ensureWired = (): void => {
    if (wired) return;
    wired = true;
    core.bus.on('jobs-changed', ({ id }) => {
      if (!subscribers.size && (!resumed || pollers.has(id))) return;
      void read(id)
        .then((job) => {
          if (!job) {
            tombstone(id);
            return;
          }
          dispatch(job);
          // Jobs added or reopened in another tab: be ready to take over when that tab closes.
          if (resumed) startPolling(job);
        })
        .catch((error: unknown) => console.error(error));
    });
    // Everything was deleted (here or in another tab): stop polling and report every known job removed.
    core.bus.on('data-reset', () => {
      for (const id of [...pollers.keys()]) stopPolling(id);
      for (const id of [...known.keys()]) tombstone(id);
    });
  };

  return {
    register<P, R>(type: string, handler: JobHandler<P, R>) {
      handlers.set(type, handler as AnyHandler);
    },

    async add<P, R>(input: {
      tool: JobRecord['tool'];
      type: string;
      payload: P;
      keyId: string;
      remoteId?: string | null;
      runId?: string | null;
      groupId?: string | null;
      state?: JobState;
      notify?: JobRecord['notify'];
    }) {
      const now = Date.now();
      const job: JobRecord<P, R> = {
        id: crypto.randomUUID(),
        tool: input.tool,
        type: input.type,
        state: input.state ?? 'queued',
        runId: input.runId ?? null,
        keyId: input.keyId,
        remoteId: input.remoteId ?? null,
        groupId: input.groupId ?? null,
        payload: input.payload,
        result: null,
        progress: null,
        remoteStatus: null,
        error: null,
        failureKind: null,
        notify: input.notify ?? false,
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      };
      await (await getDb()).put('jobs', job);
      remember(job);
      changed(job.id);
      startPolling(job);
      return job;
    },

    async update<P, R>(id: string, patch: Partial<Omit<JobRecord<P, R>, 'id' | 'createdAt'>>) {
      const next = await write(id, patch);
      if (!next) throw new InvalidInputError('That job no longer exists.');
      if (isFinalState(next.state)) stopPolling(id);
      else startPolling(next);
      return next as JobRecord<P, R>;
    },

    async get<P, R>(id: string) {
      return (await read(id)) as JobRecord<P, R> | undefined;
    },

    async list(filter = {}) {
      const db = await getDb();
      // Narrow with the most selective index, then apply the remaining filters.
      const jobs =
        filter.groupId !== undefined
          ? await db.getAllFromIndex('jobs', 'groupId', filter.groupId)
          : filter.tool !== undefined
            ? await db.getAllFromIndex('jobs', 'tool', filter.tool)
            : filter.states !== undefined
              ? (
                  await Promise.all(
                    filter.states.map((state) => db.getAllFromIndex('jobs', 'state', state)),
                  )
                ).flat()
              : await db.getAll('jobs');
      return jobs
        .map((job) => remember(normalize(job)))
        .filter(
          (job) =>
            (filter.tool === undefined || job.tool === filter.tool) &&
            (filter.states === undefined || filter.states.includes(job.state)),
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    },

    async cancel(id) {
      stopPolling(id);
      await write(id, { state: 'cancelled' }, true);
    },

    async remove(id) {
      stopPolling(id);
      await (await getDb()).delete('jobs', id);
      changed(id);
    },

    resume() {
      resumed = true;
      ensureWired();
      void (async () => {
        const db = await getDb();
        for (const state of ['queued', 'running'] as const) {
          for (const job of await db.getAllFromIndex('jobs', 'state', state)) startPolling(job);
        }
      })().catch((error: unknown) => console.error(error));
    },

    subscribe(fn) {
      ensureWired();
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };
}
