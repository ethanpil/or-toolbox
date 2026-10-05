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
 *   (`handOff(jobId)`) ignore aborts; their job's completion handler finishes them via `reattach()`, or ends
 *   them with `cancel()` (aborted, booking max(actual, reservation): the job may still bill).
 * - A run that sent nothing (no request recorded, never handed off, no unknown cost) and ends aborted books no
 *   stats row, like an orphan that sent nothing: there was no run to count.
 * - Group approvals (`approveGroup`) live in `kv` `meta:group-approval:<groupId>` as what they still cover (runs
 *   and USD); runs begun with `useGroupApproval` take their share under the budget lock, and give it back when they
 *   end having sent nothing. `beginAll` withdraws the members it began when a later one is refused.
 */

import type {
  BudgetCheck,
  BudgetConfirmHandler,
  CoreServices,
  ModelUsageTotals,
  RunAddon,
  RunGroupSpec,
  RunHandle,
  RunRecord,
  RunCheckpoint,
  RunSpec,
  RunsService,
  RunStatus,
  ToolId,
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
import { isFinalState } from '../jobs';
import {
  MINUTE_MS,
  abortError,
  holdLock,
  isFiniteNumber,
  isPlainObject,
  isString,
  throwIfAborted,
  webLocks,
  withLock,
} from '../util';
import { paidAddons, withAddons } from './addons';
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
const approvalKey = (groupId: string): string => `meta:group-approval:${groupId}`;
/** Sums of estimates are compared with this much slack (floating point). */
const USD_EPSILON = 1e-9;

/** What a group approval still covers (`kv` `meta:group-approval:<groupId>`). */
interface StoredApproval {
  tool: ToolId;
  keyId: string;
  models: string[];
  /** Runs it still covers. */
  runsLeft: number;
  /** USD it still covers; null when the group's total was unknown (then the count alone bounds it). */
  usdLeft: number | null;
}

function parseApproval(value: unknown): StoredApproval | null {
  if (!isPlainObject(value)) return null;
  const { tool, keyId, models, runsLeft, usdLeft } = value;
  if (
    !isString(tool) ||
    !isString(keyId) ||
    !Array.isArray(models) ||
    !models.every(isString) ||
    !isFiniteNumber(runsLeft) ||
    !(usdLeft === null || isFiniteNumber(usdLeft))
  ) {
    return null;
  }
  return { tool: tool as ToolId, keyId, models, runsLeft, usdLeft };
}

/** A run's part of its group's approval, given back when the run ends having sent nothing. */
interface ApprovalShare {
  groupId: string;
  usd: number;
}

/** The sum of the known estimates; null when none is known (like `withAddons`). */
function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter(isFiniteNumber);
  return known.length === 0 ? null : known.reduce((sum, usd) => sum + Math.max(0, usd), 0);
}

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

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** A JSON copy of tool-supplied meta, or null (logged) when it is not JSON-safe. */
function copyMeta(meta: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return jsonCopy(meta);
  } catch (error) {
    console.error('Run meta is not JSON-safe and was dropped.', error);
    return null;
  }
}

/** Holds `ortoolbox:run:<id>` until the returned function is called; null when another page holds it. */
const holdRunLock = (id: string): Promise<(() => void) | null> =>
  holdLock(runLockName(id), { ifAvailable: true });

interface InternalHandle extends RunHandle {
  /** pagehide: abort unless handed off. No storage work. */
  closeForUnload(): void;
  /** Data reset: abort and never write anything for this run again. */
  discard(): void;
  /**
   * `beginAll` refused: the run never started. Aborts it, deletes its record (and with it the reservation), gives
   * its approval share back and books nothing.
   */
  withdraw(): Promise<void>;
}

/** A run `start` admitted: its handle, and what `announce` records once the run is sure to go ahead. */
interface Started {
  handle: InternalHandle;
  spec: RunSpec;
  models: string[];
  persisted: boolean;
}

