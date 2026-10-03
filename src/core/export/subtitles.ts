/**
 * SubRip (SRT) and WebVTT subtitle files from timed text segments, as the
 * speech-to-text tool produces them.
 */

export interface SubtitleSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  /** Speaker label, if the model diarised: `Name: text` in SRT, a `<v Name>` voice tag in VTT. */
  speaker?: string | undefined;
}

export interface SubtitleOptions {
  /** Wrap lines at about this many characters. 0 turns wrapping off. Default 42. */
  maxLineLength?: number;
}

/**
 * `83.5` → `00:01:23,500` (SRT, with `,`) or `00:01:23.500` (VTT, with `.`).
 * Works in whole milliseconds, so `59.9996` becomes `00:01:00,000`, not `00:00:60,000`.
 */
export function formatTimestamp(seconds: number, separator: ',' | '.' = ','): string {
  const total = Math.round(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 1000);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(s)}${separator}${String(ms).padStart(3, '0')}`;
}

/** Greedy word wrap that keeps existing line breaks. A word longer than the limit stays whole on its own line. */
export function wrapLines(text: string, maxLength: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (maxLength <= 0) {
      lines.push(paragraph);
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > maxLength) {
        lines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Cue text with blank lines and `-->` removed: both would end the cue early in a parser. */
function cleanCueText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/-->/g, '->')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

interface Cue {
  start: number;
  end: number;
  lines: string[];
  speaker: string | undefined;
}

function toCues(segments: readonly SubtitleSegment[], options: SubtitleOptions): Cue[] {
  const maxLength = options.maxLineLength ?? 42;
  const result: Cue[] = [];
  for (const segment of segments) {
    const text = cleanCueText(segment.text);
    if (!text) continue;
    const start = Math.max(0, segment.start);
    result.push({
      start,
      // A cue must not be empty or run backwards.
      end: Math.max(segment.end, start + 0.001),
      lines: wrapLines(text, maxLength),
      speaker: segment.speaker?.replace(/\s+/g, ' ').trim() || undefined,
    });
  }
  return result;
}

/** SubRip: numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`, a blank line between cues, LF line ends. */
export function toSrt(segments: readonly SubtitleSegment[], options: SubtitleOptions = {}): string {
  return toCues(segments, options)
    .map((cue, index) => {
      const lines = [...cue.lines];
      if (cue.speaker && lines[0] !== undefined) lines[0] = `${cue.speaker}: ${lines[0]}`;
      return [
        String(index + 1),
        `${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}`,
        ...lines,
      ].join('\n');
    })
    .join('\n\n')
    .concat('\n');
}

const escapeVtt = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** WebVTT: a `WEBVTT` header, `HH:MM:SS.mmm` timestamps, text escaped for cue markup, speakers as voice tags. */
export function toVtt(segments: readonly SubtitleSegment[], options: SubtitleOptions = {}): string {
  const body = toCues(segments, options).map((cue) => {
    const lines = cue.lines.map(escapeVtt);
    if (cue.speaker && lines[0] !== undefined) {
      lines[0] = `<v ${escapeVtt(cue.speaker)}>${lines[0]}`;
    }
    return [
      `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(cue.end, '.')}`,
      ...lines,
    ].join('\n');
  });
  return ['WEBVTT', ...body].join('\n\n').concat('\n');
}
