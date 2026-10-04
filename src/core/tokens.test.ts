import { describe, expect, it } from 'vitest';
import { approxTokens } from './tokens';

describe('approxTokens', () => {
  it('counts 4 Latin characters per token, rounding up', () => {
    expect(approxTokens('')).toBe(0);
    expect(approxTokens('abcd')).toBe(1);
    expect(approxTokens('abcde')).toBe(2);
  });

  it('counts other scripts conservatively', () => {
    expect(approxTokens('你好世界')).toBe(4);
    expect(approxTokens('こんにちは')).toBe(5);
    expect(approxTokens('안녕하세요')).toBe(5);
    expect(approxTokens('สวัสดี')).toBe(6);
    expect(approxTokens('привет')).toBe(3);
  });
});
