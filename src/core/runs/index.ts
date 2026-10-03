/**
 * Runs: the gatekeeper for every model call (key, lock, free-only, budget), and the handle that collects
 * usage, checkpoints partial output and writes the final history record and stats rollups.
 *
 * - Reservations: `begin()` checks the budget and writes the `running` record holding `reservedUsd` inside
 *   one cross-tab Web Lock (`ortoolbox:budget`; an in-page queue where Web Locks are missing), so parallel
 *   runs in any tab see each other. A declined confirmation deletes the record again.
 * - Ownership: a live handle holds the Web Lock `ortoolbox:run:<id>` (or, without Web Locks, refreshes a
 *   heartbeat in `kv` `meta:run-heartbeat:<id>`). `sweep()` finalizes `running` records nobody owns.
 * - Writes are read-modify-write, serialised per handle, and never touch a record that is already final.
 *   The final record and its stats rows are written in one transaction, which also refuses to finalize a
 *   record twice (a second handle, a reattach or a sweep in another tab), so spend is booked exactly once.
 *   A failed final write is not remembered: `finish()`/`fail()` can be retried.
 * - Storage failures never block a run: if the record cannot be written, the run goes ahead unpersisted
 *   (logged once per page), and its spend still reaches the stats when they can be written.
 * - pagehide only aborts (the page may be gone before any IndexedDB work finishes). Handed-off runs
 *   (`handOff(jobId)`) ignore aborts; their job's completion handler finishes them via `reattach()`.
 */

import type {
  BudgetCheck,
  BudgetConfirmHandler,
  CoreServices,
  ModelUsageTotals,
  RunHandle,
  RunRecord,
  RunResult,
  RunsService,
  RunStatus,
  Usage,
  UsageTotals,
} from '../types';
import {
  BudgetBlockedError,
  FreeOnlyError,
  KeyLockedError,
  NoKeyError,
  RunCancelledError,
  isAbortError,
  userMessage,
} from '../errors';
import { getDb } from '../storage/db';
import { jsonCopy } from '../settings/merge';
import { RECENT_MODELS_CAP } from '../settings/schema';
import { addRunToStats } from '../stats';
import { isFinalState, webLocks } from '../jobs';
import { MINUTE_MS, abortError, isFiniteNumber } from '../util';
import { getTool } from '../../tools/registry';

export const OUTPUT_CAP = 500_000;
export const CHECKPOINT_INTERVAL_MS = 2000;
export const HEARTBEAT_MS = 30_000;
/** Without Web Locks, a run whose heartbeat is older than this is considered orphaned. */
export const HEARTBEAT_STALE_MS = 3 * MINUTE_MS;
const TITLE_CHARS = 80;

const BUDGET_LOCK = 'ortoolbox:budget';
const runLockName = (id: string): string => `ortoolbox:run:${id}`;
const heartbeatKey = (id: string): string => `meta:run-heartbeat:${id}`;

/** Whitespace-collapsed excerpt, cut at a word boundary when one is near the end. */
export function excerpt(text: string, max = TITLE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    latencyMsTotal: 0,
    costEstimated: false,
    costUnknown: false,
    byModel: {},
  };
}

function addTo(totals: ModelUsageTotals, usage: Usage): void {
  totals.requests += 1;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.costUsd += usage.costUsd;
  totals.latencyMsTotal += usage.latencyMs;
}

function capOutput(output: string | null): { output: string | null; truncated: boolean } {
  if (output == null || output.length <= OUTPUT_CAP) return { output, truncated: false };
  return { output: output.slice(0, OUTPUT_CAP), truncated: true };
}

const unique = (values: string[]): string[] => [...new Set(values)];

/** A JSON copy of tool-supplied meta, or null (logged) when it is not JSON-safe. */
function copyMeta(meta: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return jsonCopy(meta);
  } catch (error) {
    console.error('Run meta is not JSON-safe and was dropped.', error);
    return null;
  }
}

/**
 * Holds `ortoolbox:run:<id>` until the returned function is called. Resolves once the lock is held, with
 * null when another page holds it or Web Locks are unavailable.
 */
