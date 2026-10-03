/**
 * Retry timing for the API client: exponential backoff with full jitter, honouring the server's
 * `error.metadata.retry_after_seconds` (the `Retry-After` header is not readable cross-origin,
 * docs/openrouter-api.md §12.3). Which failures may be retried at all is decided in client.ts.
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
