/**
 * `runItems()`: how batch tools (OCR pages, extraction documents, TTS segments, image sets…) work through their
 * items inside ONE run. Built on `runPool` (src/core/pool.ts).
 *
 * - At most `concurrency` items run at once, started in item order; each item's status goes queued → running →
 *   done | failed | stopped, reported through `onItem` (draw the item from it).
 * - A failed item does not stop the others, unless its error is fatal (`isFatal`, default `isFatalError`: no
 *   key, locked, invalid key, budget, free-only, storage full, HTTP 401/402): then nothing new starts, the
 *   running items finish, the rest end `stopped`, and the error is rethrown for the runner to present.
 * - Stop (the signal aborts): nothing new starts; the abort reason is rethrown once running items settle.
 * - Every item failed: the last error is rethrown, marked as already shown (the items show their errors), so the
 *   runner stays quiet while the tool can still `run.fail(error)`. Errors that need an action stay unmarked.
 * - Otherwise it resolves with every item's outcome; partial failures are the tool's to report (`batchSummary`).
 *
 * ```ts
 * const run = await ctx.beginRun({ title: batchTitle(names, { retry }) }, signal); // refused: nothing changed
 * try {
 *   const result = await runItems({ items, concurrency: 3, signal: run.signal,
 *     work: (page) => readPage(run, page), onItem: (outcome) => draw(outcome) });
 *   await run.finish({ output: combined() });
 *   ui.status(batchSummary(result, 'page'));
 * } catch (error) {
 *   await run.fail(error);
 *   throw error;
 * }
 * ```
 */
import { ApiError, errorCode } from '../../core/errors';
import { runPool } from '../../core/pool';
import { abortError } from '../../core/util';
import { isStop, markPresented, needsAction } from '../feedback/errors';
import { plural } from '../format';

export type ItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped';

/** One item's state; the same object is updated as the item moves on. */
export interface ItemOutcome<T, R> {
  readonly item: T;
  status: ItemStatus;
  /** What `work` returned (done items). */
  value?: R;
  /** Why it failed (failed items). */
  error?: unknown;
}

export interface RunItemsOptions<T, R> {
  items: readonly T[];
  /** Items in flight at once (at least 1). */
  concurrency: number;
  /** Does one item. Pass `signal` on to every call. */
  work: (item: T, signal: AbortSignal) => Promise<R>;
  /** Usually `run.signal`. */
  signal: AbortSignal;
  /** Errors that would fail every other item too. Default `isFatalError`. */
  isFatal?: (error: unknown) => boolean;
  /** Called on every status change of an item (with its index in `items`). */
  onItem?: (outcome: ItemOutcome<T, R>, index: number) => void;
}

export interface RunItemsResult<T, R> {
  /** In item order. */
  outcomes: ItemOutcome<T, R>[];
  done: number;
  failed: number;
  stopped: number;
}

/** Errors after which trying the other items is pointless (they would fail the same way, or cost money). */
export function isFatalError(error: unknown): boolean {
  if (isStop(error) || needsAction(error)) return true;
  const code = errorCode(error);
  if (code === 'invalid-key' || code === 'no-key' || code === 'locked') return true;
  return error instanceof ApiError && (error.status === 401 || error.status === 402);
}

export async function runItems<T, R>(
  options: RunItemsOptions<T, R>,
): Promise<RunItemsResult<T, R>> {
  const { signal } = options;
  const isFatal = options.isFatal ?? isFatalError;
  const outcomes: ItemOutcome<T, R>[] = options.items.map((item) => ({ item, status: 'queued' }));
  const set = (index: number, patch: Partial<ItemOutcome<T, R>>): void => {
    const outcome = outcomes[index]!;
    Object.assign(outcome, patch);
    options.onItem?.(outcome, index);
  };

  let fatal: { error: unknown } | null = null;
  try {
    await runPool(
      outcomes,
      options.concurrency,
      async (_outcome, index) => {
        set(index, { status: 'running', error: undefined });
        try {
          set(index, { status: 'done', value: await options.work(outcomes[index]!.item, signal) });
        } catch (error) {
          if (signal.aborted || isStop(error)) {
            set(index, { status: 'stopped' });
            throw error;
          }
          set(index, { status: 'failed', error });
          if (isFatal(error)) {
            fatal ??= { error };
            throw error;
          }
        }
      },
      signal,
    );
  } catch {
    // Settled below: the abort reason or the fatal error is rethrown after the bookkeeping.
  } finally {
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'queued' || outcome.status === 'running') {
        set(index, { status: 'stopped' });
      }
    });
  }

  if (signal.aborted) {
    const reason: unknown = signal.reason;
    throw reason instanceof Error || reason instanceof DOMException
      ? reason
      : abortError('Stopped.');
  }
  if (fatal) throw (fatal as { error: unknown }).error;

  const count = (status: ItemStatus): number =>
    outcomes.filter((outcome) => outcome.status === status).length;
  const result = {
    outcomes,
    done: count('done'),
    failed: count('failed'),
    stopped: count('stopped'),
  };
  if (result.failed > 0 && result.failed === outcomes.length) {
    const last = [...outcomes].reverse().find((outcome) => outcome.status === 'failed')!.error;
    if (!needsAction(last)) markPresented(last);
    throw last;
  }
  return result;
}

/**
 * A run title for a batch: the first name, then how many more (each name counted once), with "Retry: " for a
 * retry of some items. `batchTitle(['a.pdf', 'b.pdf', 'c.pdf'], { retry: true })` is
 * "Retry: a.pdf and 2 more files".
 */
export function batchTitle(
  names: readonly string[],
  options: { retry?: boolean; noun?: string } = {},
): string {
  const unique = [...new Set(names)];
  const more = unique.length - 1;
  const rest = more > 0 ? ` and ${plural(more, `more ${options.noun ?? 'file'}`)}` : '';
  return `${options.retry ? 'Retry: ' : ''}${unique[0] ?? ''}${rest}`;
}

/** A status line for a finished (or stopped) batch: "Done · 3 of 4 pages; 1 failed". */
export function batchSummary(
  counts: { done: number; failed: number; stopped: number },
  noun = 'item',
): string {
  const total = counts.done + counts.failed + counts.stopped;
  if (counts.stopped > 0) return `Stopped · ${counts.done} of ${plural(total, noun)} done`;
  if (counts.failed > 0) {
    return `Done · ${counts.done} of ${plural(total, noun)}; ${counts.failed} failed`;
  }
  return `Done · ${plural(counts.done, noun)}`;
}
