/**
 * Text handling for text-to-speech: tidy the input, count it, turn Markdown into speakable text, and split long
 * text into requests a TTS model accepts.
 *
 * Splitting keeps every piece under the limit and cuts at the most natural place it can: between paragraphs,
 * then between sentences (`Intl.Segmenter`, which also knows CJK sentence ends such as 。！？), then after clause
 * punctuation, then between words, and only as a last resort between characters (graphemes, so an emoji or a
 * combining accent is never cut in half). Pieces are then packed greedily, so a chunk holds as many whole
 * paragraphs or sentences as fit.
 */
import type { Token, Tokens } from 'marked';

/**
 * Unifies line ends, trims line ends and collapses spaces and runs of blank lines. Every kind of space (no-break
 * U+00A0, ideographic U+3000, the typographic ones) counts as a space: a reader pauses the same.
 */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Words as a reader counts them (CJK words included, via the word segmenter); punctuation is not a word. */
export function countWords(text: string): number {
  let count = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) {
    if (segment.isWordLike) count++;
  }
  return count;
}

// --- splitting ------------------------------------------------------------------------------------------

/** A run of text and the separator that goes before it when it is joined to the piece before. */
interface Piece {
  text: string;
  sep: string;
}

/** The separator a run of whitespace stands for: a line break if it held one, else a space. */
function separator(whitespace: string): string {
  if (whitespace === '') return '';
  return whitespace.includes('\n') ? '\n' : ' ';
}

/** Turns raw segments (each with its own surrounding whitespace) into trimmed pieces with separators. */
function toPieces(segments: Iterable<string>): Piece[] {
  const pieces: Piece[] = [];
  let pending = '';
  for (const segment of segments) {
    const text = segment.trim();
    if (!text) {
      pending += segment;
      continue;
    }
    const lead = segment.slice(0, segment.length - segment.trimStart().length);
    pieces.push({ text, sep: pieces.length === 0 ? '' : separator(pending + lead) });
    pending = segment.slice(segment.trimEnd().length);
  }
  return pieces;
}

function segments(text: string, granularity: 'sentence' | 'grapheme'): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity }).segment(text), (s) => s.segment);
}

/** Ways to cut a piece that is too long, from the most to the least natural. */
const SPLITTERS: readonly ((text: string) => Piece[])[] = [
  (text) => toPieces(segments(text, 'sentence')),
  // After clause punctuation (Latin and CJK), keeping the mark with the words before it.
  (text) => toPieces(text.split(/(?<=[,;:\u2013\u2014\uFF0C\u3001\uFF1B\uFF1A])/)),
  (text) => toPieces(text.split(/(?<=\s)/)),
  (text) => segments(text, 'grapheme').map((grapheme) => ({ text: grapheme, sep: '' })),
];

/** Joins neighbouring pieces while the result stays within `max` characters. */
function pack(pieces: readonly Piece[], max: number): Piece[] {
  const packed: Piece[] = [];
  for (const piece of pieces) {
    const last = packed.at(-1);
    if (last && last.text.length + piece.sep.length + piece.text.length <= max) {
      last.text += piece.sep + piece.text;
    } else {
      packed.push({ ...piece });
    }
  }
  return packed;
}

/** Cuts `text` into pieces of at most `max` characters, at the most natural boundaries available. */
function fit(text: string, max: number, level = 0): Piece[] {
  const split = SPLITTERS[level];
  if (text.length <= max || !split) return [{ text, sep: '' }];
  const pieces: Piece[] = [];
  for (const part of split(text)) {
    const sub = fit(part.text, max, level + 1);
    if (!sub[0]) continue;
    sub[0].sep = part.sep;
    pieces.push(...sub);
  }
  return pack(pieces, max);
}

/**
 * Splits text into chunks of at most `maxChars` characters (UTF-16 units, which never undercount), each ending
 * at the most natural boundary that keeps it under the limit. Joining the chunks with a space gives the
 * normalised text back, apart from whitespace at the seams.
 */
export function splitText(text: string, maxChars: number): string[] {
  const max = Math.max(1, Math.floor(maxChars));
  const pieces: Piece[] = [];
  for (const paragraph of normalizeText(text).split('\n\n')) {
    if (!paragraph.trim()) continue;
    const sub = fit(paragraph, max);
    if (!sub[0]) continue;
    sub[0].sep = pieces.length === 0 ? '' : '\n\n';
    pieces.push(...sub);
  }
  return pack(pieces, max)
    .map((piece) => piece.text)
    .filter((chunk) => chunk.trim() !== '');
}

/**
 * `speech-hello-there-friend`: a file name stem from the first few words. Words come from the word segmenter, so
 * Chinese, Japanese and Thai (written without spaces) give words too, and the stem stays short in any script.
 */
export function fileStem(text: string, maxWords = 4, maxChars = 32): string {
  const words: string[] = [];
  let length = 0;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(
    text.slice(0, 500),
  )) {
    if (!segment.isWordLike) continue;
    // Letters, digits and combining marks (Thai and Devanagari vowels are marks): no apostrophes or dots.
    const word = segment.segment.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
    if (!word) continue;
    const room = maxChars - length - (words.length > 0 ? 1 : 0);
    if (room <= 0) break;
    let piece = '';
    for (const { segment: grapheme } of graphemes.segment(word)) {
      if (piece.length + grapheme.length > room) break;
      piece += grapheme;
    }
    if (!piece) break;
    words.push(piece);
    length += piece.length + (words.length > 1 ? 1 : 0);
    if (words.length >= maxWords || piece !== word) break;
  }
  return words.length > 0 ? `speech-${words.join('-')}` : 'speech';
}

