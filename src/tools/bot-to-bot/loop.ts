/**
 * The conversation loop and its stop conditions, without any DOM or storage: tool.ts supplies the turns, the
 * conversation's totals and the limits (read live, so a limit raised while paused applies on Resume).
 *
 * Stop conditions, first one hit wins:
 * - **Stop button:** the run's signal aborts; the turn keeps its partial text (tool.ts) and the abort propagates.
 * - **Time limit:** the clock runs only while the loop runs (`progress().elapsedMs`, kept across pauses). A timer
 *   for what is left aborts the turn in flight; its partial text is kept, marked `cut`. A limit changed during
 *   the turn re-arms the timer (`onLimitsChange`), at once when the new limit is already used up.
 * - **Stop phrase** said by either bot at the end of its message (`saysPhrase`).
 * - **Cost cap:** before each turn against spent plus the next turn's estimate (an unknown estimate skips this
 *   check), and after it against what was spent.
 * - **Turn limit.**
 *
 * After a turn the order is: cut by time, stop phrase, cost, turns, time. Before a turn: turns, time, cost.
 * Pause asks the loop to hold after the turn in flight; Step runs exactly one turn. Both end the loop with no
 * reason (held), unless a stop condition ended it first. The end carries the limits that applied, so what the
 * transcript says matches what happened even if a field changed meanwhile.
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

/** What may follow the phrase at the very end: whitespace, sentence punctuation, closing quotes, Markdown emphasis. */
const TRAILING = /[\s.!?,;:…*_~`"'”’»)]$/u;
const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether a message ends with the stop phrase, as the framing asks ("end your message with …"). Case does not
 * matter; what may trail it (whitespace, punctuation, closing quotes, Markdown emphasis) is ignored; and a phrase
 * that starts with a letter or digit must start a word ("done" ends "Well done." but not "undone"). A phrase only
 * mentioned earlier in the message does not count.
 */
export function saysPhrase(text: string, stopPhrase: string): boolean {
  const phrase = stopPhrase.trim().toLowerCase();
  if (!phrase) return false;
  let rest = text.toLowerCase();
  for (;;) {
    if (rest.endsWith(phrase)) {
      const before = rest.slice(0, rest.length - phrase.length);
      const boundary =
        !WORD.test(phrase.charAt(0)) || before === '' || !WORD.test(Array.from(before).at(-1)!);
      if (boundary) return true;
    }
    if (!TRAILING.test(rest)) return false;
    rest = rest.slice(0, -1);
  }
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
  /** Calls `fn` whenever the limits change (the time limit re-arms its timer); returns the unsubscribe. */
  onLimitsChange?(fn: () => void): () => void;
}

export type LoopMode = 'continue' | 'step';

export interface LoopEnd {
  /** The stop condition that ended the conversation, or null when it is held (paused, or the step is done). */
  reason: StopReason | null;
  /** Turns taken by this loop. */
  turns: number;
  /** The limits that applied when the loop ended (what the end marker reports). */
  limits: Limits;
}

export async function runLoop(
  deps: LoopDeps,
  mode: LoopMode,
  signal: AbortSignal,
): Promise<LoopEnd> {
  let taken = 0;
  const end = (reason: StopReason | null, limits = deps.limits()): LoopEnd => ({
    reason,
    turns: taken,
    limits,
  });
  for (;;) {
    throwIfAborted(signal);
    if (taken > 0 && (mode === 'step' || deps.pauseRequested())) return end(null);
    const estimate = await deps.estimateNext();
    throwIfAborted(signal);
    const limits = deps.limits();
    const blocked = blockedBy(deps.progress(), limits, estimate);
    if (blocked) return end(blocked, limits);

    const turn = new AbortController();
    let timeUp = false;
    /** The limits the time-limit timer was last armed with. */
    let armed = limits;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      armed = deps.limits();
      const left = armed.timeMs - deps.progress().elapsedMs;
      timer = setTimeout(
        () => {
          timeUp = true;
          turn.abort(new DOMException('The time limit was reached.', 'AbortError'));
        },
        Math.max(0, Math.min(MAX_TIMEOUT_MS, left)),
      );
    };
    arm();
    const unsubscribe = deps.onLimitsChange?.(() => {
      if (!timeUp) arm();
    });
    let result: TurnResult;
    try {
      result = await deps.takeTurn(turn.signal, () => timeUp);
    } finally {
      clearTimeout(timer);
      unsubscribe?.();
    }
    taken++;

    if (result.status === 'cut') return end('time', armed);
    const now = deps.limits();
    const after = deps.progress();
    if (saysPhrase(result.content, now.stopPhrase)) return end('phrase', now);
    if (capReached(after.spentUsd, now.costUsd)) return end('cost', now);
    if (after.turns >= now.turns) return end('turns', now);
    if (after.elapsedMs >= now.timeMs) return end('time', now);
  }
}
