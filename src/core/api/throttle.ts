/**
 * Client-side throttle for `:free` models: at most 20 requests per rolling minute (docs/openrouter-api.md §12.1).
 * Callers queue instead of failing. The window is shared by every tab of the origin through localStorage
 * timestamps (read-modify-write is not atomic across tabs, so two tabs racing can briefly exceed the cap by one
 * or two; OpenRouter's own 429 handling covers that). Without localStorage the window is per tab.
 */

import { local } from '../storage/local';
import { sleep, throwIfAborted } from './retry';

/**
 * localStorage key holding the shared request timestamps (JSON number[]). Not secret, safe to delete.
 * Move into `LS_KEYS` (src/core/storage/local.ts) at integration.
 */
export const FREE_THROTTLE_STORAGE_KEY = 'ortoolbox:free-requests';

export interface FreeThrottleOptions {
  limit?: number;
  windowMs?: number;
  /** Storage for the shared window; return undefined for a per-tab window. */
  storage?: () => Storage | undefined;
  now?: () => number;
}

export class FreeModelThrottle {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly storage: () => Storage | undefined;
  private readonly now: () => number;
  /** Per-tab fallback when storage is unavailable. */
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
    const turn = this.tail.then(() => this.waitForSlot(signal));
    this.tail = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const now = this.now();
      const stamps = this.read(now);
      if (stamps.length < this.limit) {
        stamps.push(now);
        this.write(stamps);
        return;
      }
      const oldest = stamps[stamps.length - this.limit] ?? now;
      await sleep(Math.max(1, oldest + this.windowMs - now), signal);
    }
  }

  private read(now: number): number[] {
    let stamps = this.memory;
    const storage = this.storage();
    if (storage) {
      try {
        const parsed: unknown = JSON.parse(storage.getItem(FREE_THROTTLE_STORAGE_KEY) ?? '[]');
        if (Array.isArray(parsed))
          stamps = parsed.filter((t): t is number => typeof t === 'number');
      } catch {
        // Corrupt value: start a fresh window.
        stamps = [];
      }
    }
    // Drop expired entries and anything stamped in the future by a skewed clock.
    return stamps.filter((t) => t > now - this.windowMs && t <= now + 1000).sort((a, b) => a - b);
  }

  private write(stamps: number[]): void {
    this.memory = stamps;
    try {
      this.storage()?.setItem(FREE_THROTTLE_STORAGE_KEY, JSON.stringify(stamps));
    } catch {
      // Storage full or unavailable: the in-memory window still applies.
    }
  }
}
