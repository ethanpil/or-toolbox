/**
 * Persistent job queue (IndexedDB `jobs`) for long-running remote work such as video generation. Polling
 * survives reloads (`resume()` at page start) and only one tab polls a job at a time: the poller holds the
 * Web Lock `ortoolbox:job:<id>` (requested with `ifAvailable`); other tabs retry at the poll interval, so one
 * of them takes over when the polling tab closes. Without the Web Locks API every tab polls.
 *
 * `attempts` counts failed polls. Results are applied with a read-modify-write that skips jobs that became
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
import { getDb } from '../storage/db';
import { getTool } from '../../tools/registry';

export const DEFAULT_POLL_MS = 5000;
export const MAX_POLL_MS = 60_000;

const FINAL_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];
export const isFinalState = (state: JobState): boolean => FINAL_STATES.includes(state);

type AnyHandler = JobHandler<unknown, unknown>;

function intervalFor(handler: AnyHandler, job: JobRecord, errors: number): number {
  const base =
    typeof handler.intervalMs === 'function'
      ? handler.intervalMs(job)
      : (handler.intervalMs ?? DEFAULT_POLL_MS);
  return Math.min(Math.max(0, base) * 2 ** errors, MAX_POLL_MS);
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

function lockManager(): LockManager | null {
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
  let resumed = false;

  const changed = (id: string): void => core.bus.emit({ type: 'jobs-changed', id });

  const read = async (id: string): Promise<JobRecord | undefined> =>
    (await getDb()).get('jobs', id);

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
    changed(id);
    return next;
  };

  const pollLoop = async (id: string, signal: AbortSignal): Promise<void> => {
    let errors = 0;
    while (!signal.aborted) {
      const job = await read(id);
      if (!job || isFinalState(job.state)) return;
      const handler = handlers.get(job.type);
      if (!handler) return;

      let result: JobPollResult<unknown>;
      try {
        result = await handler.poll(job, signal);
      } catch {
        if (signal.aborted) return;
        errors++;
        await write(id, { attempts: job.attempts + 1 }, true);
        await sleep(intervalFor(handler, job, errors), signal);
        continue;
      }
      if (signal.aborted) return;
      errors = 0;

      if (result.state === 'running') {
        const progress = result.progress === undefined ? job.progress : result.progress;
        const remoteStatus = result.remoteStatus ?? job.remoteStatus;
        if (
          job.state !== 'running' ||
          progress !== job.progress ||
          remoteStatus !== job.remoteStatus
        ) {
          await write(id, { state: 'running', progress, remoteStatus }, true);
        }
      } else {
        const done = await write(
          id,
          result.state === 'succeeded'
            ? { state: 'succeeded', result: result.result, error: null }
            : { state: 'failed', error: result.error },
          true,
        );
        if (done) notifyCompletion(done);
        return;
      }
      await sleep(intervalFor(handler, job, 0), signal);
    }
  };

  /** Polls under the job's lock; while another tab holds it, checks back at the poll interval. */
  const acquireAndPoll = async (id: string, signal: AbortSignal): Promise<void> => {
    const locks = lockManager();
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
      await sleep(intervalFor(handler, job, 0), signal);
    }
  };

  const startPolling = (job: JobRecord): void => {
    if (pollers.has(job.id) || isFinalState(job.state) || !handlers.has(job.type)) return;
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
    // Jobs added or reopened in another tab: be ready to take over when that tab closes.
    core.bus.on('jobs-changed', ({ id }) => {
      if (!resumed || pollers.has(id)) return;
      void read(id).then((job) => {
        if (job) startPolling(job);
      });
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
      changed(job.id);
      startPolling(job);
      return job;
    },

    async update<P, R>(id: string, patch: Partial<Omit<JobRecord<P, R>, 'id' | 'createdAt'>>) {
      const next = await write(id, patch);
      if (!next) throw new Error(`Job ${id} not found.`);
      if (isFinalState(next.state)) stopPolling(id);
      else startPolling(next);
      return next as JobRecord<P, R>;
    },

    async get<P, R>(id: string) {
      return (await read(id)) as JobRecord<P, R> | undefined;
    },

    async list(filter = {}) {
      const all = await (await getDb()).getAll('jobs');
      return all
        .filter(
          (job) =>
            (filter.tool === undefined || job.tool === filter.tool) &&
            (filter.groupId === undefined || job.groupId === filter.groupId) &&
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
        for (const job of await (await getDb()).getAll('jobs')) startPolling(job);
      })().catch((error: unknown) => console.error(error));
    },

    subscribe(fn) {
      ensureWired();
      return core.bus.on('jobs-changed', ({ id }) => {
        void read(id).then((job) => {
          if (job) fn(job);
        });
      });
    },
  };
}
