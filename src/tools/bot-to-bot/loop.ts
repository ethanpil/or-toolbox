/**
 * The conversation loop and its stop conditions, without any DOM or storage: tool.ts supplies the turns, the
 * conversation's totals and the limits (read live, so a limit raised while paused applies on Resume).
 *
 * Stop conditions, first one hit wins:
 * - **Stop button:** the run's signal aborts; the turn keeps its partial text (tool.ts) and the abort propagates.
 * - **Time limit:** the clock runs only while the loop runs (`progress().elapsedMs`, kept across pauses). A timer
 *   for what is left aborts the turn in flight; its partial text is kept, marked `cut`.
 * - **Stop phrase** said by either bot (checked on the turn just finished).
 * - **Cost cap:** before each turn against spent plus the next turn's estimate (an unknown estimate skips this
 *   check), and after it against what was spent.
 * - **Turn limit.**
 *
 * After a turn the order is: cut by time, stop phrase, cost, turns, time. Before a turn: turns, time, cost.
 * Pause asks the loop to hold after the turn in flight; Step runs exactly one turn. Both end the loop with no
 * reason (held), unless a stop condition ended it first.
 */
import { MAX_TIMEOUT_MS, throwIfAborted } from '../../core/util';
import type { StopReason } from './conversation';

export interface Limits {
  turns: number;
  timeMs: number;
  costUsd: number;
  /** '' = no stop phrase. */
  stopPhrase: string;
}

export interface Progress {
  turns: number;
  elapsedMs: number;
  spentUsd: number;
}

/** The cap counts as reached once something was spent and the total got to it (a $0 cap still lets free models run). */
export function capReached(spentUsd: number, capUsd: number): boolean {
  return spentUsd > 0 && spentUsd >= capUsd;
}

/** Whether a stop phrase ends a turn's text: said anywhere in it. */
export function saysPhrase(text: string, stopPhrase: string): boolean {
  const phrase = stopPhrase.trim();
  return phrase.length > 0 && text.includes(phrase);
}

/**
 * The stop condition that forbids another turn now, or null. `nextEstimate` is the next turn's cost (null:
 * unknown, then only what was already spent is checked).
 */
export function blockedBy(
  progress: Progress,
  limits: Limits,
  nextEstimate: number | null,
): Exclude<StopReason, 'phrase' | 'stopped'> | null {
  if (progress.turns >= limits.turns) return 'turns';
  if (progress.elapsedMs >= limits.timeMs) return 'time';
  if (capReached(progress.spentUsd, limits.costUsd)) return 'cost';
  if (
    nextEstimate !== null &&
    nextEstimate > 0 &&
    progress.spentUsd + nextEstimate > limits.costUsd
  ) {
    return 'cost';
  }
  return null;
}

/** How a turn ended: `cut` when the time limit aborted it (its partial text is kept). */
export interface TurnResult {
  status: 'done' | 'cut';
  content: string;
}

export interface LoopDeps {
  limits(): Limits;
  /** The conversation's totals now (elapsed from the running clock). */
  progress(): Progress;
  /** The next turn's cost estimate, or null when unknown. */
  estimateNext(): Promise<number | null>;
  /**
   * Takes one turn. `signal` aborts when the time limit is reached (then `timeUp()` is true and the turn resolves
   * `cut` with its partial text); a Stop rejects with the abort, after keeping the partial text.
   */
  takeTurn(signal: AbortSignal, timeUp: () => boolean): Promise<TurnResult>;
  pauseRequested(): boolean;
}

export type LoopMode = 'continue' | 'step';

export interface LoopEnd {
  /** The stop condition that ended the conversation, or null when it is held (paused, or the step is done). */
  reason: StopReason | null;
  /** Turns taken by this loop. */
  turns: number;
}

export async function runLoop(
  deps: LoopDeps,
  mode: LoopMode,
  signal: AbortSignal,
): Promise<LoopEnd> {
  let taken = 0;
  for (;;) {
    throwIfAborted(signal);
    if (taken > 0 && (mode === 'step' || deps.pauseRequested()))
      return { reason: null, turns: taken };
    const estimate = await deps.estimateNext();
    throwIfAborted(signal);
    const limits = deps.limits();
    const before = deps.progress();
    const blocked = blockedBy(before, limits, estimate);
    if (blocked) return { reason: blocked, turns: taken };

    const turn = new AbortController();
    let timeUp = false;
    const timer = setTimeout(
      () => {
        timeUp = true;
        turn.abort(new DOMException('The time limit was reached.', 'AbortError'));
      },
      Math.min(MAX_TIMEOUT_MS, limits.timeMs - before.elapsedMs),
    );
    let result: TurnResult;
    try {
      result = await deps.takeTurn(turn.signal, () => timeUp);
    } finally {
      clearTimeout(timer);
    }
    taken++;

    const now = deps.limits();
    const after = deps.progress();
    if (result.status === 'cut') return { reason: 'time', turns: taken };
    if (saysPhrase(result.content, now.stopPhrase)) return { reason: 'phrase', turns: taken };
    if (capReached(after.spentUsd, now.costUsd)) return { reason: 'cost', turns: taken };
    if (after.turns >= now.turns) return { reason: 'turns', turns: taken };
    if (after.elapsedMs >= now.timeMs) return { reason: 'time', turns: taken };
  }
}
