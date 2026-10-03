/**
 * Runs: the gatekeeper for every model call (key, lock, free-only, budget), and the handle that collects
 * usage, checkpoints partial output and writes the final history record and stats rollups.
 *
 * Writes to a run record are read-modify-write and serialised per handle, so a late checkpoint never lands
 * after the final write and a star set from the History page while the run is going is kept. A record that
 * was deleted while running (history cleared) is not recreated, but its spend still reaches the stats.
 */

import type {
  BudgetConfirmHandler,
  CoreServices,
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
import { recordRunStats } from '../stats';
import { getTool } from '../../tools/registry';

export const OUTPUT_CAP = 500_000;
export const CHECKPOINT_INTERVAL_MS = 2000;
const TITLE_CHARS = 80;

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
    byModel: {},
  };
}

function addTo(totals: Omit<UsageTotals, 'costEstimated' | 'byModel'>, usage: Usage): void {
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

/** A run handle plus what the service needs internally. */
interface InternalHandle extends RunHandle {
  /** pagehide: abort, then record the run as aborted unless an open job will resume it. */
  closeForUnload(): void;
}

async function hasOpenJob(runId: string): Promise<boolean> {
  const db = await getDb();
  const [queued, running] = await Promise.all([
    db.getAllFromIndex('jobs', 'state', 'queued'),
    db.getAllFromIndex('jobs', 'state', 'running'),
  ]);
  return [...queued, ...running].some((job) => job.runId === runId);
}

export function createRunsService(core: CoreServices): RunsService {
  const active = new Map<string, InternalHandle>();
  let confirmHandler: BudgetConfirmHandler | null = null;
  let lastStartedAt = 0;

  let unloadWired = false;
  const wireUnload = (): void => {
    if (unloadWired || typeof window === 'undefined') return;
    unloadWired = true;
    window.addEventListener('pagehide', () => {
      for (const handle of [...active.values()]) handle.closeForUnload();
    });
  };

  const createHandle = (initial: RunRecord): InternalHandle => {
    const { id, tool, model, keyId, startedAt } = initial;
    const controller = new AbortController();
    const totals: UsageTotals = structuredClone(initial.usage);
    const usageListeners = new Set<(totals: UsageTotals) => void>();
    let output: string | null = initial.output;
    let meta: Record<string, unknown> = { ...initial.meta };
    let abortReason: string | null = null;
    let final: Promise<RunRecord> | null = null;

    // Serialised read-modify-write of this run's record.
    let chain: Promise<unknown> = Promise.resolve();
    const persist = (fields: Partial<RunRecord>): Promise<RunRecord> => {
      const write = chain.then(async () => {
        const db = await getDb();
        const tx = db.transaction('runs', 'readwrite');
        const stored = await tx.store.get(id);
        const next: RunRecord = { ...(stored ?? initial), ...fields };
        if (stored) await tx.store.put(next);
        await tx.done;
        return next;
      });
      chain = write.catch(() => undefined);
      return write;
    };

    const runningFields = (): Partial<RunRecord> => {
      const capped = capOutput(output);
      return {
        output: capped.output,
        usage: structuredClone(totals),
        meta: capped.truncated ? { ...meta, outputTruncated: true } : { ...meta },
      };
    };

    // Checkpoint throttle: at most one write per CHECKPOINT_INTERVAL_MS, the last one trailing.
    let lastCheckpointAt = -Infinity;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: { promise: Promise<void>; settle: (error?: Error) => void } | null = null;

    const flushCheckpoint = (): Promise<void> => {
      lastCheckpointAt = Date.now();
      return persist(runningFields()).then(() => undefined);
    };

    const checkpoint = (partial: RunResult): Promise<void> => {
      if (final) return Promise.resolve();
      if (partial.output !== undefined) output = partial.output;
      if (partial.meta) meta = { ...meta, ...jsonCopy(partial.meta) };
      if (pending) return pending.promise;
      const wait = lastCheckpointAt + CHECKPOINT_INTERVAL_MS - Date.now();
      if (wait <= 0) return flushCheckpoint();
      let settle!: (error?: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve());
      });
      pending = { promise, settle };
      timer = setTimeout(() => {
        const current = pending;
        timer = null;
        pending = null;
        flushCheckpoint().then(
          () => current?.settle(),
          (error: unknown) =>
            current?.settle(error instanceof Error ? error : new Error('Checkpoint failed.')),
        );
      }, wait);
      return promise;
    };

    const finalize = (status: Exclude<RunStatus, 'running'>, error: string | null) => {
      final ??= (async () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const waiting = pending;
        pending = null;
        const finishedAt = Math.max(Date.now(), startedAt);
        try {
          const record = await persist({
            ...runningFields(),
            status,
            error,
            finishedAt,
            latencyMs: finishedAt - startedAt,
          });
          try {
            await recordRunStats(record, (m) => core.models.isFree(m));
            core.bus.emit({ type: 'stats-changed' });
          } catch (statsError) {
            console.error(statsError);
          }
          core.bus.emit({ type: 'history-changed', ids: [id] });
          core.bus.emit({ type: 'run-finished', id, tool, status });
          return record;
        } finally {
          active.delete(id);
          waiting?.settle();
        }
      })();
      return final;
    };

    const abort = (reason?: string): void => {
      if (controller.signal.aborted) return;
      abortReason = reason ?? null;
      controller.abort(new DOMException(reason ?? 'The run was stopped.', 'AbortError'));
    };

    const handle: InternalHandle = {
      id,
      tool,
      model,
      keyId,
      signal: controller.signal,
      abort,
      addUsage(usage) {
        if (final) return;
        addTo(totals, usage);
        const perModel = (totals.byModel[usage.model] ??= {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMsTotal: 0,
        });
        addTo(perModel, usage);
        totals.costEstimated ||= usage.costEstimated;
        const snapshot = structuredClone(totals);
        for (const fn of [...usageListeners]) {
          try {
            fn(snapshot);
          } catch (listenerError) {
            console.error(listenerError);
          }
        }
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
      checkpoint,
      finish(result) {
        if (!final) {
          if (result?.output !== undefined) output = result.output;
          if (result?.meta) meta = { ...meta, ...jsonCopy(result.meta) };
        }
        return finalize('ok', null);
      },
      fail(error) {
        if (isAbortError(error) || controller.signal.aborted) {
          return finalize('aborted', abortReason);
        }
        return finalize('error', userMessage(error));
      },
      closeForUnload() {
        abort('The page was closed.');
        void hasOpenJob(id)
          .catch(() => false)
          .then((open) => (open ? undefined : handle.fail(controller.signal.reason)))
          .catch(() => undefined);
      },
    };
    return handle;
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

      const check = await core.budgets.check({
        keyId: key.id,
        estimateUsd: spec.estimateUsd ?? null,
      });
      if (check.verdict === 'block') throw new BudgetBlockedError(check);
      if (check.verdict === 'confirm' && confirmHandler && !(await confirmHandler(check, spec))) {
        throw new RunCancelledError();
      }

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
        settings: spec.settings ? jsonCopy(spec.settings) : null,
        output: null,
        error: null,
        usage: emptyTotals(),
        meta: {},
        starred: false,
        groupId: spec.groupId ?? null,
      };
      await (await getDb()).put('runs', record);

      try {
        core.settings.update((draft) => {
          draft.models.recent = unique([...models, ...draft.models.recent]).slice(
            0,
            RECENT_MODELS_CAP,
          );
        });
      } catch (error) {
        console.error(error); // storage full: the run itself can still go ahead
      }
      if (prompt?.trim()) {
        await core.prompts.addRecent(spec.tool, prompt, spec.settings ?? {}).catch((error) => {
          console.error(error);
          return null;
        });
      }
      core.bus.emit({ type: 'history-changed', ids: [record.id] });

      const handle = createHandle(record);
      active.set(record.id, handle);
      wireUnload();
      return handle;
    },

    async reattach(runId) {
      const known = active.get(runId);
      if (known) return known;
      const record = await (await getDb()).get('runs', runId);
      if (!record || record.status !== 'running') return null;
      const raced = active.get(runId);
      if (raced) return raced;
      const handle = createHandle(record);
      active.set(runId, handle);
      wireUnload();
      return handle;
    },

    setConfirmHandler(fn) {
      confirmHandler = fn;
    },

    active() {
      return [...active.values()];
    },
  };
}
