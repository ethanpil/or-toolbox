/**
 * Client-side throttle for `:free` models: at most 20 requests per rolling minute (docs/openrouter-api.md §12.1).
 * Callers queue instead of failing; an aborted caller leaves the queue at once.
 *
 * The window is shared by every tab through localStorage timestamps (read-modify-write is not atomic across
 * tabs, so two tabs racing can briefly exceed the cap by one or two; OpenRouter's own 429 handling covers that).
 * This tab also keeps the window in memory and merges it with the stored one, so a full, blocked or corrupted
 * storage never resets the window: it only stops other tabs from seeing this tab's requests.
 */

import { LS_KEYS, local } from '../storage/local';
import { abortError, isFiniteNumber, parseJsonSafe, sleep, throwIfAborted } from '../util';

/** localStorage key holding the shared request timestamps (JSON number[]). Not secret, safe to delete. */
export const FREE_THROTTLE_STORAGE_KEY = LS_KEYS.freeRequests;

export interface FreeThrottleOptions {
  limit?: number;
  windowMs?: number;
  /** Storage for the shared window; return undefined for a per-tab window. */
  storage?: () => Storage | undefined;
  now?: () => number;
}

/** Multiset union (per value, the larger count), sorted ascending. */
function union(a: number[], b: number[]): number[] {
  const counts = new Map<number, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  const out = [...a];
  for (const t of b) {
    const left = counts.get(t) ?? 0;
    if (left > 0) counts.set(t, left - 1);
    else out.push(t);
  }
  return out.sort((x, y) => x - y);
}

export class FreeModelThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly storage: () => Storage | undefined;
  private readonly now: () => number;
  /** This tab's view of the window (includes what it last read from storage). */
  private memory: number[] = [];
  /** Serialises callers in this tab so they get slots in arrival order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: FreeThrottleOptions = {}) {
    this.limit = options.limit ?? 20;
    this.windowMs = options.windowMs ?? 60_000;
    this.storage = options.storage ?? local;
    this.now = options.now ?? (() => Date.now());
  }

  /** Waits until a request slot is free, then records the request. Rejects with AbortError on abort. */
  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    const turn = this.tail.then(() => this.waitForSlot(signal));
    this.tail = turn.catch(() => undefined);
    if (!signal) return turn;
    // Leave the queue immediately on abort; when this caller's turn comes, waitForSlot sees the abort and
    // takes no slot.
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const now = this.now();
      const stamps = this.window(now);
      if (stamps.length < this.limit) {
        stamps.push(now);
        this.save(stamps);
        return;
      }
      const oldest = stamps[stamps.length - this.limit] ?? now;
      await sleep(Math.max(1, oldest + this.windowMs - now), signal);
    }
  }

  /** Current window: memory merged with storage, expired and future-dated entries dropped. */
  private window(now: number): number[] {
    let stored: number[] = [];
    try {
      const raw = this.storage()?.getItem(FREE_THROTTLE_STORAGE_KEY);
      const parsed = raw ? parseJsonSafe(raw) : [];
      if (Array.isArray(parsed)) stored = parsed.filter(isFiniteNumber);
    } catch {
      // Blocked or corrupt: the in-memory window still applies.
    }
    const live = (t: number): boolean => t > now - this.windowMs && t <= now + 1000;
    this.memory = union(this.memory.filter(live), stored.filter(live));
    return [...this.memory];
  }

  private save(stamps: number[]): void {
    this.memory = stamps;
    try {
      this.storage()?.setItem(FREE_THROTTLE_STORAGE_KEY, JSON.stringify(stamps));
    } catch {
      // Storage full or unavailable: the in-memory window still applies.
    }
  }
}
