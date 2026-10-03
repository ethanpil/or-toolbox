/**
 * Maps OpenRouter error bodies to ApiError (docs/openrouter-api.md §12.2). Two shapes exist:
 * `{error:{code, message, metadata?}, user_id?}` and, on some validation routes, the ZodError shape
 * `{success:false, error:{name:'ZodError', message:'<JSON array of issues>'}}`.
 *
 * `message` is short and safe to show. Provider text (`metadata.raw`) stays in `detail.metadata`. Fields that
 * identify the account (`user_id`, …) are never copied.
 */

import { ApiError, RateLimitError, type ApiErrorDetail } from '../errors';

/** Keys removed from `error.metadata` before it is kept on the error. */
const ACCOUNT_KEYS = new Set([
  'user_id',
  'creator_user_id',
  'workspace_id',
  'organization_id',
  'app_id',
]);

const MAX_MESSAGE = 300;

export interface ErrorContext {
  generationId?: string | null;
  providerName?: string | null;
  midStream?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > MAX_MESSAGE ? `${trimmed.slice(0, MAX_MESSAGE - 1)}…` : trimmed;
}

function sanitizeMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ACCOUNT_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function retryAfterMs(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata) return undefined;
  const seconds = metadata['retry_after_seconds'];
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0)
    return seconds * 1000;
  const headers = metadata['headers'];
  if (isRecord(headers)) {
    const value = headers['Retry-After'] ?? headers['retry-after'];
    const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  }
  return undefined;
}

/** HTTP status for an error code found inside a 200 body or SSE chunk (numeric, or strings like `server_error`). */
export function statusFromCode(code: unknown, fallback = 502): number {
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  if (typeof code === 'string') {
    const numeric = Number(code);
    if (Number.isInteger(numeric) && numeric >= 400 && numeric < 600) return numeric;
    if (/rate/i.test(code)) return 429;
    if (/server|internal/i.test(code)) return 500;
  }
  return fallback;
}

function defaultMessage(status: number): string {
  if (status === 401) return 'OpenRouter rejected the key.';
  if (status === 402) return 'Not enough credits, or the key reached its spending limit.';
  if (status === 403)
    return 'OpenRouter refused this request (permissions, guardrail or moderation).';
  if (status === 404) return 'Not found on OpenRouter.';
  if (status === 408) return 'The request timed out at the provider.';
  if (status === 413) return 'The request is too large for this model or provider.';
  if (status === 429) return 'Rate limited. Try again shortly.';
  if (status === 500) return 'OpenRouter had an internal error. Try again.';
  if (status === 502)
    return 'The model provider returned an error. Try again or pick another model.';
  if (status === 503) return 'No provider can serve this model with these settings right now.';
  if (status === 524) return 'The provider timed out. Try again.';
  if (status === 529) return 'The provider is overloaded. Try again shortly.';
  return `OpenRouter returned an error (${status}).`;
}

function messageFor(
  status: number,
  raw: string | undefined,
  metadata: Record<string, unknown> | undefined,
): string {
  if (status === 429) {
    return metadata?.['limit_source'] === 'upstream_provider_shared_pool' ||
      metadata?.['provider_name']
      ? 'The provider is rate-limiting this model. Try again shortly or pick another model.'
      : 'Rate limited by OpenRouter. Free models allow 20 requests a minute; try again shortly.';
  }
  if (status === 402 && metadata?.['limit_source'] === 'openrouter_in_flight_budget') {
    return 'Too many paid requests are running for your balance. Retrying shortly may work.';
  }
  // Generic provider wrappers say nothing useful; 401 and 5xx messages can be masked or internal.
  if (!raw || raw === 'Provider returned error' || status === 401 || status >= 500) {
    return defaultMessage(status);
  }
  return clip(raw);
}

function zodMessage(raw: string): string {
  try {
    const issues: unknown = JSON.parse(raw);
    if (Array.isArray(issues) && isRecord(issues[0])) {
      const issue = issues[0];
      const path = Array.isArray(issue['path']) ? issue['path'].join('.') : '';
      const text = typeof issue['message'] === 'string' ? issue['message'] : 'invalid value';
      return clip(`OpenRouter rejected the request: ${path ? `${path}: ` : ''}${text}`);
    }
  } catch {
    // Not JSON: fall through.
  }
  return 'OpenRouter rejected the request as invalid.';
}

/** Builds the error for a non-2xx response body (already parsed; `undefined` when unreadable). */
export function apiErrorFromBody(
  status: number,
  body: unknown,
  context: ErrorContext = {},
): ApiError {
  const detail: ApiErrorDetail = {};
  if (context.generationId) detail.generationId = context.generationId;
  if (context.providerName) detail.providerName = context.providerName;
  if (context.midStream) detail.midStream = true;

  let message: string;
  const error = isRecord(body) ? body['error'] : undefined;

  if (isRecord(error) && error['name'] === 'ZodError') {
    detail.errorType = 'invalid_request';
    const raw = typeof error['message'] === 'string' ? error['message'] : '';
    try {
      const issues: unknown = JSON.parse(raw);
      if (Array.isArray(issues)) detail.metadata = { issues };
    } catch {
      // Keep going without structured issues.
    }
    message = zodMessage(raw);
  } else if (isRecord(error)) {
    const metadata = sanitizeMetadata(error['metadata']);
    const code = error['code'];
    if (typeof code === 'number' || typeof code === 'string') detail.code = code;
    const raw = typeof error['message'] === 'string' ? error['message'] : undefined;
    if (metadata) {
      const errorType = metadata['error_type'];
      if (typeof errorType === 'string') detail.errorType = errorType;
      const providerName = metadata['provider_name'];
      if (typeof providerName === 'string' && providerName) detail.providerName = providerName;
      const after = retryAfterMs(metadata);
      if (after !== undefined) detail.retryAfterMs = after;
    }
    message = messageFor(status, raw, metadata);
    if (raw && clip(raw) !== message) {
      detail.metadata = { ...metadata, message: raw };
    } else if (metadata) {
      detail.metadata = metadata;
    }
  } else {
    message = defaultMessage(status);
  }

  return status === 429
    ? new RateLimitError(message, status, detail)
    : new ApiError(message, status, detail);
}

/** True when a parsed 2xx body or SSE chunk carries an `error` object instead of a result. */
export function bodyError(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const error = body['error'];
  return isRecord(error) ? error : null;
}
