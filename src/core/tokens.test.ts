import { describe, expect, it } from 'vitest';
import request from '../../tests/fixtures/openrouter/decisions-request.documented.json';
import {
  approxTokens,
  DEFAULT_OUTPUT_TOKENS,
  fitContext,
  outputCap,
  outputTokens,
  promptBudget,
} from './tokens';

/** The count before structure-aware counting: 4 per token for everything below U+0250. */
function flatCount(text: string): number {
  let latin = 0;
  let other = 0;
  let wide = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x0250) latin += char.length;
    else if (/[฀-໿぀-鿿가-퟿]/.test(char)) wide += char.length;
    else other += char.length;
  }
  return Math.ceil(latin / 4 + other / 2 + wide);
}

const PROSE =
  'The quick brown fox jumps over the lazy dog. It was the best of times, it was the worst of times; most people read about 250 words a minute.';
const CODE =
  'function add(a, b) {\n  return a + b;\n}\nconst total = items.reduce((sum, item) => sum + item.price * item.qty, 0);';
const TABLE =
  '| Name | Qty | Price |\n|---|---:|---:|\n| Apples | 12 | 3.40 |\n| Pears | 7 | 2.15 |';

describe('approxTokens', () => {
  it('counts 4 Latin letters (or spaces) per token, rounding up', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2);
    expect(approxTokens('ab cd ef')).toBe(2);
  });

  it('counts other scripts conservatively', () => {
    expect(approxTokens('你好世界')).toBe(4);
    expect(approxTokens('こんにちは')).toBe(5);
    expect(approxTokens('안녕하세요')).toBe(5);
    expect(approxTokens('สวัสดี')).toBe(6);
    expect(approxTokens('привет')).toBe(3);
  });

  it('weighs digits and ASCII punctuation more than letters: JSON, code and numbers', () => {
    expect(approxTokens('1234567890')).toBe(10); // many tokenizers split every digit
    expect(approxTokens('{}[]:,')).toBe(4); // three marks make two tokens
    expect(approxTokens('{"a": 1}')).toBe(5);
  });

  it('counts the documented decision request above what Mercury billed for it (253)', () => {
    const body = JSON.stringify({ state: request.state, questions: request.questions });
    expect(body).toHaveLength(830);
    expect(flatCount(body)).toBe(208); // the old count
    expect(approxTokens(body)).toBe(269);
  });

  it('never counts fewer than before, for prose or anything else', () => {
    for (const text of [PROSE, CODE, TABLE, 'Ça va très bien, merci!', '你好, world 42']) {
      expect(approxTokens(text)).toBeGreaterThanOrEqual(flatCount(text));
    }
    expect(approxTokens(CODE)).toBeGreaterThan(flatCount(CODE));
    expect(approxTokens(TABLE)).toBeGreaterThan(flatCount(TABLE));
  });
});

describe('output and context limits', () => {
  it('outputCap: the model’s cap, or unlimited when unknown', () => {
    expect(outputCap(8000)).toBe(8000);
    expect(outputCap(null)).toBe(Number.POSITIVE_INFINITY);
    expect(outputCap(0)).toBe(Number.POSITIVE_INFINITY);
    expect(outputCap(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('outputTokens: Max tokens, else the default, within the model’s cap', () => {
    expect(outputTokens(null)).toBe(DEFAULT_OUTPUT_TOKENS);
    expect(outputTokens(null, 1000)).toBe(1000);
    expect(outputTokens(50_000, 8000)).toBe(8000);
    expect(outputTokens(300, 8000)).toBe(300);
  });

  it('promptBudget: the window less a 5% margin, room for the answer (at most half) and the fixed part', () => {
    expect(promptBudget({ context: 32_000, fixed: 100 })).toBe(30_400 - 4096 - 100);
    expect(promptBudget({ context: 4000 })).toBe(3800 - 2000); // the answer's room is capped at half
    expect(promptBudget({ context: 32_000, maxTokens: 1000 })).toBe(30_400 - 1000);
    expect(promptBudget({ context: null })).toBe(Number.POSITIVE_INFINITY);
  });

  it('fitContext: whether the prompt fits, and the output it leaves', () => {
    const fit = fitContext({ context: 32_000, maxTokens: 30_000, fixed: 500, prompt: 10_000 });
    expect(fit).toEqual({
      budget: 30_400 - 16_000 - 500, // the answer's room is capped at half the window
      tooLong: false,
      room: 21_500,
      completionTokens: 21_500,
      maxTokens: 21_500,
    });
    // No Max tokens set: nothing to send, the estimate still assumes the default.
    expect(fitContext({ context: 32_000, prompt: 1000 })).toMatchObject({
      completionTokens: DEFAULT_OUTPUT_TOKENS,
      maxTokens: null,
    });
    // Too long: refused, and never less than one output token.
    expect(fitContext({ context: 8000, prompt: 9000 })).toMatchObject({
      tooLong: true,
      room: 1,
      completionTokens: 1,
    });
    // Unknown window: nothing is refused or clamped but by the model's own cap.
    expect(
      fitContext({ context: null, maxTokens: 50_000, maxCompletionTokens: 8000, prompt: 1e6 }),
    ).toEqual({
      budget: Number.POSITIVE_INFINITY,
      tooLong: false,
      room: Number.POSITIVE_INFINITY,
      completionTokens: 8000,
      maxTokens: 8000,
    });
  });
});
