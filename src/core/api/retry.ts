/**
 * Retry timing for the API client: exponential backoff with full jitter, honouring the server's
 * `error.metadata.retry_after_seconds` (the `Retry-After` header is not readable cross-origin,
 * docs/openrouter-api.md §12.3). Sleeps reject as soon as the signal aborts.
 */

export interface RetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Cap of the first backoff window; doubles per attempt. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** A server asking for a longer wait than this is not retried (e.g. a daily cap). */
  maxRetryAfterMs: number;
  /** [0, 1) source for jitter; injectable for tests. */
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  maxRetryAfterMs: 30_000,
  random: Math.random,
};

/**
 * Delay before the next attempt after `attempt` (1-based) failed, or null when no retry should happen.
 * `retryAfterMs` comes from the error body when the server sent one.
 */
export function retryDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
): number | null {
  if (attempt >= policy.maxAttempts) return null;
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return retryAfterMs > policy.maxRetryAfterMs ? null : retryAfterMs;
  }
  const window = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(policy.random() * window);
}

/** The error every aborted operation rejects with (`isAbortError` recognises it). */
export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
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
