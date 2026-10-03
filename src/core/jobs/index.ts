/**
 * Persistent job queue (IndexedDB `jobs`) for long-running remote work such as video generation. Polling
 * survives reloads (`resume()` at page start) and only one tab polls a job at a time: the poller holds the
 * Web Lock `ortoolbox:job:<id>` (requested with `ifAvailable`); other tabs retry at the poll interval, so one
 * of them takes over when the polling tab closes. Without the Web Locks API every tab polls.
 *
 * Failures: storage errors are logged and retried with backoff. A poll error backs off (×2 per failure, up
 * to 60 s) and counts in `attempts`; a non-retryable error (4xx other than 408/429, no key, invalid input)
 * or MAX_POLL_FAILURES failures in a row mark the job `failed`. KeyLockedError pauses polling until the
 * keys change (unlock) instead. Results are applied with a read-modify-write that skips jobs that became
 * final meanwhile, so a cancel from another tab is never overwritten by a late poll.
 */

import type {
  CoreServices,
  JobHandler,
  JobPollResult,
  JobRecord,
  JobState,
  JobsService,
} from '../types';
import { ApiError, InvalidInputError, KeyLockedError, OrError, userMessage } from '../errors';
import { getDb } from '../storage/db';
import { MAX_TIMEOUT_MS, sleep } from '../util';
import { getTool } from '../../tools/registry';

export const DEFAULT_POLL_MS = 5000;
export const MAX_POLL_MS = 60_000;
export const MAX_POLL_FAILURES = 20;

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

/** The Web Locks API, or null where it is missing or refused. */
export function webLocks(): LockManager | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/** Browser notification on completion, only when the page is hidden and permission was already granted. */
function notifyCompletion(job: JobRecord): void {
  try {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const name = getTool(job.tool).name;
    const ok = job.state === 'succeeded';
    new Notification(ok ? `${name}: finished` : `${name}: failed`, {
      body: ok ? 'Your result is ready.' : (job.error ?? 'The job failed.'),
      tag: `ortoolbox-job-${job.id}`,
    });
  } catch {
    // Some browsers only allow notifications from a service worker; the in-page state still updates.
  }
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

  const read = async (id: string): Promise<JobRecord | undefined> =>
    remember(await (await getDb()).get('jobs', id));

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
    const done = await write(
      job.id,
      result.state === 'succeeded'
        ? { state: 'succeeded', result: result.result, error: null }
        : { state: 'failed', error: result.error },
      true,
    );
    if (done) notifyCompletion(done);
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
          if (permanent) Object.assign(patch, { state: 'failed', error: userMessage(error) });
          const done = await write(id, patch, true);
          if (permanent && done) notifyCompletion(done);
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
        .map(remember)
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
