import { describe, expect, it } from 'vitest';
import chatError200 from '../../../tests/fixtures/openrouter/chat-completion-error-200.documented.json';
import { ApiError, RateLimitError } from '../errors';
import { apiErrorFromBody, bodyError, statusFromCode } from './error-map';

/** Every error body recorded or documented (the data-URL one wraps its body in `response`). */
const fixtures = import.meta.glob<unknown>(
  [
    '../../../tests/fixtures/openrouter/error-*.json',
    '../../../tests/fixtures/openrouter/auth-keys-invalid-code-400.json',
  ],
  { eager: true, import: 'default' },
);

function bodyOf(name: string): unknown {
  const entry = Object.entries(fixtures).find(([path]) => path.endsWith(`/${name}`));
  if (!entry) throw new Error(`missing fixture ${name}`);
  const value = entry[1] as Record<string, unknown>;
  return 'response' in value ? value['response'] : value;
}

function statusOf(name: string): number {
  const match = /error-(\d{3})\b/.exec(name) ?? /-(\d{3})\.json$/.exec(name);
  const status = Number(match?.[1]);
  if (!Number.isInteger(status)) throw new Error(`no status in ${name}`);
  return status;
}

function map(name: string): ApiError {
  return apiErrorFromBody(statusOf(name), bodyOf(name), { generationId: 'gen-1' });
}

describe('apiErrorFromBody', () => {
  const names = Object.keys(fixtures).map((path) => path.split('/').at(-1) ?? path);

  it('covers every error fixture', () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  it.each(names)('%s maps to a safe ApiError', (name) => {
    const error = map(name);
    const status = statusOf(name);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(status);
    expect(error instanceof RateLimitError).toBe(status === 429);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message.length).toBeLessThanOrEqual(300);
    expect(error.detail.generationId).toBe('gen-1');
    // Account identifiers never survive.
    expect(JSON.stringify(error.detail)).not.toMatch(/user_|creator_user_id|workspace_id/);
    expect(error.message).not.toMatch(/user_/);
  });

  it('keeps OpenRouter validation messages that list accepted values', () => {
    expect(map('error-400-images-aspect-ratio.recorded.json').message).toContain(
      'Accepted: 1:1, 3:2, 2:3, auto',
    );
    expect(map('error-400-video-duration.recorded.json').message).toContain('Supported durations');
    expect(map('error-400-video-resolution.recorded.json').detail.metadata).toMatchObject({
      failed_routing_step: 'Validate Video Parameters',
    });
    expect(map('error-400-speech-gemini-mp3.recorded.json').message).toBe(
      'Gemini TTS only supports response_format="pcm". Got "mp3".',
    );
    expect(map('error-400-video-data-url-input-reference.recorded.json').message).toContain(
      'Only HTTPS URLs are allowed',
    );
    expect(map('auth-keys-invalid-code-400.json').message).toBe('Invalid code');
  });

  it('reads the ZodError shape', () => {
    const zod = map('error-400-zod-validation.json');
    expect(zod.message).toBe(
      'OpenRouter rejected the request: input: Invalid input: expected string, received undefined',
    );
    expect(zod.detail.errorType).toBe('invalid_request');
    expect(Array.isArray(zod.detail.metadata?.['issues'])).toBe(true);
    expect(map('error-400-output-modalities.json').message).toMatch(
      /^OpenRouter rejected the request: output_modalities: Invalid output_modalities value/,
    );
  });

  it('marks retryable statuses', () => {
    expect(map('error-401.json').retryable).toBe(false);
    expect(map('error-401-invalid-key.json').message).toBe('OpenRouter rejected the key.');
    expect(map('error-402-chat-image-balance.recorded.json').retryable).toBe(false);
    expect(map('error-402-in-flight-budget.documented.json').retryable).toBe(true);
    expect(map('error-404-data-policy.recorded.json').retryable).toBe(false);
    expect(map('error-429-upstream.recorded.json').retryable).toBe(true);
    expect(map('error-502-provider.documented.json').retryable).toBe(true);
  });

  it('reads 429 details from the body (Retry-After is not readable cross-origin)', () => {
    const first = map('error-429-upstream.recorded.json');
    expect(first.detail.providerName).toBe('Google AI Studio');
    expect(first.detail.retryAfterMs).toBeUndefined();
    expect(first.message).toMatch(/provider is rate-limiting/);
    expect(first.detail.metadata?.['raw']).toMatch(/temporarily rate-limited upstream/);

    const second = map('error-429-upstream-2.recorded.json');
    expect(second.detail.retryAfterMs).toBe(1000);
    expect(map('error-429.documented.json').message).toMatch(/20 requests a minute/);
    expect(map('error-429.documented.json').detail.errorType).toBe('rate_limit_exceeded');
  });

  it('keeps the original text in metadata when the message is replaced', () => {
    const error = map('error-502-provider.documented.json');
    expect(error.message).toMatch(/provider returned an error/i);
    expect(error.detail.metadata?.['message']).toBe('Provider returned error');
    expect(error.detail.errorType).toBe('provider_unavailable');
  });

  it('handles unreadable bodies', () => {
    expect(apiErrorFromBody(503, undefined).message).toMatch(/No provider/);
    expect(apiErrorFromBody(418, 'teapot').message).toBe('OpenRouter returned an error (418).');
  });
});

describe('bodyError / statusFromCode', () => {
  it('detects an error inside a 200 body', () => {
    const error = bodyError(chatError200);
    expect(error?.['message']).toBe('Provider disconnected mid-stream');
    expect(statusFromCode(error?.['code'])).toBe(502);
    expect(bodyError({ choices: [] })).toBeNull();
  });

  it('maps numeric and string codes', () => {
    expect(statusFromCode(429)).toBe(429);
    expect(statusFromCode('429')).toBe(429);
    expect(statusFromCode('server_error')).toBe(500);
    expect(statusFromCode('rate_limit_exceeded')).toBe(429);
    expect(statusFromCode('provider_overloaded')).toBe(529);
    expect(statusFromCode(undefined)).toBe(502);
  });

  it('matches string codes exactly: no rate limit read into a word that merely contains "rate"', () => {
    for (const code of [
      'failed_to_generate',
      'content_moderated',
      'corporate_policy',
      'integrate_failed',
      'moderated',
      'my_server_thing',
    ]) {
      expect(statusFromCode(code), code).toBe(502);
    }
    expect(statusFromCode('constructor')).toBe(502);
  });
});
