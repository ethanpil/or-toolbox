import { describe, expect, it } from 'vitest';
import { countWords, normalizeText, splitText, stripMarkdown } from './text';

/** The text with every run of whitespace as one space: what survives a split, whatever the seams were. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('normalizeText', () => {
  it('unifies line ends, collapses spaces and blank lines, trims', () => {
    expect(normalizeText('  One\t two  \r\n\r\n\r\n\nThree \rfour  ')).toBe(
      'One two\n\nThree\nfour',
    );
  });
});

describe('countWords', () => {
  it('counts words, not punctuation', () => {
    expect(countWords("Hello, world! It's a fine day.")).toBe(6);
    expect(countWords('')).toBe(0);
  });

  it('counts CJK words through the segmenter', () => {
    expect(countWords('我喜欢音乐')).toBeGreaterThanOrEqual(2);
  });
});

describe('splitText', () => {
  it('keeps short text in one chunk and packs paragraphs while they fit', () => {
    expect(splitText('Hello there.', 1000)).toEqual(['Hello there.']);
    expect(splitText('First.\n\n\nSecond.', 100)).toEqual(['First.\n\nSecond.']);
    expect(splitText('First.\n\nSecond.', 10)).toEqual(['First.', 'Second.']);
    expect(splitText('  \n\n ', 100)).toEqual([]);
  });

  it('cuts long paragraphs between sentences, never inside one that fits', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => `This is sentence number ${i + 1}.`);
    const chunks = splitText(sentences.join(' '), 120);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk).toMatch(/^This is sentence number \d+\..*\d+\.$/);
    }
    expect(flat(chunks.join(' '))).toBe(flat(sentences.join(' ')));
  });

  it('falls back to clauses, then words, and never cuts a word that fits', () => {
    const clauses = 'one two three, four five six, seven eight nine, ten eleven twelve';
    expect(splitText(clauses, 30)).toEqual([
      'one two three, four five six,',
      'seven eight nine,',
      'ten eleven twelve',
    ]);
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const chunks = splitText(words, 40);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(40);
      expect(chunk).toMatch(/^word\d+( word\d+)*$/);
    }
    expect(chunks.join(' ')).toBe(words);
  });

  it('splits CJK text at its own sentence ends, without spaces', () => {
    const text = '今天天气很好。我们去公园散步吧！你觉得怎么样？好的。';
    const chunks = splitText(text, 10);
    expect(chunks).toEqual(['今天天气很好。', '我们去公园散步吧！', '你觉得怎么样？好的。']);
    expect(chunks.join('')).toBe(text);
  });

  it('cuts text without any boundary between characters, never inside one', () => {
    const cjk = '永'.repeat(25);
    expect(splitText(cjk, 10)).toEqual(['永'.repeat(10), '永'.repeat(10), '永'.repeat(5)]);
    const family = '👨‍👩‍👧'.repeat(5); // 8 UTF-16 units each
    const chunks = splitText(family, 20);
    expect(chunks.join('')).toBe(family);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(/[\uD800-\uDFFF]/u.test(chunk)).toBe(false); // no lone surrogate
      expect(chunk.length % 8).toBe(0);
    }
  });

  it('covers a 10,000-word text in order, every chunk under the limit', () => {
    const paragraph = (n: number): string =>
      Array.from(
        { length: 10 },
        (_, i) => `Paragraph ${n} sentence ${i + 1} has exactly eight words.`,
      ).join(' ');
    const text = Array.from({ length: 125 }, (_, n) => paragraph(n + 1)).join('\n\n');
    expect(countWords(text)).toBe(10_000);
    const chunks = splitText(text, 1000);
    expect(chunks.length).toBeGreaterThan(50);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
    expect(flat(chunks.join(' '))).toBe(flat(text));
  });
});

describe('stripMarkdown', () => {
  it('turns Markdown into speakable text', async () => {
    const markdown = [
      '---',
      'title: Notes',
      '---',
      '# Hello *world*',
      '',
      'AT&amp;T \\*not emphasis\\* and `code`, a [link](https://example.com), ![a cat](cat.png) and <b>bold</b>.',
      '',
      '- one',
      '- two **strong**',
      '',
      '> A quote.',
      '',
      '| Name | Age |',
      '|------|-----|',
      '| Ana  | 31  |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '***',
      '',
      'A footnote[^1] and snake_case_word.',
      '',
      '[^1]: The note.',
      '[ref]: https://example.com',
    ].join('\n');
    expect(await stripMarkdown(markdown)).toBe(
      [
        'Hello world',
        'AT&T *not emphasis* and code, a link, a cat and bold.',
        'one\ntwo strong',
        'A quote.',
        'Name, Age\nAna, 31',
        'const x = 1;',
        'A footnote and snake_case_word.',
      ].join('\n\n'),
    );
  });
});
