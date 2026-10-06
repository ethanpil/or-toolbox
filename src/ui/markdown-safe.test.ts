import { describe, expect, it } from 'vitest';
import { safeBlock } from './markdown-safe';

describe('safeBlock', () => {
  it('escapes headings, rules and long HTML outside code', () => {
    expect(safeBlock('# One\n## Two\ntext\n---\n<!-- c')).toBe(
      '\\# One\n\\## Two\ntext\n\\---\n\\<!-- c',
    );
  });

  it('keeps code inside fences exactly, and closes a fence left open with the same marker', () => {
    expect(safeBlock('```ts\n# not a heading\n```\nafter')).toBe(
      '```ts\n# not a heading\n```\nafter',
    );
    expect(safeBlock('````\ncode\n```\nstill code')).toBe('````\ncode\n```\nstill code\n````');
    expect(safeBlock('~~~\ncode')).toBe('~~~\ncode\n~~~');
  });
});
