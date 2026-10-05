/**
 * Video studio's persisted state in `ctx.state` (IndexedDB `kv`, JSON only): the timeline (`timeline`) and the
 * sequence run (`sequence`). Every change is a read-modify-write under one Web Lock shared by the tool's tabs (and
 * one queue in the page), so two tabs never start the same sequence step or lose each other's clips; the store
 * announces each write as `tool-state-changed`, and the tool reads it again.
 */
import type { ToolStateStore } from '../../core/types';
import { withLock } from '../../core/util';
import { parseRun, type SequenceRun } from './sequence';
import { parseTimeline, type TimelineClip, timelineJson } from './timeline';

export const TIMELINE_KEY = 'timeline';
export const SEQUENCE_KEY = 'sequence';
const LOCK = 'ortoolbox:video-studio:state';

/** Reads and writes inside one locked step. */
export interface StoreTransaction {
  timeline(): Promise<TimelineClip[]>;
  sequence(): Promise<SequenceRun | null>;
  setTimeline(clips: readonly TimelineClip[]): Promise<void>;
  setSequence(run: SequenceRun | null): Promise<void>;
}

export interface StudioStore {
  timeline(): Promise<TimelineClip[]>;
  sequence(): Promise<SequenceRun | null>;
  /** Read-modify-write of the timeline; `fn` returning the same array writes nothing. */
  updateTimeline(
    fn: (clips: readonly TimelineClip[]) => readonly TimelineClip[],
  ): Promise<TimelineClip[]>;
  /** Read-modify-write of the sequence run; `fn` returning the same object writes nothing. */
  updateSequence(fn: (run: SequenceRun | null) => SequenceRun | null): Promise<SequenceRun | null>;
  /** Several reads and writes as one locked step. Never call the store's other methods inside `fn`. */
  transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}

export function createStore(state: ToolStateStore): StudioStore {
  const locked = <T>(fn: () => Promise<T>): Promise<T> => withLock(LOCK, fn);

  const tx: StoreTransaction = {
    timeline: async () => parseTimeline(await state.get(TIMELINE_KEY)),
    sequence: async () => parseRun(await state.get(SEQUENCE_KEY)),
    setTimeline: (clips) => state.set(TIMELINE_KEY, timelineJson(clips)),
    setSequence: (run) =>
      run === null ? state.delete(SEQUENCE_KEY) : state.set(SEQUENCE_KEY, run),
  };

  return {
    timeline: () => tx.timeline(),
    sequence: () => tx.sequence(),
    updateTimeline: (fn) =>
      locked(async () => {
        const current = await tx.timeline();
        const next = fn(current);
        if (next === current) return current;
        await tx.setTimeline(next);
        return [...next];
      }),
    updateSequence: (fn) =>
      locked(async () => {
        const current = await tx.sequence();
        const next = fn(current);
        if (next === current) return current;
        await tx.setSequence(next);
        return next;
      }),
    transaction: (fn) => locked(() => fn(tx)),
  };
}
