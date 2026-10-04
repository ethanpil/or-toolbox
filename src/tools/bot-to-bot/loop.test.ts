import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockedBy, capReached, type Limits, type LoopDeps, runLoop, saysPhrase } from './loop';

const MINUTE = 60_000;

/** A fake conversation driven by the loop: each turn takes `turnMs` of (fake) time and costs `costPerTurn`. */
function harness(
  options: {
    limits?: Partial<Limits>;
    turnMs?: number;
    costPerTurn?: number;
    estimate?: number | null;
    reply?: (turn: number) => string;
    /** A turn that never ends by itself (only the time limit or Stop ends it). */
    hang?: (turn: number) => boolean;
  } = {},
) {
  const limits: Limits = {
    turns: 20,
    timeMs: 5 * MINUTE,
    costUsd: 0.25,
    stopPhrase: '[END]',
    ...options.limits,
  };
  const start = Date.now();
  const state = { turns: 0, spent: 0, pause: false, partials: [] as string[] };
  const takeTurn = vi.fn<LoopDeps['takeTurn']>(
    (signal, timeUp) =>
      new Promise((resolve, reject) => {
        const number = state.turns + 1;
        const text = options.reply?.(number) ?? `Turn ${number}`;
        const finish = (): void => {
          state.turns++;
          state.spent += options.costPerTurn ?? 0.001;
          resolve({ status: 'done', content: text });
        };
        const timer = options.hang?.(number) ? null : setTimeout(finish, options.turnMs ?? 1000);
        signal.addEventListener('abort', () => {
          if (timer) clearTimeout(timer);
          const partial = `${text} (part)`;
          state.partials.push(partial);
          if (timeUp()) {
            state.turns++;
            resolve({ status: 'cut', content: partial });
          } else reject(new DOMException('Stopped.', 'AbortError'));
        });
      }),
  );
  const deps: LoopDeps = {
    limits: () => limits,
    progress: () => ({ turns: state.turns, elapsedMs: Date.now() - start, spentUsd: state.spent }),
    estimateNext: () => Promise.resolve(options.estimate === undefined ? 0.001 : options.estimate),
    takeTurn,
    pauseRequested: () => state.pause,
  };
  return { deps, state, takeTurn, limits };
}