// --- Markdown -------------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '\u2014',
  ndash: '\u2013',
};

/** Decodes the character references marked leaves in text: numeric ones and the common named ones. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/** A token's own text: its children's when it has any, else its `text`. */
function ownText(token: Token): string {
  const generic = token as Tokens.Generic;
  if (generic.tokens) return inline(generic.tokens);
  const text: unknown = generic['text'];
  return typeof text === 'string' ? text : '';
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Emphasis that is really literal text: inside a word (`3*4*5`, which CommonMark reads as `3<em>4</em>5`), or a
 * Python-style dunder name (`__init__`, which it reads as bold "init").
 */
function literalEmphasis(
  token: Token,
  before: Token | undefined,
  after: Token | undefined,
): boolean {
  if (token.type !== 'em' && token.type !== 'strong') return false;
  if (WORD_CHAR.test(before?.raw.slice(-1) ?? '') || WORD_CHAR.test(after?.raw.charAt(0) ?? '')) {
    return true;
  }
  return /^__[\p{L}\p{N}_]+__$/u.test(token.raw);
}

const OPENS_RAW_TEXT = /^<(script|style)\b[^>]*>$/i;
const CLOSES_RAW_TEXT = /^<\/(script|style)\s*>$/i;

function inline(tokens: readonly Token[] | undefined): string {
  let text = '';
  // Inside an inline <script> or <style>: its contents are code, never read.
  let rawText = false;
  const list = tokens ?? [];
  list.forEach((token, index) => {
    if (token.type === 'html') {
      if (OPENS_RAW_TEXT.test(token.raw.trim())) rawText = true;
      else if (CLOSES_RAW_TEXT.test(token.raw.trim())) rawText = false;
      return;
    }
    if (rawText) return;
    switch (token.type) {
      case 'br':
        text += '\n';
        break;
      case 'checkbox':
        break;
      case 'codespan':
      case 'escape':
        text += (token as Tokens.Codespan | Tokens.Escape).text;
        break;
      default:
        // text, strong, em, del, link, image (its alt text), and anything an extension adds.
        text += literalEmphasis(token, list[index - 1], list[index + 1])
          ? token.raw
          : ownText(token);
    }
  });
  return text;
}

/** An HTML block's readable text: comments and the contents of script and style elements go entirely. */
function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** A YAML key line (`title: Notes`, `tags:`) as front matter starts with. */
const YAML_KEY = /^[A-Za-z_][\w.-]*[ \t]*:(?:[ \t]|$)/;

/**
 * Removes a front-matter block: only at the very start, between `---` lines, and only when it reads as YAML
 * (key lines, indented continuations, `- ` items, comments). A Markdown file that merely opens with a `---` rule
 * keeps its text.
 */
function stripFrontMatter(markdown: string): string {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
    markdown,
  );
  if (!match) return markdown;
  const lines = (match[1] ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const yaml =
    lines.length > 0 &&
    YAML_KEY.test(lines[0]!) &&
    lines.every((line) => YAML_KEY.test(line) || /^[ \t]+\S/.test(line) || /^-[ \t]/.test(line));
  return yaml ? markdown.slice(match[0].length) : markdown;
}

function blocks(tokens: readonly Token[]): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'hr':
      case 'def':
        break;
      case 'code':
        out.push((token as Tokens.Code).text);
        break;
      case 'html':
        out.push(htmlText((token as Tokens.HTML).text));
        break;
      case 'list':
        out.push(
          (token as Tokens.List).items.map((item) => blocks(item.tokens).join('\n')).join('\n'),
        );
        break;
      case 'blockquote':
        out.push(blocks((token as Tokens.Blockquote).tokens).join('\n\n'));
        break;
      case 'table': {
        const table = token as Tokens.Table;
        const rows = [table.header, ...table.rows];
        out.push(rows.map((row) => row.map((cell) => inline(cell.tokens)).join(', ')).join('\n'));
        break;
      }
      default:
        // heading, paragraph, the text of tight list items.
        out.push(ownText(token));
    }
  }
  return out.filter((block) => block.trim() !== '');
}

/**
 * Markdown as text to read aloud: headings, paragraphs and list items each on their own line or paragraph;
 * emphasis marks (but not a `*` or `_` inside a word), link targets, image addresses, tags, HTML comments,
 * script and style contents, rules, reference definitions, footnotes and a front-matter block removed; tables
 * read row by row; code kept as text (the editor shows it, so the reader can cut it). marked is imported on
 * first use.
 */
export async function stripMarkdown(markdown: string): Promise<string> {
  const { lexer } = await import('marked');
  const body = stripFrontMatter(markdown)
    // Footnote definitions (GFM, which marked does not parse) would otherwise be read as a paragraph.
    .replace(/^ {0,3}\[\^[^\]\s]+\]:.*$/gm, '');
  const text = blocks(lexer(body)).join('\n\n');
  return normalizeText(decodeEntities(text).replace(/\[\^[^\]\s]+\](?!:)/g, ''));
}
