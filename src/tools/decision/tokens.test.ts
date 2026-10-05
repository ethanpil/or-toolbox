import { describe, expect, it } from 'vitest';
import documentedRequest from '../../../tests/fixtures/openrouter/decisions-request.documented.json';
import documentedResponse from '../../../tests/fixtures/openrouter/decisions-response.documented.json';
import mercuryResponse from '../../../tests/fixtures/openrouter/decisions-response.recorded.json';
import type { DecisionRequest } from '../../core/api/types';
import { approxTokens } from '../../core/tokens';
import {
  contextInputTokens,
  contextProblem,
  DEFAULT_CONTEXT_TOKENS,
  estimateInputTokens,
} from './tokens';

const triageQuestions = (documentedRequest as unknown as DecisionRequest).questions;

describe('token estimates', () => {
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

  it('counts the context a request takes close to the billed tokens of the tutorial request', () => {
    const tokens = contextInputTokens(documentedRequest as unknown as DecisionRequest);
    expect(tokens).toBeGreaterThanOrEqual(documentedResponse.usage.input_tokens * 0.8);
    expect(tokens).toBeLessThanOrEqual(documentedResponse.usage.input_tokens * 1.3);
  });

  it('counts prose as prose when deciding whether a request fits', () => {
    // 120,000 characters of text are about 30,000 tokens: they fit a 32,000 token context. The inflated
    // estimate used for the price (JSON is heavier than prose) would have refused them.
    const request = { state: 'word '.repeat(24_000), questions: triageQuestions };
    expect(contextProblem(contextInputTokens(request), DEFAULT_CONTEXT_TOKENS)).toBeNull();
    expect(estimateInputTokens(request)).toBeGreaterThan(DEFAULT_CONTEXT_TOKENS);
    expect(estimateInputTokens(request)).toBeGreaterThan(contextInputTokens(request) * 2);
  });

  it('still refuses prose that cannot fit', () => {
    const request = { state: 'word '.repeat(30_000), questions: triageQuestions };
    expect(contextInputTokens(request)).toBeGreaterThan(DEFAULT_CONTEXT_TOKENS);
    expect(contextProblem(contextInputTokens(request), DEFAULT_CONTEXT_TOKENS)).not.toBeNull();
  });

  it('reads the values of key-value fields as prose and their names as structure', () => {
    const prose = approxTokens('word '.repeat(10_000));
    const request = {
      state: { notes: 'word '.repeat(10_000) },
      questions: triageQuestions,
    };
    const tokens = contextInputTokens(request);
    expect(tokens).toBeGreaterThan(prose);
    expect(tokens).toBeLessThan(prose + 1500);
  });

  it('refuses a request that cannot fit, naming both numbers', () => {
    expect(contextProblem(31_999, DEFAULT_CONTEXT_TOKENS)).toBeNull();
    expect(contextProblem(DEFAULT_CONTEXT_TOKENS, DEFAULT_CONTEXT_TOKENS)).toBeNull();
    expect(contextProblem(40_000, DEFAULT_CONTEXT_TOKENS)).toContain('40,000');
    expect(contextProblem(40_000, DEFAULT_CONTEXT_TOKENS)).toContain('32,000');
    expect(DEFAULT_CONTEXT_TOKENS).toBe(32_000);
  });
});
