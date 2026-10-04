/**
 * Lyrics for Lyria: section tags in the editor, a light check of what was written, and the timed lyrics Lyria
 * sends back (docs/openrouter-api.md §6.2).
 *
 * Lyria has no lyrics field; lyrics go in the prompt, and `[Verse]`/`[Chorus]` tags there are honoured. Its
 * answer's text is the lyrics as sung, one line each with a start time and, from Clip, an end time
 * (`[0.0:3.7] HELLO WORLD`); Pro puts section markers between them (`[[A0]]`, `[[B1]]`) and gives only starts
 * (`[12.0:] Morning light`). An instrumental comes back as `<instrumental>`.
 */

/** The tags the editor's buttons insert. */
export const SECTION_TAGS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'] as const;

/** Section names Lyria understands (with an optional number: "Verse 2"). */
const KNOWN_SECTION =
  /^(intro|verse|pre-?chorus|chorus|post-?chorus|hook|refrain|bridge|interlude|instrumental|break|solo|drop|outro)(\s+\d+)?$/i;
/** Sections that may have no words. */
const WORDLESS_SECTION = /^(intro|interlude|instrumental|break|solo|drop|outro)/i;
/** Sung lines that comfortably fit Lyria 3 Clip's 30 seconds (the probe sang 4 lines twice in 30 s). */
const CLIP_LINES = 8;

/**
 * Inserts `[tag]` on a line of its own in place of the selection `[start, end)`, after a blank line when the
 * text before it has words, and returns the new text with the cursor on the line after the tag.
 */
export function insertTag(
  value: string,
  start: number,
  end: number,
  tag: string,
): { value: string; cursor: number } {
  const before = value.slice(0, start).replace(/[ \t]+$/, '');
  const after = value.slice(end).replace(/^[ \t]*\n?/, '');
  const lead =
    before.trim() === ''
      ? ''
      : before.endsWith('\n\n')
        ? ''
        : before.endsWith('\n')
          ? '\n'
          : '\n\n';
  const head = `${before.trim() === '' ? '' : before}${lead}[${tag}]\n`;
  return { value: head + after, cursor: head.length };
}

export interface LyricsIssue {
  /** 1-based line, or 0 for the lyrics as a whole. */
  line: number;
  /** Errors stop the run (the prompt would be garbled); warnings are advice. */
  level: 'error' | 'warning';
  message: string;
}

export interface LyricsContext {
  instrumental: boolean;
  /** True for Lyria 3 Clip (about 30 seconds). */
  clip: boolean;
}

/** Checks lyrics before they are sent: unclosed brackets, unknown or empty sections, too much for a clip. */
export function validateLyrics(text: string, context: LyricsContext): LyricsIssue[] {
  const issues: LyricsIssue[] = [];
  if (!text.trim()) return issues;
  if (context.instrumental) {
    issues.push({
      line: 0,
      level: 'warning',
      message: 'Instrumental is chosen, so these lyrics are not sent.',
    });
    return issues;
  }
  const lines = text.split('\n').map((line) => line.trim());
  let sung = 0;
  let openSection: { name: string; line: number; words: boolean } | null = null;
  const closeSection = (): void => {
    if (openSection && !openSection.words && !WORDLESS_SECTION.test(openSection.name)) {
      issues.push({
        line: openSection.line,
        level: 'warning',
        message: `Line ${openSection.line}: [${openSection.name}] has no lyrics under it.`,
      });
    }
    openSection = null;
  };

  lines.forEach((line, index) => {
    const number = index + 1;
    if (!line) return;
    const tag = /^\[([^[\]]+)\]$/.exec(line);
    if (tag) {
      closeSection();
      const name = tag[1]!.trim();
      openSection = { name, line: number, words: false };
      if (!KNOWN_SECTION.test(name)) {
        issues.push({
          line: number,
          level: 'warning',
          message: `Line ${number}: [${name}] is not a section Lyria knows, so it may be sung as words.`,
        });
      }
      return;
    }
    const opened = (line.match(/\[/g) ?? []).length;
    const closed = (line.match(/\]/g) ?? []).length;
    if (opened !== closed) {
      issues.push({
        line: number,
        level: 'error',
        message: `Line ${number}: a square bracket is not closed.`,
      });
    } else if (opened > 0) {
      issues.push({
        line: number,
        level: 'warning',
        message: `Line ${number}: put section tags on a line of their own; use (round brackets) for backing vocals.`,
      });
    }
    sung += 1;
    if (openSection) openSection.words = true;
  });
  closeSection();

  if (context.clip && sung > CLIP_LINES) {
    issues.push({
      line: 0,
      level: 'warning',
      message: `Lyria 3 Clip makes about 30 seconds: only the first ${CLIP_LINES} lines or so will be sung. Choose Song for all ${sung}.`,
    });
  }
  return issues;
}

