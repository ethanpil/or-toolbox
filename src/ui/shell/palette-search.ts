/**
 * Fuzzy-ish ranking for the command palette and Home's tool search. Pure, fast (no allocation per character
 * beyond the normalised strings) and predictable: exact > prefix > word prefix > substring > in-order
 * characters. Every word of the query must match somewhere in the item; the label counts more than keywords.
 */

export interface SearchItem {
  label: string;
  /** Secondary text that also matches (description, model id). */
  detail?: string;
  /** Hidden extra words. */
  keywords?: string;
}

/** Lower case, accents removed, whitespace collapsed. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const isBoundary = (text: string, index: number): boolean =>
  index === 0 || /[\s\-_/.:()]/.test(text[index - 1] ?? ' ');

/**
 * How well one query word matches `text` (both normalised): 0 = no match. Contiguous matches score by
 * position. With `fuzzy` (labels only: on long descriptions nearly anything matches), every character may
 * instead appear in order within a short span, scoring higher for word starts and runs.
 */
export function scoreWord(word: string, text: string, fuzzy = true): number {
  if (!word) return 1;
  if (!text) return 0;
  if (text === word) return 1000;
  if (text.startsWith(word)) return 900 - Math.min(text.length - word.length, 100);
  let index = text.indexOf(word);
  let bestBoundary = -1;
  while (index !== -1) {
    if (isBoundary(text, index)) {
      bestBoundary = index;
      break;
    }
    index = text.indexOf(word, index + 1);
  }
  if (bestBoundary !== -1) return 700 - Math.min(bestBoundary, 100);
  const contained = text.indexOf(word);
  if (contained !== -1) return 500 - Math.min(contained, 100);
  if (!fuzzy || word.length < 2) return 0;

  // In-order characters (e.g. "imgen" → "image generation").
  let score = 0;
  let position = 0;
  let previous = -2;
  for (const char of word) {
    const found = text.indexOf(char, position);
    if (found === -1) return 0;
    score += isBoundary(text, found) ? 12 : found === previous + 1 ? 8 : 2;
    previous = found;
    position = found + 1;
  }
  // "abc" scattered over "a…………b………c" is not a match; a tight spread ranks higher.
  const spread = previous - text.indexOf(word[0]!);
  if (spread > word.length * 4 + 4) return 0;
  return Math.max(1, Math.min(300, 100 + score - spread));
}

/** Score of an item for a query: 0 when any query word matches nothing. Empty query → 1 (everything matches). */
export function scoreItem(query: string, item: SearchItem): number {
  const words = normalize(query).split(' ').filter(Boolean);
  if (words.length === 0) return 1;
  const label = normalize(item.label);
  const detail = item.detail ? normalize(item.detail) : '';
  const keywords = item.keywords ? normalize(item.keywords) : '';
  let total = 0;
  for (const word of words) {
    const best = Math.max(
      scoreWord(word, label),
      scoreWord(word, detail, false) * 0.6,
      scoreWord(word, keywords, false) * 0.5,
    );
    if (best <= 0) return 0;
    total += best;
  }
  return total;
}

/** Items that match `query`, best first; ties keep their original order. */
export function rank<T extends SearchItem>(items: readonly T[], query: string): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreItem(query, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