const RESET_MESSAGE = 'All data was reset.';
const WITHDRAWN_MESSAGE = 'Not started: another run of its group was refused.';

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
  const withBudgetLock = <T>(fn: () => Promise<T>): Promise<T> => withLock(BUDGET_LOCK, fn);

  // --- group approvals (read and written under the budget lock only) ---------------------------------------
  const readApproval = async (groupId: string): Promise<StoredApproval | null> =>
    parseApproval((await (await getDb()).get('kv', approvalKey(groupId)))?.value);
  const writeApproval = async (groupId: string, approval: StoredApproval): Promise<void> => {
    await (
      await getDb()
    ).put('kv', { key: approvalKey(groupId), value: approval, updatedAt: Date.now() });
  };

  /** Takes a run's share of its group's approval when the approval has room for it; else null. */
  const takeShare = async (
    spec: RunSpec,
    keyId: string,
    models: readonly string[],
    estimate: number | null,
  ): Promise<ApprovalShare | null> => {
    if (!spec.useGroupApproval || !spec.groupId) return null;
    const approval = await readApproval(spec.groupId);
    if (
      !approval ||
      approval.tool !== spec.tool ||
      approval.keyId !== keyId ||
      approval.runsLeft < 1 ||
      !models.every((model) => approval.models.includes(model)) ||
      (approval.usdLeft !== null && estimate !== null && estimate > approval.usdLeft + USD_EPSILON)
    ) {
      return null;
    }
    const usd = estimate ?? 0;
    await writeApproval(spec.groupId, {
      ...approval,
      runsLeft: approval.runsLeft - 1,
      usdLeft: approval.usdLeft === null ? null : Math.max(0, approval.usdLeft - usd),
    });
    return { groupId: spec.groupId, usd };
  };

  /** Gives a share back (the run sent nothing); nothing when the approval was released meanwhile. */
  const giveBack = (share: ApprovalShare): Promise<void> =>
    withBudgetLock(async () => {
      const approval = await readApproval(share.groupId);
      if (!approval) return;
      await writeApproval(share.groupId, {
        ...approval,
        runsLeft: approval.runsLeft + 1,
        usdLeft: approval.usdLeft === null ? null : approval.usdLeft + share.usd,
      });
    }).catch(warnStorage);

  const releaseGroup = (groupId: string): Promise<void> =>
    withBudgetLock(async () => {
      await (await getDb()).delete('kv', approvalKey(groupId));
    });

  /** Free-only mode: every model and every paid add-on must be free. */
  const checkFreeOnly = (models: readonly string[], addons: readonly RunAddon[]): void => {
    if (!core.settings.get().freeOnly) return;
    const paid = models.filter((m) => !core.models.isFree(m));
    const paidExtras = paidAddons(addons);
    if (paid.length > 0 || paidExtras.length > 0) {
      throw new FreeOnlyError(
        paid,
        paidExtras.map((addon) => addon.label),
      );
    }
  };

  /** Free models only, nothing paid on top, and no cost estimated: budgets never block or question it. */
  const costsNothing = (
    models: readonly string[],
    addons: readonly RunAddon[],
    estimate: number | null,
  ): boolean =>
    (estimate === null || estimate === 0) &&
    paidAddons(addons).length === 0 &&
    models.every((m) => isFree(m));

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
    book = true,
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
      if (book) await addRunToStats(tx.objectStore('stats'), record, isFree);
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
    opts: { persisted: boolean; releaseLock: (() => void) | null; share?: ApprovalShare | null },
  ): InternalHandle => {
    const { id, tool, model, keyId, startedAt } = initial;
    const { persisted } = opts;
    const controller = new AbortController();
    const totals: UsageTotals = { ...emptyTotals(), ...structuredClone(initial.usage) };
    const usageListeners = new Set<(totals: UsageTotals) => void>();
    // A checkpoint may pass a function (long text built only when a write happens); read it through `outputNow`.
    let output: string | null | (() => string) = initial.output;
    let lastOutput: string | null = initial.output;
    const outputNow = (): string | null => {
      if (typeof output !== 'function') return output;
      try {
        lastOutput = output();
      } catch (error) {
        console.warn('A checkpoint output function failed; keeping the last text.', error);
      }
      return lastOutput;
    };
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
      const capped = capOutput(outputNow());
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
    /** Usage, output or meta changed since the last write started; else a checkpoint just waits for that write. */
    let unsaved = false;
    let lastWrite: Promise<void> = Promise.resolve();

    const flush = (): Promise<void> => {
      lastWriteAt = Date.now();
      unsaved = false;
      lastWrite = persist(runningFields()).catch((error: unknown) => {
        unsaved = true; // the next checkpoint tries again
        throw error;
      });
      return lastWrite;
    };

    const scheduleWrite = (): Promise<void> => {
      if (finalRecord || !persisted || !valid()) return Promise.resolve();
      if (pending) return pending.promise;
      if (!unsaved) return lastWrite;
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

    /** Nothing reached OpenRouter as far as this run knows: no request, no job, no unknown cost. */
    const sentNothing = (): boolean =>
      totals.requests === 0 && jobId === null && !totals.costUnknown;
    /** The approval share, while this run holds one. */
    let share = opts.share ?? null;
    const returnShare = (): void => {
      if (!share) return;
      const given = share;
      share = null;
      void giveBack(given);
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
        const idle = sentNothing();
        // Stopped before anything was sent: no run to count, nothing spent.
        const book = !(status === 'aborted' && idle);
        let result: { record: RunRecord; booked: boolean };
        try {
          result = await writeFinal(id, fields, initial, valid, book);
        } catch (writeError) {
          if (persisted) throw writeError; // retryable: finish()/fail() again
          warnStorage(writeError);
          result = { record: { ...initial, ...fields }, booked: false };
        }
        release(result.record);
        if (!valid()) return result.record; // reset meanwhile: nothing to announce

        if (idle) returnShare();
        if (result.booked && book) core.bus.emit({ type: 'stats-changed' });
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
        unsaved = true;
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
      get jobId() {
        return jobId;
      },
      onUsage(fn) {
        usageListeners.add(fn);
        return () => {
          usageListeners.delete(fn);
        };
      },
      checkpoint(partial: RunCheckpoint) {
        if (finalRecord) return Promise.resolve();
        if (partial.output !== undefined) {
          output = partial.output;
          unsaved = true;
        }
        const copied = partial.meta ? copyMeta(partial.meta) : null;
        if (copied) {
          meta = { ...meta, ...copied };
          unsaved = true;
        }
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
      cancel(reason) {
        if (!finalRecord && !finalizing) {
          if (reason !== undefined) abortReason = reason;
          if (!controller.signal.aborted) {
            controller.abort(abortError(reason ?? 'The run was stopped.'));
          }
          // Its job may still finish and bill: unknown cost books max(actual, reservation), as for orphans.
          if (handedOff()) totals.costUnknown = true;
        }
        return finalize('aborted', abortReason);
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
      async withdraw() {
        if (finalRecord || finalizing) return;
        abortReason = WITHDRAWN_MESSAGE;
        if (!controller.signal.aborted) controller.abort(abortError(WITHDRAWN_MESSAGE));
        const attempt = serial(async () => {
          try {
            if (persisted && valid()) {
              const tx = (await getDb()).transaction(['runs', 'kv'], 'readwrite');
              const stored = await tx.objectStore('runs').get(id);
              if (stored?.status === 'running') await tx.objectStore('runs').delete(id);
              await tx.objectStore('kv').delete(heartbeatKey(id));
              await tx.done;
            }
          } catch (error) {
            // Left `running`: the next sweep finalizes it, and as it sent nothing it books nothing.
            warnStorage(error);
          }
          const record: RunRecord = { ...snapshot(), status: 'aborted', error: WITHDRAWN_MESSAGE };
          release(record);
          returnShare();
          return record;
        });
        finalizing = attempt;
        await attempt;
      },
    };
    return handle;
  };

  /**
   * Finalizes an orphaned `running` record; false when it is gone or already final. An orphan that recorded a
   * request books max(its usage, its reservation): what happened after the last write is unknown. One that never
   * recorded a request (the page closed during the budget confirmation, say) sent nothing, so it books nothing
   * and its reservation is simply released.
   */
  const finalizeOrphan = async (run: RunRecord): Promise<boolean> => {
    const finishedAt = Math.max(Date.now(), run.startedAt);
    const sent = (run.usage?.requests ?? 0) > 0;
    const { booked } = await writeFinal(
      run.id,
      {
        status: 'aborted',
        error: 'The page was closed before the run finished.',
        finishedAt,
        latencyMs: finishedAt - run.startedAt,
        usage: sent
          ? { ...emptyTotals(), ...run.usage, costUnknown: true }
          : { ...emptyTotals(), ...run.usage },
        ...(sent ? {} : { reservedUsd: 0 }),
      },
      run,
      () => true,
      sent,
    );
    return booked; // finalized now (with or without stats rows)
  };

  /**
   * `begin`'s gatekeeping: checks, reserves (the `running` record) and asks, then creates the live handle. Records
   * nothing else yet (`announce` does, once the run is sure to go ahead), so `beginAll` can withdraw it cleanly.
   */
  const start = async (spec: RunSpec): Promise<Started> => {
    const key = core.keys.resolve(spec.tool, spec.keyId);
    if (!key) throw new NoKeyError();
    if (!core.keys.lock.unlocked()) throw new KeyLockedError();

    const models = unique([spec.model, ...(spec.models ?? [])]);
    const addons = spec.addons ?? [];
    checkFreeOnly(models, addons);

    const estimate = withAddons(spec.estimateUsd ?? null, addons);
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
    const free = costsNothing(models, addons, estimate);

    // Own the run before it becomes visible, so no sweep can mistake it for an orphan.
    const releaseLock = await holdRunLock(record.id);
    let persisted = false;
    let share: ApprovalShare | null = null;
    try {
      const check = await withBudgetLock(async () => {
        const verdict: BudgetCheck = free
          ? { verdict: 'ok', reasons: [] }
          : await core.budgets.check({ keyId: key.id, estimateUsd: estimate });
        if (verdict.verdict !== 'block') {
          if (!free) {
            share = await takeShare(spec, key.id, models, estimate).catch((error: unknown) => {
              warnStorage(error);
              return null;
            });
          }
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
      // Under its group's approval the run asks nothing more; otherwise it asks for itself.
      if (
        check.verdict === 'confirm' &&
        !share &&
        confirmHandler &&
        !(await confirmHandler(check, { kind: 'run', spec }))
      ) {
        throw new RunCancelledError();
      }
    } catch (error) {
      if (persisted) {
        await (await getDb()).delete('runs', record.id).catch(warnStorage);
      }
      if (share) await giveBack(share);
      releaseLock?.();
      throw error;
    }

    const handle = createHandle(record, { persisted, releaseLock, share });
    active.set(record.id, handle);
    wirePage();
    return { handle, spec, models, persisted };
  };

  /** What a run that goes ahead records: recent models, the Recent prompt, and the history announcement. */
  const announce = async ({ handle, spec, models, persisted }: Started): Promise<void> => {
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
    if (spec.prompt?.trim()) {
      await core.prompts
        .addRecent(spec.tool, spec.prompt, spec.settings ?? {})
        .catch((error: unknown) => {
          warnStorage(error);
          return null;
        });
    }
    if (persisted) core.bus.emit({ type: 'history-changed', ids: [handle.id] });
  };

  const approveGroup = async (group: RunGroupSpec): Promise<void> => {
    const key = core.keys.resolve(group.tool, group.keyId);
    if (!key) throw new NoKeyError();
    if (!core.keys.lock.unlocked()) throw new KeyLockedError();
    const models = unique(group.models);
    const addons = group.addons ?? [];
    checkFreeOnly(models, addons);
    const estimate = withAddons(group.estimateUsd, addons);
    if (costsNothing(models, addons, estimate)) return; // its runs never ask

    const check = await core.budgets.check({ keyId: key.id, estimateUsd: estimate, group: true });
    if (check.verdict === 'block') throw new BudgetBlockedError(check);
    if (
      check.verdict === 'confirm' &&
      confirmHandler &&
      !(await confirmHandler(check, { kind: 'group', group: { ...group, models } }))
    ) {
      throw new RunCancelledError();
    }
    const approval: StoredApproval = {
      tool: group.tool,
      keyId: key.id,
      models,
      runsLeft: Math.max(0, Math.floor(group.runs)),
      usdLeft: estimate,
    };
    // Unstored, its runs simply ask for themselves: never a reason to refuse the group.
    await withBudgetLock(() => writeApproval(group.groupId, approval)).catch(warnStorage);
  };

  return {
    async begin(spec) {
      const started = await start(spec);
      await announce(started);
      return started.handle;
    },

    approveGroup,

    releaseGroup,

    async beginAll(specs, opts = {}) {
      const first = specs[0];
      if (!first) return [];
      const groupId = first.groupId ?? crypto.randomUUID();
      const members = specs.map((spec) => ({
        ...spec,
        tool: first.tool,
        groupId,
        ...(opts.label ? { useGroupApproval: true } : {}),
      }));
      const { label, note, signal } = opts;
      throwIfAborted(signal);
      if (label) {
        await approveGroup({
          tool: first.tool,
          groupId,
          label,
          ...(note ? { note } : {}),
          models: members.flatMap((spec) => [spec.model, ...(spec.models ?? [])]),
          runs: members.length,
          estimateUsd: sumKnown(members.map((spec) => spec.estimateUsd)),
          addons: members.flatMap((spec) => spec.addons ?? []),
          ...(first.keyId ? { keyId: first.keyId } : {}),
        });
      }
      const started: Started[] = [];
      try {
        for (const spec of members) {
          throwIfAborted(signal);
          started.push(await start(spec));
        }
        throwIfAborted(signal);
      } catch (error) {
        await Promise.all(started.map(({ handle }) => handle.withdraw()));
        throw error;
      } finally {
        if (label) await releaseGroup(groupId).catch(warnStorage);
      }
      for (const run of started) await announce(run);
      const handles = started.map(({ handle }) => handle);
      signal?.addEventListener(
        'abort',
        () => {
          for (const handle of handles) handle.abort('Stopped by the user.');
        },
        { once: true },
      );
      return handles;
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