// --- timed lyrics -----------------------------------------------------------------------------------------

export interface LyricLine {
  /** Seconds from the start of the song. */
  start: number;
  /** Seconds; from the answer, or estimated (the next line's start, or a typical line length). */
  end: number;
  text: string;
  /** True for the first line after a section marker. */
  sectionStart: boolean;
}

export interface TimedLyrics {
  lines: LyricLine[];
  /** Lyria answered `<instrumental>`. */
  instrumental: boolean;
  /** Text that carried no timestamp (shown as it is). */
  untimed: string[];
}

/** Line length assumed when nothing else tells: Pro's lines were 6 s apart. */
const DEFAULT_LINE_SECONDS = 6;

/** Parses the text of a Lyria answer into timed lines. */
export function parseTimedLyrics(content: string): TimedLyrics {
  const raw: {
    start: number;
    end: number | null;
    text: string;
    sectionStart: boolean;
    breakBefore: boolean;
  }[] = [];
  const untimed: string[] = [];
  let instrumental = false;
  let section = false;
  for (const lineText of content.split(/\r?\n/)) {
    const line = lineText.trim();
    if (!line) continue;
    if (/^<instrumental>$/i.test(line)) {
      instrumental = true;
      continue;
    }
    if (/^\[\[[^\]]*\]\]$/.test(line)) {
      section = true;
      continue;
    }
    const timed = /^\[(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)?\]\s*(.*)$/.exec(line);
    if (!timed) {
      untimed.push(line);
      continue;
    }
    raw.push({
      start: Number(timed[1]),
      end: timed[2] === undefined ? null : Number(timed[2]),
      text: timed[3] ?? '',
      sectionStart: section && raw.length > 0,
      breakBefore: section,
    });
    section = false;
  }

  const gaps = raw
    .slice(1)
    .map((line, i) => line.start - raw[i]!.start)
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  const typical = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : DEFAULT_LINE_SECONDS;
  const lines = raw.map((line, i): LyricLine => {
    const next = raw[i + 1];
    // A section break means an instrumental passage may follow: do not stretch the line over it.
    const fallback = next && !next.breakBefore ? next.start : line.start + typical;
    return {
      start: line.start,
      end: line.end ?? Math.max(line.start, fallback),
      text: line.text,
      sectionStart: line.sectionStart,
    };
  });
  return { lines, instrumental, untimed };
}

/** The line being sung at `time`, or -1 (before the first, in a gap, after the last). */
export function activeLine(lines: readonly LyricLine[], time: number): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.start <= time) return time < line.end ? i : -1;
  }
  return -1;
}

/** The lyrics as plain text for History: one line per sung line, a blank line between sections. */
export function lyricsText(lyrics: TimedLyrics): string {
  if (lyrics.instrumental && lyrics.lines.length === 0) return 'Instrumental';
  const lines = lyrics.lines.map((line) => `${line.sectionStart ? '\n' : ''}${line.text}`);
  return [...lines, ...lyrics.untimed].join('\n').trim();
}
