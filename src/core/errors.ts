/**
 * Error types shared by the core, the shell and the tools. Throw these (not bare Errors) so the shell can
 * show the right message and action: "Add a key", "Unlock", "Turn off free-only", "Retry", …
 */

import type { BudgetCheck } from './types';

export interface ApiErrorDetail {
  /** `error.code` from the body when present (usually equals the HTTP status). */
  code?: number | string;
  /** `error.metadata.error_type`, e.g. `rate_limit_exceeded`, `context_length_exceeded`. */
  errorType?: string;
  /** `error.metadata`, minus anything that identifies the account. */
  metadata?: Record<string, unknown>;
  providerName?: string;
  /** From `error.metadata.retry_after_seconds` (Retry-After itself is not readable cross-origin). */
  retryAfterMs?: number;
  generationId?: string;
  /** True when the error arrived as an SSE chunk after the stream started. */
  midStream?: boolean;
}

/** Any non-2xx response, or an error chunk inside a 200 stream. `message` is safe to show the user. */
export class ApiError extends Error {
  override readonly name: string = 'ApiError';
  readonly status: number;
  readonly detail: ApiErrorDetail;

  constructor(message: string, status: number, detail: ApiErrorDetail = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }

  /** 408, 429, 5xx (and the in-flight-budget 402) are worth retrying; other 4xx are not. */
  get retryable(): boolean {
    if (this.status === 402)
      return this.detail.metadata?.['limit_source'] === 'openrouter_in_flight_budget';
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export class RateLimitError extends ApiError {
  override readonly name = 'RateLimitError';
}

/** fetch() rejected without an HTTP response (offline, DNS, CORS). */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';
}

/** No key is configured for this tool. The shell offers "Add a key" / "Connect with OpenRouter". */
export class NoKeyError extends Error {
  override readonly name = 'NoKeyError';
  constructor(message = 'Add an OpenRouter key to run this tool.') {
    super(message);
  }
}

/** The passphrase lock is on and this tab has not unlocked it. The shell shows the unlock dialog. */
export class KeyLockedError extends Error {
  override readonly name = 'KeyLockedError';
  constructor(message = 'Your keys are locked. Enter your passphrase to continue.') {
    super(message);
  }
}

/** Free-only mode is on and the run would use a paid model. */
export class FreeOnlyError extends Error {
  override readonly name = 'FreeOnlyError';
  readonly models: string[];

  constructor(models: string[]) {
    super(
      `Free-only mode is on, and ${models.join(', ')} ${models.length === 1 ? 'is' : 'are'} not free.`,
    );
    this.models = models;
  }
}

/** A hard-stop budget rule blocks the run. */
export class BudgetBlockedError extends Error {
  override readonly name = 'BudgetBlockedError';
  readonly check: BudgetCheck;

  constructor(check: BudgetCheck) {
    super(check.reasons.map((r) => r.message).join(' ') || 'This run would exceed your budget.');
    this.check = check;
  }
}

/** The user declined a budget confirmation. Not an error worth reporting; tools just stop quietly. */
export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError';
  constructor(message = 'Run cancelled.') {
    super(message);
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** A message that is safe and useful to show in the UI for any thrown value. */
export function userMessage(error: unknown): string {
  if (isAbortError(error)) return 'Stopped.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'OpenRouter rejected the key. Check it in Settings → Keys.';
    if (error.status === 402) return 'Not enough credits, or the key reached its spending limit.';
    if (error.status === 429)
      return 'Rate limited. Free models allow 20 requests a minute; try again shortly.';
    return error.message || `OpenRouter returned an error (${error.status}).`;
  }
  if (error instanceof NetworkError) return 'Network error. Check your connection and try again.';
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong.';
}
