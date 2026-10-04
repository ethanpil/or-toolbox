import { describe, expect, it } from 'vitest';
import documentedRequest from '../../../tests/fixtures/openrouter/decisions-request.documented.json';
import documentedResponse from '../../../tests/fixtures/openrouter/decisions-response.documented.json';
import mercuryResponse from '../../../tests/fixtures/openrouter/decisions-response.recorded.json';
import type { DecisionRequest } from '../../core/api/types';
import {
  approxTokens,
  contextProblem,
  DEFAULT_CONTEXT_TOKENS,
  estimateInputTokens,
} from './tokens';

describe('token estimates', () => {
  it('counts Latin text at four characters a token and wide scripts at one', () => {
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('你好世界')).toBe(4);
    expect(approxTokens('こんにちは')).toBe(5);
    expect(approxTokens('привет')).toBe(3);
  });

  it('is above what the models billed for the tutorial request', () => {
    const request = documentedRequest as unknown as DecisionRequest;
    const estimate = estimateInputTokens(request);
    // Jev billed 476 and Mercury 253 for these 830 characters of JSON (docs/openrouter-api.md §8.2).
    expect(estimate).toBeGreaterThanOrEqual(documentedResponse.usage.input_tokens);
    expect(estimate).toBeGreaterThanOrEqual(mercuryResponse.usage.input_tokens);
    // And not absurdly above it.
    expect(estimate).toBeLessThan(documentedResponse.usage.input_tokens * 1.5);
  });

  it('grows with the situation', () => {
    const small = estimateInputTokens({ state: 'a', questions: {} });
    const large = estimateInputTokens({ state: 'a'.repeat(4000), questions: {} });
    expect(large).toBeGreaterThan(small + 1000);
  });

  it('refuses a request that cannot fit, naming both numbers', () => {
    expect(contextProblem(31_999, DEFAULT_CONTEXT_TOKENS)).toBeNull();
    expect(contextProblem(DEFAULT_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS)).toBeNull();
    expect(contextProblem(40_000, DEFAULT_CONTEXT_TOKENS)).toContain('40,000');
    expect(contextProblem(40_000, DEFAULT_CONTEXT_TOKENS)).toContain('32,000');
    expect(DEFAULT_CONTEXT_TOKENS).toBe(32_000);
  });
});
