/**
 * Page selection for multi-page documents: the "1-3, 7" range syntax and the small set operations behind the
 * document input (src/ui/components/document-input.ts). Pages are 1-based; a selection is always sorted and free
 * of duplicates.
 *
 * Range syntax (what `parsePageRange` reads): items separated by commas, semicolons or spaces; an item is a page
 * (`7`), a closed range (`1-3`, also with an en dash), an open range to the end (`5-`) or from the start (`-3`);
 * `all` (or `*`) is every page.
 */

export type RangeResult =
  { pages: number[]; error?: undefined } | { error: string; pages?: undefined };

const ITEM = /^(\d+)?\s*([-–])?\s*(\d+)?$/;

/** Parses a page range such as `1-3, 7` for a file of `pageCount` pages. */
export function parsePageRange(text: string, pageCount: number): RangeResult {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Enter pages, for example 1-3, 7.' };
  if (/^(all|\*)$/i.test(trimmed)) return { pages: allPages(pageCount) };
  const chosen = new Set<number>();
  // Spaces inside "1 - 3" belong to the item; commas, semicolons and runs of spaces between items separate them.
  const items = trimmed
    .replace(/\s*([-–])\s*/g, '$1')
    .split(/[,;\s]+/)
    .filter(Boolean);
  for (const item of items) {
    const match = ITEM.exec(item);
    if (!match || (!match[1] && !match[3])) return { error: `“${item}” is not a page or a range.` };
    const [, startText, dash, endText] = match;
    const start = startText ? Number(startText) : 1;
    const end = dash ? (endText ? Number(endText) : pageCount) : start;
    for (const page of [start, end]) {
      if (page < 1) return { error: 'Pages start at 1.' };
      if (page > pageCount) {
        return {
          error: `Page ${page} does not exist; this file has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.`,
        };
      }
    }
    if (end < start) return { error: `“${item}” runs backwards; write ${end}-${start}.` };
    for (let page = start; page <= end; page++) chosen.add(page);
  }
  return { pages: [...chosen].sort((a, b) => a - b) };
}

/** `[1, 2, 3, 7]` → `1-3, 7`. Empty → ``. */
export function formatPageRange(pages: readonly number[]): string {
  const sorted = normalizePages(pages);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    const start = sorted[i]!;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i]!;
    parts.push(end === start ? String(start) : `${start}-${end}`);
    i++;
  }
  return parts.join(', ');
}

/** Every page of a file: `[1 … pageCount]`. */
export function allPages(pageCount: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(pageCount)) }, (_, i) => i + 1);
}

/** Sorted, unique, whole positive numbers only. */
export function normalizePages(pages: readonly number[], pageCount = Infinity): number[] {
  return [...new Set(pages)]
    .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
    .sort((a, b) => a - b);
}

/** The selection with `page` added or removed. */
export function togglePage(pages: readonly number[], page: number): number[] {
  return pages.includes(page)
    ? pages.filter((candidate) => candidate !== page)
    : normalizePages([...pages, page]);
}

/** True when every page of the file is selected. */
export function isAllPages(pages: readonly number[], pageCount: number): boolean {
  return pages.length === pageCount && normalizePages(pages, pageCount).length === pageCount;
}

/** "12 of 40 pages selected" for a list of files' selections. */
export function describeSelection(
  files: readonly { pageCount: number; selected: readonly number[] }[],
): string {
  const total = files.reduce((sum, file) => sum + file.pageCount, 0);
  const selected = files.reduce((sum, file) => sum + file.selected.length, 0);
  if (files.length === 0) return 'No files yet.';
  const fileText = `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  if (selected === total) return `${fileText} · ${total} ${total === 1 ? 'page' : 'pages'}`;
  return `${fileText} · ${selected} of ${total} pages selected`;
}
