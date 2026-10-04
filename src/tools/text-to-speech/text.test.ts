import { describe, expect, it } from 'vitest';
import { countWords, fileStem, normalizeText, splitText, stripMarkdown } from './text';

/** The text with every run of whitespace as one space: what survives a split, whatever the seams were. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('normalizeText', () => {
  it('unifies line ends, collapses spaces and blank lines, trims', () => {
    expect(normalizeText('  One\t two  \r\n\r\n\r\n\nThree \rfour  ')).toBe(
      'One two\n\nThree\nfour',
    );
  });

  it('treats no-break and ideographic spaces as spaces', () => {
    expect(normalizeText('a\u00a0\u00a0b\u3000c\n\u00a0\n\n\u3000\u3000\nd')).toBe('a b c\n\nd');
  });
});

describe('fileStem', () => {
  it('takes the first words, in any script, and stays short', () => {
    expect(fileStem('Hello there, my friend. How are you?')).toBe('speech-hello-there-my-friend');
    expect(fileStem("Don't stop")).toBe('speech-dont-stop');
    expect(fileStem('...')).toBe('speech');
    const chinese = fileStem('今天天气很好我们去公园散步吧你觉得怎么样好的我们走吧'.repeat(5));
    expect(chinese.startsWith('speech-')).toBe(true);
    expect(chinese.length).toBeLessThanOrEqual('speech-'.length + 32);
    const thai = fileStem('สวัสดีครับวันนี้อากาศดีมากเราไปเดินเล่นที่สวนสาธารณะกันเถอะ'.repeat(5));
    expect(thai.length).toBeLessThanOrEqual('speech-'.length + 32);
    // Thai vowel and tone marks are combining marks: they stay with their letters.
    expect(thai).toContain('สวัสดี');
    expect(fileStem('x'.repeat(200)).length).toBeLessThanOrEqual('speech-'.length + 32);
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

  it('never throws on, or makes parts of, paragraphs of nothing but spaces', () => {
    const nbsp = '\u00a0'.repeat(3000);
    const ideographic = '\u3000'.repeat(3000);
    expect(splitText(`${nbsp}\n\n${ideographic}`, 100)).toEqual([]);
    expect(splitText(`Hello.\n\n${nbsp}\n\nWorld.`, 10)).toEqual(['Hello.', 'World.']);
    expect(splitText(`Hello.${ideographic}World.`, 10)).toEqual(['Hello.', 'World.']);
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

  it('removes front matter only when it is YAML at the very start', async () => {
    expect(await stripMarkdown('---\ntitle: Notes\ntags:\n- a\n  - b\n---\nBody')).toBe('Body');
    expect(await stripMarkdown('---\ntitle: Notes\n...\nBody')).toBe('Body');
    // A leading rule around ordinary text is not front matter.
    expect(await stripMarkdown('---\nHello there.\n---\nMore text.')).toBe(
      'Hello there.\n\nMore text.',
    );
    expect(await stripMarkdown('---\n\nThe start.\n\n---\n\nThe end.')).toBe(
      'The start.\n\nThe end.',
    );
    // Not at the very start: an ordinary paragraph and rule.
    expect(await stripMarkdown('Intro\n\n---\ntitle: x\n---\nBody')).toContain('Intro');
  });

  it('drops script and style contents and HTML comments entirely', async () => {
    expect(
      await stripMarkdown(
        [
          'Before <script>alert(1)</script> after <!-- a note --> end.',
          '',
          '<script>',
          'var hidden = 1;',
          '</script>',
          '',
          '<!--',
          'A comment over',
          'several lines',
          '-->',
          '',
          '<style>p { color: red }</style>',
          '',
          '<div>Kept <!-- not this --> text</div>',
        ].join('\n'),
      ),
    ).toBe('Before after end.\n\nKept text');
  });

  it('keeps a * or _ inside a word or a dunder name as written', async () => {
    expect(await stripMarkdown('3*4*5 is 60, and 2*3 = 6 while 4*5 = 20.')).toBe(
      '3*4*5 is 60, and 2*3 = 6 while 4*5 = 20.',
    );
    expect(
      await stripMarkdown('Call __init__ first; **bold**, _em_ and *em* lose their marks.'),
    ).toBe('Call __init__ first; bold, em and em lose their marks.');
  });
});
