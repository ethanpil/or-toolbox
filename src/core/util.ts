/**
 * Small helpers shared by every core module. Before adding a local copy of anything here, import it.
 */

// --- abort and timing ------------------------------------------------------------------------------

/** The error every aborted operation rejects with (`isAbortError` in errors.ts recognises it). */
export function abortError(message = 'The operation was aborted.'): DOMException {
  return new DOMException(message, 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Resolves after `ms`, or rejects with an AbortError as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Browsers clamp setTimeout delays above 2^31-1 ms to ~0; never schedule longer than this. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Typing waits this long before a searchable list is filtered again (the same in every one). */
export const SEARCH_DEBOUNCE_MS = 150;

/** A function that waits for `ms` of quiet before running; see `debounce`. */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drops a pending call (a closed dialog, a page that moved on). */
  cancel(): void;
}

/** Runs `fn` with the latest arguments once calls have stopped for `ms`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  debounced.cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return debounced;
}

// --- Web Locks -------------------------------------------------------------------------------------

/** The Web Locks API, or null where it is missing or refused. */
export function webLocks(): LockManager | null {
  try {
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null;
  } catch {
    return null;
  }
}

/** The tail of each lock name's in-page queue (see `withLock`). */
const lockQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` holding the Web Lock `name`: one at a time across tabs, and in this page through an in-page queue,
 * which is all there is where Web Locks are missing or refused. Never nest two calls with the same name (it
 * waits for itself, as a Web Lock would).
 */
export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const locks = webLocks();
    if (!locks) return fn();
    let started = false;
    try {
      return await locks.request(name, () => {
        started = true;
        return fn();
      });
    } catch (error) {
      if (started) throw error;
      return fn(); // the Locks API refused: the in-page queue still serialises this page
    }
  };
  const result = (lockQueues.get(name) ?? Promise.resolve()).then(run, run);
  const tail = result.catch(() => undefined);
  lockQueues.set(name, tail);
  void tail.then(() => {
    if (lockQueues.get(name) === tail) lockQueues.delete(name);
  });
  return result;
}

const noop = (): void => undefined;

/**
 * Holds the Web Lock `name` until the returned release is called: for locks held as long as something lives (a
 * run, a conversation being run). Resolves once the lock is held; with `ifAvailable`, with null when another tab
 * or page holds it. Where Web Locks are missing or refused, it resolves with a release that does nothing (nothing
 * can be held, and nothing stops the caller).
 */
export function holdLock(
  name: string,
  opts: { ifAvailable?: boolean } = {},
): Promise<(() => void) | null> {
  const locks = webLocks();
  if (!locks) return Promise.resolve(noop);
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    locks
      .request(name, { ifAvailable: opts.ifAvailable === true }, async (lock) => {
        if (!lock) return resolve(null);
        resolve(release);
        await held;
      })
      .catch(() => resolve(noop));
  });
}

// --- time ------------------------------------------------------------------------------------------

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** UTC calendar day, `YYYY-MM-DD` (stats rows, budgets, OpenRouter's own daily counters). */
export function utcDay(time: number = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** First UTC day of the month containing `time`, `YYYY-MM-01`. */
export function utcMonthStart(time: number = Date.now()): string {
  return `${utcDay(time).slice(0, 7)}-01`;
}

// --- type guards -----------------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A plain object (literal or null-prototype), not an array, class instance, Blob… */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

// --- untrusted JSON --------------------------------------------------------------------------------

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True for keys that must never be copied from untrusted data into an object. */
export function isUnsafeKey(key: string): boolean {
  return UNSAFE_KEYS.has(key);
}

/**
 * Parse JSON from storage, files or the network without letting `__proto__`/`constructor`/`prototype`
 * keys through (JSON.parse creates them as own properties, and a later spread or assignment would swap
 * prototypes). Throws SyntaxError like JSON.parse.
 */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => (isUnsafeKey(key) ? undefined : value));
}

/** Copy of already-parsed data with unsafe keys removed at every depth. */
export function stripUnsafeKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => stripUnsafeKeys(item)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!isUnsafeKey(key)) out[key] = stripUnsafeKeys(child);
  }
  return out as T;
}