function holdRunLock(id: string): Promise<(() => void) | null> {
  const locks = webLocks();
  if (!locks) return Promise.resolve(null);
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    locks
      .request(runLockName(id), { ifAvailable: true }, async (lock) => {
        if (!lock) return resolve(null);
        resolve(release);
        await held;
      })
      .catch(() => resolve(null));
  });
}

interface InternalHandle extends RunHandle {
  /** pagehide: abort unless handed off. No storage work. */
  closeForUnload(): void;
  /** Data reset: abort and never write anything for this run again. */
  discard(): void;
}

const RESET_MESSAGE = 'All data was reset.';

export function createRunsService(core: CoreServices): RunsService {
  const active = new Map<string, InternalHandle>();
  let confirmHandler: BudgetConfirmHandler | null = null;
  let lastStartedAt = 0;

  let storageWarned = false;
  const warnStorage = (error: unknown): void => {
    if (storageWarned) return;
    storageWarned = true;
    console.error(
      'History could not be saved (storage full or unavailable); runs continue.',
      error,
    );
  };

  // Check-and-reserve runs one at a time per page, and across tabs under a Web Lock.
  let budgetQueue: Promise<unknown> = Promise.resolve();
  const withBudgetLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      const locks = webLocks();
      if (!locks) return fn();
      let started = false;
      try {
        return await locks.request(BUDGET_LOCK, () => {
          started = true;
          return fn();
        });
      } catch (error) {
        if (started) throw error;
        return fn(); // the Locks API refused: the in-page queue still serialises this page
      }
    };
    const result = budgetQueue.then(run, run);
    budgetQueue = result.catch(() => undefined);
    return result;
  };

  /** Bumped by every data reset; handles from an earlier generation never write again. */
  let generation = 0;
  let pageWired = false;
  const wirePage = (): void => {
    if (pageWired) return;
    pageWired = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => {
        for (const handle of [...active.values()]) handle.closeForUnload();
      });
    }
    core.bus.on('data-reset', () => {
      generation++;
      for (const handle of [...active.values()]) handle.discard();
    });
  };

  const isFree = (model: string): boolean => core.models.isFree(model);

  /**
   * Finalizes a run in one transaction with its stats. Writes nothing when the record is already final
   * (booked elsewhere) or when `valid()` turns false (a data reset happened meanwhile).
   */
  const writeFinal = async (
    id: string,
    fields: Partial<RunRecord>,
    fallback: RunRecord,
    valid: () => boolean = () => true,
  ): Promise<{ record: RunRecord; booked: boolean }> => {
    const db = await getDb();
    const tx = db.transaction(['runs', 'stats', 'kv'], 'readwrite');
    const done = tx.done;
    done.catch(() => undefined); // observed below; an abort must not surface as unhandled
    const runs = tx.objectStore('runs');
    try {
      const stored = await runs.get(id);
      if (!valid()) {
        tx.abort();
        return { record: { ...(stored ?? fallback), ...fields }, booked: false };
      }
      if (stored && stored.status !== 'running') {
        await done;
        return { record: stored, booked: false };
      }
      // A record deleted while running (history cleared) is not recreated, but its spend is booked.
      const record: RunRecord = { ...(stored ?? fallback), ...fields };
      if (stored) await runs.put(record);
      await addRunToStats(tx.objectStore('stats'), record, isFree);
      await tx.objectStore('kv').delete(heartbeatKey(id));
      await done;
      return { record, booked: true };
    } catch (error) {
      try {
        tx.abort(); // all or nothing: never a final record without its stats
      } catch {
        // already finished or aborted
      }
      throw error;
    }
  };

  const createHandle = (
    initial: RunRecord,
    opts: { persisted: boolean; releaseLock: (() => void) | null },
  ): InternalHandle => {
    const { id, tool, model, keyId, startedAt } = initial;
    const { persisted } = opts;
    const controller = new AbortController();
    const totals: UsageTotals = { ...emptyTotals(), ...structuredClone(initial.usage) };
    const usageListeners = new Set<(totals: UsageTotals) => void>();
    let output: string | null = initial.output;
    let meta: Record<string, unknown> = { ...initial.meta };
    let jobId: string | null = initial.jobId ?? null;
    let abortReason: string | null = null;
    let finalRecord: RunRecord | null = null;
    let finalizing: Promise<RunRecord> | null = null;
    const born = generation;
    /** False once a data reset happened: this run's data is gone and must stay gone. */
    const valid = (): boolean => generation === born;

    // Heartbeat for sweeps in browsers without Web Locks.
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    if (persisted && !webLocks()) {
      const beat = (): void => {
        void getDb()
          .then((db) => db.put('kv', { key: heartbeatKey(id), value: id, updatedAt: Date.now() }))
          .catch(() => undefined);
      };
      beat();
      heartbeat = setInterval(beat, HEARTBEAT_MS);
    }

    // Serialised read-modify-write of this run's record while it is running.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn);
      chain = next.catch(() => undefined);
      return next;
    };
    const persist = (fields: Partial<RunRecord>): Promise<void> =>
      serial(async () => {
        if (!valid()) return;
        const tx = (await getDb()).transaction('runs', 'readwrite');
        const stored = await tx.store.get(id);
        if (stored?.status === 'running' && valid()) await tx.store.put({ ...stored, ...fields });
        await tx.done;
      });

    const runningFields = (): Partial<RunRecord> => {
      const capped = capOutput(output);
      return {
        output: capped.output,
        usage: structuredClone(totals),
        meta: capped.truncated ? { ...meta, outputTruncated: true } : { ...meta },
        jobId,
      };
    };
    const snapshot = (): RunRecord => ({ ...initial, ...runningFields() });

    // Throttled writes (checkpoints and usage): at most one per interval, the last one trailing.
    let lastWriteAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { promise: Promise<void>; settle: (error?: Error) => void } | null = null;

    const flush = (): Promise<void> => {
      lastWriteAt = Date.now();
      return persist(runningFields());
    };

    const scheduleWrite = (): Promise<void> => {
      if (finalRecord || !persisted || !valid()) return Promise.resolve();
      if (pending) return pending.promise;
      const wait = lastWriteAt + CHECKPOINT_INTERVAL_MS - Date.now();
      if (wait <= 0) return flush();
      let settle!: (error?: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      });
      pending = { promise, settle };
      timer = setTimeout(() => {
        const current = pending;
        timer = null;
        pending = null;
        flush().then(
          () => current?.settle(),
          (error: unknown) =>
            current?.settle(error instanceof Error ? error : new Error('Checkpoint failed.')),
        );
      }, wait);
      return promise;
    };

    /** Stops timers, frees the lock and leaves `active`, once the run is final or discarded. */
    const release = (record: RunRecord): void => {
      finalRecord = record;
      if (timer) clearTimeout(timer);
      timer = null;
      pending?.settle();
      pending = null;
      if (heartbeat) clearInterval(heartbeat);
      opts.releaseLock?.();
      active.delete(id);
    };

    const finalize = (status: Exclude<RunStatus, 'running'>, error: string | null) => {
      if (finalRecord) return Promise.resolve(finalRecord);
      if (finalizing) return finalizing;
      const attempt = serial(async () => {
        const finishedAt = Math.max(Date.now(), startedAt);
        const fields: Partial<RunRecord> = {
          ...runningFields(),
          status,
          error,
          finishedAt,
          latencyMs: finishedAt - startedAt,
        };
        let result: { record: RunRecord; booked: boolean };
        try {
          result = await writeFinal(id, fields, initial, valid);
        } catch (writeError) {
          if (persisted) throw writeError; // retryable: finish()/fail() again
          warnStorage(writeError);
          result = { record: { ...initial, ...fields }, booked: false };
        }
        release(result.record);
        if (!valid()) return result.record; // reset meanwhile: nothing to announce

        if (result.booked) core.bus.emit({ type: 'stats-changed' });
        if (persisted) core.bus.emit({ type: 'history-changed', ids: [id] });
        core.bus.emit({ type: 'run-finished', id, tool, status: result.record.status });
        return result.record;
      });
      finalizing = attempt;
      attempt.catch(() => {
        if (finalizing === attempt) finalizing = null;
      });
      return attempt;
    };

    const handedOff = (): boolean => jobId !== null;

    const abort = (reason?: string): void => {
      if (controller.signal.aborted || handedOff()) return;
      abortReason = reason ?? null;
      controller.abort(abortError(reason ?? 'The run was stopped.'));
    };

    const handle: InternalHandle = {
      id,
      tool,
      model,
      keyId,
      signal: controller.signal,
      abort,
      addUsage(usage) {
        if (finalRecord) return;
        addTo(totals, usage);
        addTo((totals.byModel[usage.model] ??= emptyModelTotals()), usage);
        totals.costEstimated ||= usage.costEstimated;
        totals.costUnknown ||= usage.costUnknown === true;
        const copy = structuredClone(totals);
        for (const fn of [...usageListeners]) {
          try {
            fn(copy);
          } catch (listenerError) {
            console.error(listenerError);
          }
        }
        // Persist spend as it happens, so a crash still leaves it for the sweep to book.
        scheduleWrite().catch(warnStorage);
      },
      get totals() {
        return structuredClone(totals);
      },
      onUsage(fn) {
        usageListeners.add(fn);
        return () => {
          usageListeners.delete(fn);
        };
      },
      checkpoint(partial: RunResult) {
        if (finalRecord) return Promise.resolve();
        if (partial.output !== undefined) output = partial.output;
        const copied = partial.meta ? copyMeta(partial.meta) : null;
        if (copied) meta = { ...meta, ...copied };
        return scheduleWrite();
      },
      finish(result) {
        if (!finalRecord && !finalizing) {
          if (result?.output !== undefined) output = result.output;
          const copied = result?.meta ? copyMeta(result.meta) : null;
          if (copied) meta = { ...meta, ...copied };
        }
        return finalize('ok', null);
      },
      fail(error) {
        if (handedOff() && isAbortError(error)) {
          return Promise.resolve(finalRecord ?? snapshot());
        }
        if (isAbortError(error) || controller.signal.aborted) {
          return finalize('aborted', abortReason);
        }
        return finalize('error', userMessage(error));
      },
      handOff(newJobId) {
        if (finalRecord) return;
        jobId = newJobId;
        persist(runningFields()).catch(warnStorage);
      },
      closeForUnload() {
        abort('The page was closed.');
      },
      discard() {
        if (finalRecord) return;
        abortReason = RESET_MESSAGE;
        if (!controller.signal.aborted) controller.abort(abortError(RESET_MESSAGE));
        release({ ...snapshot(), status: 'aborted', error: RESET_MESSAGE });
      },
    };
    return handle;
  };

  /** Finalizes an orphaned `running` record; false when it is gone or already final. */
  const finalizeOrphan = async (run: RunRecord): Promise<boolean> => {
    const finishedAt = Math.max(Date.now(), run.startedAt);
    const { booked } = await writeFinal(
      run.id,
      {
        status: 'aborted',
        error: 'The page was closed before the run finished.',
        finishedAt,
        latencyMs: finishedAt - run.startedAt,
        // Whatever happened after the last write is unknown: book at least the reservation.
        usage: { ...emptyTotals(), ...run.usage, costUnknown: true },
      },
      run,
    );
    return booked;
  };

  return {
    async begin(spec) {
      const key = core.keys.resolve(spec.tool, spec.keyId);
      if (!key) throw new NoKeyError();
      if (!core.keys.lock.unlocked()) throw new KeyLockedError();

      const models = unique([spec.model, ...(spec.models ?? [])]);
      if (core.settings.get().freeOnly) {
        const paid = models.filter((m) => !core.models.isFree(m));
        if (paid.length > 0) throw new FreeOnlyError(paid);
      }

      const estimate = spec.estimateUsd ?? null;
      // Strictly increasing within this page, so `before` pagination never splits parallel runs.
      const startedAt = Math.max(Date.now(), lastStartedAt + 1);
      lastStartedAt = startedAt;
      const prompt = spec.prompt ?? null;
      const record: RunRecord = {
        id: crypto.randomUUID(),
        tool: spec.tool,
        status: 'running',
        model: spec.model,
        models,
        keyId: key.id,
        keyName: key.name,
        startedAt,
        finishedAt: null,
        latencyMs: null,
        title: spec.title?.trim() || (prompt?.trim() ? excerpt(prompt) : getTool(spec.tool).name),
        prompt,
        settings: spec.settings ? (copyMeta(spec.settings) ?? null) : null,
        output: null,
        error: null,
        usage: emptyTotals(),
        reservedUsd: isFiniteNumber(estimate) ? Math.max(0, estimate) : 0,
        jobId: null,
        meta: {},
        starred: false,
        groupId: spec.groupId ?? null,
      };

      // A run on free models only costs nothing: budgets never block or question it.
      const free = (estimate === null || estimate === 0) && models.every((m) => isFree(m));

      // Own the run before it becomes visible, so no sweep can mistake it for an orphan.
      const releaseLock = await holdRunLock(record.id);
      let persisted = false;
      let check: BudgetCheck;
      try {
        check = await withBudgetLock(async () => {
          const verdict: BudgetCheck = free
            ? { verdict: 'ok', reasons: [] }
            : await core.budgets.check({ keyId: key.id, estimateUsd: estimate });
          if (verdict.verdict !== 'block') {
            try {
              await (await getDb()).put('runs', record);
              persisted = true;
            } catch (error) {
              warnStorage(error);
            }
          }
          return verdict;
        });
        if (check.verdict === 'block') throw new BudgetBlockedError(check);
        if (check.verdict === 'confirm' && confirmHandler && !(await confirmHandler(check, spec))) {
          throw new RunCancelledError();
        }
      } catch (error) {
        if (persisted) {
          await (await getDb()).delete('runs', record.id).catch(warnStorage);
        }
        releaseLock?.();
        throw error;
      }

      try {
        core.settings.update((draft) => {
          draft.models.recent = unique([...models, ...draft.models.recent]).slice(
            0,
            RECENT_MODELS_CAP,
          );
        });
      } catch (error) {
        warnStorage(error);
      }
      if (prompt?.trim()) {
        await core.prompts
          .addRecent(spec.tool, prompt, spec.settings ?? {})
          .catch((error: unknown) => {
            warnStorage(error);
            return null;
          });
      }
      if (persisted) core.bus.emit({ type: 'history-changed', ids: [record.id] });

      const handle = createHandle(record, { persisted, releaseLock });
      active.set(record.id, handle);
      wirePage();
      return handle;
    },

    async reattach(runId) {
      const known = active.get(runId);
      if (known) return known;
      const record = await (await getDb()).get('runs', runId);
      if (!record || record.status !== 'running') return null;
      const releaseLock = await holdRunLock(runId); // null while the original page still owns it
      const raced = active.get(runId);
      if (raced) {
        releaseLock?.();
        return raced;
      }
      const handle = createHandle(record, { persisted: true, releaseLock });
      active.set(runId, handle);
      wirePage();
      return handle;
    },

    setConfirmHandler(fn) {
      confirmHandler = fn;
    },

    active() {
      return [...active.values()];
    },

    async sweep() {
      const db = await getDb();
      const running = await db.getAllFromIndex('runs', 'status', 'running');
      const locks = webLocks();
      let count = 0;
      for (const run of running) {
        if (active.has(run.id)) continue;
        try {
          if (run.jobId) {
            const job = await db.get('jobs', run.jobId);
            if (job && !isFinalState(job.state)) continue; // the job will finish it
          }
          if (locks) {
            let finalized = false;
            await locks.request(runLockName(run.id), { ifAvailable: true }, async (lock) => {
              if (lock) finalized = await finalizeOrphan(run);
            });
            if (finalized) count++;
          } else {
            const beat = await db.get('kv', heartbeatKey(run.id));
            const lastSign = Math.max(beat?.updatedAt ?? 0, run.startedAt);
            if (Date.now() - lastSign < HEARTBEAT_STALE_MS) continue;
            if (await finalizeOrphan(run)) count++;
          }
        } catch (error) {
          console.error(error);
        }
      }
      if (count > 0) {
        core.bus.emit({ type: 'stats-changed' });
        core.bus.emit({ type: 'history-changed' });
      }
      return count;
    },
  };
}

function emptyModelTotals(): ModelUsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMsTotal: 0 };
}