/** Runs the loop to its end while the fake clock moves on. */
async function drive<T>(promise: Promise<T>, stepMs = 250, maxMs = 60 * MINUTE): Promise<T> {
  let done = false;
  const settled = promise.finally(() => {
    done = true;
  });
  for (let elapsed = 0; !done && elapsed < maxMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('stop conditions', () => {
  it('ends at the turn limit', async () => {
    const { deps, takeTurn } = harness({ limits: { turns: 4 } });
    const end = await drive(runLoop(deps, 'continue', new AbortController().signal));
    expect(end).toEqual({ reason: 'turns', turns: 4 });
    expect(takeTurn).toHaveBeenCalledTimes(4);
  });

  it('cuts the turn in flight at the time limit and keeps its partial text', async () => {
    // Two quick turns, then one that would go on for ever: the timer aborts it at 1 minute.
    const { deps, state } = harness({
      limits: { timeMs: MINUTE },
      turnMs: 10_000,
      hang: (turn) => turn === 3,
    });
    const end = await drive(runLoop(deps, 'continue', new AbortController().signal));
    expect(end).toEqual({ reason: 'time', turns: 3 });
    expect(state.partials).toEqual(['Turn 3 (part)']);
    expect(Date.now()).toBeGreaterThanOrEqual(MINUTE);
  });

  it('counts time across pauses: a clock already used up ends before any turn', async () => {
    const { deps, takeTurn } = harness({ limits: { timeMs: MINUTE } });
    const base = Date.now() - MINUTE; // as if a minute ran before a pause
    deps.progress = () => ({ turns: 2, elapsedMs: Date.now() - base, spentUsd: 0 });
    const end = await drive(runLoop(deps, 'continue', new AbortController().signal));
    expect(end).toEqual({ reason: 'time', turns: 0 });
    expect(takeTurn).not.toHaveBeenCalled();
  });

  it('checks the cost cap before a turn against spent plus the next turn’s estimate', async () => {
    // $0.04 per turn, estimate $0.05: after two turns ($0.08) the next could pass $0.12.
    const { deps, takeTurn } = harness({
      limits: { costUsd: 0.12 },
      costPerTurn: 0.04,
      estimate: 0.05,
    });
    const end = await drive(runLoop(deps, 'continue', new AbortController().signal));
    expect(end).toEqual({ reason: 'cost', turns: 2 });
    expect(takeTurn).toHaveBeenCalledTimes(2);
  });

  it('checks the cost cap again after a turn', async () => {
    const { deps } = harness({ limits: { costUsd: 0.1 }, costPerTurn: 0.06, estimate: 0.01 });
    const end = await drive(runLoop(deps, 'continue', new AbortController().signal));
    // 0.06 + 0.01 < 0.1, so turn 2 runs; then 0.12 >= 0.1.
    expect(end).toEqual({ reason: 'cost', turns: 2 });
  });

  it('skips the pre-check when the estimate is unknown, and never ends free conversations on a $0 cap', async () => {
    const unknown = harness({
      limits: { costUsd: 0.05, turns: 3 },
      costPerTurn: 0.01,
      estimate: null,
    });
    expect(await drive(runLoop(unknown.deps, 'continue', new AbortController().signal))).toEqual({
      reason: 'turns',
      turns: 3,
    });
    const free = harness({ limits: { costUsd: 0, turns: 2 }, costPerTurn: 0, estimate: 0 });
    expect(await drive(runLoop(free.deps, 'continue', new AbortController().signal))).toEqual({
      reason: 'turns',
      turns: 2,
    });
  });

  it('ends when either bot says the stop phrase', async () => {
    const { deps } = harness({
      reply: (turn) => (turn === 3 ? 'Good talk. [END]' : `Turn ${turn}`),
    });
    expect(await drive(runLoop(deps, 'continue', new AbortController().signal))).toEqual({
      reason: 'phrase',
      turns: 3,
    });
  });

  it('lets the first condition hit win: the stop phrase on the last allowed turn', async () => {
    const { deps } = harness({
      limits: { turns: 2 },
      reply: (turn) => (turn === 2 ? 'Done [END]' : 'Hi'),
    });
    expect(await drive(runLoop(deps, 'continue', new AbortController().signal))).toEqual({
      reason: 'phrase',
      turns: 2,
    });
  });

  it('propagates Stop as an abort (the turn keeps its partial text)', async () => {
    const { deps, state } = harness({ hang: () => true });
    const controller = new AbortController();
    deps.takeTurn = vi.fn<LoopDeps['takeTurn']>(
      (signal, timeUp) =>
        new Promise((_resolve, reject) => {
          const stop = (): void => {
            state.partials.push('partial');
            reject(new DOMException(timeUp() ? 'Time' : 'Stopped.', 'AbortError'));
          };
          signal.addEventListener('abort', stop);
          controller.signal.addEventListener('abort', stop);
        }),
    );
    const loop = runLoop(deps, 'continue', controller.signal);
    const outcome = expect(loop).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(2000);
    controller.abort();
    await outcome;
    expect(state.partials).toEqual(['partial']);
  });
});

describe('moderation', () => {
  it('Step runs exactly one turn and holds', async () => {
    const { deps, takeTurn } = harness();
    expect(await drive(runLoop(deps, 'step', new AbortController().signal))).toEqual({
      reason: null,
      turns: 1,
    });
    expect(takeTurn).toHaveBeenCalledTimes(1);
  });

  it('Pause finishes the turn in flight, then holds', async () => {
    const { deps, state } = harness({ turnMs: 4000 });
    const loop = runLoop(deps, 'continue', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    state.pause = true; // pressed during turn 1
    expect(await drive(loop)).toEqual({ reason: null, turns: 1 });
  });

  it('lets a stop condition win over a pause on the same turn', async () => {
    const { deps, state } = harness({ limits: { turns: 1 } });
    state.pause = true;
    expect(await drive(runLoop(deps, 'continue', new AbortController().signal))).toEqual({
      reason: 'turns',
      turns: 1,
    });
  });
});

describe('limit helpers', () => {
  it('blockedBy names the limit that forbids another turn', () => {
    const limits: Limits = { turns: 5, timeMs: MINUTE, costUsd: 0.1, stopPhrase: '' };
    expect(blockedBy({ turns: 5, elapsedMs: 0, spentUsd: 0 }, limits, 0)).toBe('turns');
    expect(blockedBy({ turns: 1, elapsedMs: MINUTE, spentUsd: 0 }, limits, 0)).toBe('time');
    expect(blockedBy({ turns: 1, elapsedMs: 0, spentUsd: 0.1 }, limits, 0)).toBe('cost');
    expect(blockedBy({ turns: 1, elapsedMs: 0, spentUsd: 0.09 }, limits, 0.02)).toBe('cost');
    expect(blockedBy({ turns: 1, elapsedMs: 0, spentUsd: 0.09 }, limits, null)).toBeNull();
    expect(blockedBy({ turns: 1, elapsedMs: 0, spentUsd: 0 }, limits, 0)).toBeNull();
  });

  it('capReached needs spending; saysPhrase needs a phrase', () => {
    expect(capReached(0, 0)).toBe(false);
    expect(capReached(0.25, 0.25)).toBe(true);
    expect(saysPhrase('All done [END]', '[END]')).toBe(true);
    expect(saysPhrase('All done', '[END]')).toBe(false);
    expect(saysPhrase('anything', '  ')).toBe(false);
  });
});
