import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import {
  fallbackMode,
  isUnsupportedStrict,
  outputMode,
  responseRefusal,
} from './structured-output';

describe('structured outputs', () => {
  it('picks strict structured outputs, JSON mode or the prompt from the model’s parameters', () => {
    expect(outputMode(['max_tokens', 'structured_outputs', 'response_format'])).toBe('schema');
    expect(outputMode(['structured_outputs'])).toBe('schema');
    expect(outputMode(['response_format'])).toBe('json');
    expect(outputMode([])).toBe('prompt');
  });

  it('recognises a strict request no provider can serve, and the mode to fall back to', () => {
    expect(
      isUnsupportedStrict(
        new ApiError('No endpoints found that can handle the requested parameters.', 404),
      ),
    ).toBe(true);
    expect(
      isUnsupportedStrict(
        new ApiError('This model does not support response_format json_schema', 400),
      ),
    ).toBe(true);
    expect(isUnsupportedStrict(new ApiError('Not found on OpenRouter.', 404))).toBe(false);
    expect(isUnsupportedStrict(new ApiError('Rate limited', 429))).toBe(false);
    expect(isUnsupportedStrict(new Error('No endpoints found'))).toBe(false);
    expect(fallbackMode(['response_format', 'structured_outputs'])).toBe('json');
    expect(fallbackMode(['structured_outputs'])).toBe('prompt');
  });

  it('finds a refusal in a non-streamed answer', () => {
    const answer = (message: Record<string, unknown>, finish: string | null = 'stop') => ({
      id: 'g',
      model: 'm',
      choices: [
        {
          index: 0,
          finish_reason: finish,
          message: { role: 'assistant' as const, content: null, ...message },
        },
      ],
    });
    expect(responseRefusal(answer({ content: '{"a":1}' }))).toBeNull();
    expect(responseRefusal(answer({ content: null, refusal: 'I cannot help with that.' }))).toBe(
      'I cannot help with that.',
    );
    expect(responseRefusal(answer({ content: '' }, 'content_filter'))).toMatch(/content filter/);
    expect(responseRefusal(answer({ content: '' }, 'error'))).toMatch(/error before answering/);
    // Text with a filter finish is an answer, whatever the reason it stopped.
    expect(responseRefusal(answer({ content: '{"a":1}' }, 'content_filter'))).toBeNull();
  });
});
