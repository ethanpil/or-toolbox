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

/** Unifies line ends, trims line ends and collapses spaces and runs of blank lines. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
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
    sub[0]!.sep = part.sep;
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
    if (!paragraph) continue;
    const sub = fit(paragraph, max);
    sub[0]!.sep = pieces.length === 0 ? '' : '\n\n';
    pieces.push(...sub);
  }
  return pack(pieces, max).map((piece) => piece.text);
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

function inline(tokens: readonly Token[] | undefined): string {
  let text = '';
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'br':
        text += '\n';
        break;
      case 'html':
      case 'checkbox':
        break;
      case 'codespan':
      case 'escape':
        text += (token as Tokens.Codespan | Tokens.Escape).text;
        break;
      default:
        // text, strong, em, del, link, image (its alt text), and anything an extension adds.
        text += ownText(token);
    }
  }
  return text;
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
        out.push((token as Tokens.HTML).text.replace(/<[^>]*>/g, ' '));
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
 * emphasis, link targets, image addresses, tags, rules, reference definitions, footnotes and a front-matter
 * block removed; tables read row by row; code kept as text (the editor shows it, so the reader can cut it).
 * marked is imported on first use.
 */
export async function stripMarkdown(markdown: string): Promise<string> {
  const { lexer } = await import('marked');
  const body = markdown
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n/, '')
    // Footnote definitions (GFM, which marked does not parse) would otherwise be read as a paragraph.
    .replace(/^ {0,3}\[\^[^\]\s]+\]:.*$/gm, '');
  const text = blocks(lexer(body)).join('\n\n');
  return normalizeText(decodeEntities(text).replace(/\[\^[^\]\s]+\](?!:)/g, ''));
}
