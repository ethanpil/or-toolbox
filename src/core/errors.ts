/**
 * Every error the core throws on purpose. All extend `OrError` and carry a stable `code`, so the shell can
 * map any failure to the right message and action ("Add a key", "Unlock", "Turn off free-only", "Retry"…)
 * by switching on `errorCode(error)` instead of importing classes from many modules. Throw these, never bare
 * Errors, for anything the user can act on. Modules that historically defined their own classes re-export
 * them from here.
 */

import type { BudgetCheck } from './types';

export type ErrorCode =
  | 'api'
  | 'rate-limited'
  | 'network'
  | 'no-key'
  | 'locked'
  | 'wrong-passphrase'
  | 'keys-changed'
  | 'invalid-key'
  | 'free-only'
  | 'budget-blocked'
  | 'cancelled'
  | 'oauth'
  | 'backup'
  | 'storage-full'
  | 'not-json-safe'
  | 'invalid-input';

/** Base class: `message` is always safe to show to the user. */
export class OrError extends Error {
  override readonly name: string = 'OrError';
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

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

/** Any non-2xx response, or an error chunk inside a 200 stream. */
export class ApiError extends OrError {
  override readonly name: string = 'ApiError';
  readonly status: number;
  readonly detail: ApiErrorDetail;

  constructor(
    message: string,
    status: number,
    detail: ApiErrorDetail = {},
    code: ErrorCode = 'api',
  ) {
    super(code, message);
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
  constructor(message: string, status = 429, detail: ApiErrorDetail = {}) {
    super(message, status, detail, 'rate-limited');
  }
}

/** fetch() rejected, or a response body could not be read, without a usable HTTP answer. */
export class NetworkError extends OrError {
  override readonly name = 'NetworkError';
  constructor(
    message = 'Network error. Check your connection and try again.',
    options?: { cause?: unknown },
  ) {
    super('network', message, options);
  }
}

/** No key is configured for this tool. The shell offers "Add a key" / "Connect with OpenRouter". */
export class NoKeyError extends OrError {
  override readonly name = 'NoKeyError';
  constructor(message = 'Add an OpenRouter key to run this tool.') {
    super('no-key', message);
  }
}

/** The passphrase lock is on and this tab has not unlocked it. The shell shows the unlock dialog. */
export class KeyLockedError extends OrError {
  override readonly name = 'KeyLockedError';
  constructor(message = 'Your keys are locked. Enter your passphrase to continue.') {
    super('locked', message);
  }
}

export class WrongPassphraseError extends OrError {
  override readonly name = 'WrongPassphraseError';
  constructor(message = 'Wrong passphrase.') {
    super('wrong-passphrase', message);
  }
}

/** Another tab changed the keys file between our read and write; nothing was written. */
export class KeysChangedError extends OrError {
  override readonly name = 'KeysChangedError';
  constructor(message = 'Your keys changed in another tab. Try again.') {
    super('keys-changed', message);
  }
}

export class InvalidKeyError extends OrError {
  override readonly name = 'InvalidKeyError';
  constructor(message = 'That does not look like an OpenRouter key (they start with sk-or-).') {
    super('invalid-key', message);
  }
}

/** Free-only mode is on and the run would use a paid model. */
export class FreeOnlyError extends OrError {
  override readonly name = 'FreeOnlyError';
  readonly models: string[];
  /** Labels of the paid add-ons (`RunSpec.addons`) that were refused. */
  readonly addons: string[];

  constructor(models: string[], addons: string[] = []) {
    const names = [...models, ...addons];
    super(
      'free-only',
      `Free-only mode is on, and ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not free.`,
    );
    this.models = models;
    this.addons = addons;
  }
}

/** A hard-stop budget rule blocks the run. */
export class BudgetBlockedError extends OrError {
  override readonly name = 'BudgetBlockedError';
  readonly check: BudgetCheck;

  constructor(check: BudgetCheck) {
    super(
      'budget-blocked',
      check.reasons.map((r) => r.message).join(' ') || 'This run would exceed your budget.',
    );
    this.check = check;
  }
}

/** The user declined a budget confirmation. Not an error worth reporting; tools just stop quietly. */
export class RunCancelledError extends OrError {
  override readonly name = 'RunCancelledError';
  constructor(message = 'Run cancelled.') {
    super('cancelled', message);
  }
}

export class OAuthError extends OrError {
  override readonly name = 'OAuthError';
  constructor(message: string, options?: { cause?: unknown }) {
    super('oauth', message, options);
  }
}

/** A backup file is unreadable, invalid, or its passphrase is wrong; nothing was imported. */
export class BackupError extends OrError {
  override readonly name = 'BackupError';
  constructor(message: string, options?: { cause?: unknown }) {
    super('backup', message, options);
  }
}

export class StorageFullError extends OrError {
  override readonly name = 'StorageFullError';
  constructor(message = 'Browser storage is full. Delete some history in Settings → Data.') {
    super('storage-full', message);
  }
}

/** A value that must be JSON-safe (tool state, settings) contained a Blob, ArrayBuffer, function… */
export class NotJsonSafeError extends OrError {
  override readonly name = 'NotJsonSafeError';
  constructor(message: string) {
    super('not-json-safe', message);
  }
}

/** A caller passed something the operation cannot accept (unsupported option, empty input, bad file). */
export class InvalidInputError extends OrError {
  override readonly name = 'InvalidInputError';
  constructor(message: string, options?: { cause?: unknown }) {
    super('invalid-input', message, options);
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** The code of an OrError, `'aborted'` for aborts, or `'unknown'`. */
export function errorCode(error: unknown): ErrorCode | 'aborted' | 'unknown' {
  if (isAbortError(error)) return 'aborted';
  return error instanceof OrError ? error.code : 'unknown';
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
  if (error instanceof OrError) return error.message;
  // Anything else is unexpected: never echo raw engine messages ("Cannot read properties of undefined").
  return 'Something went wrong. Try again, and if it keeps happening reload the page.';
}
