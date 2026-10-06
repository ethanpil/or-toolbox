/**
 * Text a model (or a user) wrote, made safe to place inside a Markdown document that has a structure of its own
 * (an exported transcript, a round): it can neither run on past its section (a code fence left open is closed,
 * an HTML comment cannot swallow the rest) nor pass for structure (headings, rules and setext underlines are
 * escaped outside code, so a reply cannot forge a "## Vote" section). Used by the exports of Bot-to-bot and
 * Model arena.
 */

/** An opening code fence: up to 3 spaces, then 3 or more backticks or tildes (CommonMark). */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** An ATX heading. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** A thematic break or a setext underline: `---`, `***`, `___` (spaces allowed), `===`, a lone `-` or `=`. */
const RULE = /^ {0,3}(?:([-*_])(?:[ \t]*\1){2,}|-+|=+)[ \t]*$/;
/** HTML blocks that run on until a terminator rather than a blank line (CommonMark types 1 to 5). */
const LONG_HTML = /^ {0,3}<(?:script|pre|style|textarea|!--|\?|![A-Za-z]|!\[CDATA\[)/i;

/** One line outside code, with anything that would act as transcript structure escaped. */
function escapeStructure(line: string): string {
  if (HEADING.test(line)) return line.replace('#', '\\#');
  if (RULE.test(line)) return line.replace(/[-*_=]/, (char) => `\\${char}`);
  if (LONG_HTML.test(line)) return line.replace('<', '\\<');
  return line;
}

interface OpenFence {
  char: string;
  length: number;
}

/**
 * Text from a bot or the moderator, made safe to place between the transcript's headings: a code fence left
 * open is closed (same character, as long as the opener), and outside code, headings, rules, setext underlines
 * and long HTML blocks are escaped. Code inside fences stays exactly as written.
 */
export function safeBlock(text: string): string {
  let open: OpenFence | null = null;
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = FENCE.exec(line);
    if (open) {
      const marker = fence?.[1] ?? '';
      if (marker[0] === open.char && marker.length >= open.length && !fence?.[2]?.trim()) {
        open = null;
      }
      lines.push(line);
    } else if (fence && !(fence[1]![0] === '`' && fence[2]!.includes('`'))) {
      // (A backtick fence's info string may not contain backticks: that line is inline code.)
      open = { char: fence[1]![0]!, length: fence[1]!.length };
      lines.push(line);
    } else {
      lines.push(escapeStructure(line));
    }
  }
  if (open) lines.push(open.char.repeat(open.length));
  return lines.join('\n');
}
