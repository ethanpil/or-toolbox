/**
 * The transcript model of Speech-to-text, pure and unit-tested: merging the transcripts of a recording's parts into
 * one timeline, speaker labels, and the text, subtitle and JSON exports.
 *
 * Merging (`mergeParts`):
 * - Every part's timestamps start at 0; its offset in the recording is added, so the timeline is continuous.
 *   Times are clamped to the part's own span (a model may report an end slightly past the audio it got).
 * - A part without segments gets them from its words (pauses, sentence ends, speaker changes), and a part without
 *   any timestamps (timestamps off, or a model that gives none) becomes one segment spanning the part.
 * - Seams: the cut is made in a pause, but a word on the cut can still be heard in both parts. When the words that
 *   end one part start the next (compared without case, accents or punctuation) and both sit within a couple of
 *   seconds of the seam, the repeat is dropped from the later part, words included. A segment that ends after the
 *   next part's first one starts is trimmed back to it. Overlaps inside a part (two people talking at once) are the
 *   model's to report and are kept.
 * - Speakers: models number speakers per request, and nothing in the API ties speaker 0 of one request to speaker
 *   0 of the next. With one part the labels are kept as they are; with several each part's labels get the part's
 *   number (`2:0` is the first speaker of part 2), and the page says so and lets the user rename them to match.
 */
import type { TranscriptionResult } from '../../core/api/types';
import type { SubtitleSegment } from '../../core/export/subtitles';
import { formatDuration } from '../../core/files';

export interface Word {
  start: number;
  end: number;
  word: string;
  /** Speaker key (see the module note). */
  speaker?: string;
}

export interface Segment {
  /** Stable across merges: `<part>:<n>`, so edits survive later parts arriving. */
  id: string;
  /** The part it came from (0-based). */
  part: number;
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  text: string;
  speaker?: string;
  /** The user changed its text (its words no longer match it). */
  edited?: boolean;
}

export interface PartInput {
  /** Position in the recording, from 0. */
  index: number;
  /** Where the part starts in the recording, in seconds. */
  offset: number;
  duration: number;
  result: TranscriptionResult;
}

export interface Transcript {
  segments: Segment[];
  words: Word[];
  /** Speaker keys in order of first appearance. */
  speakers: string[];
  language: string | null;
  /** False when some part came back without timestamps (its one segment spans the whole part). */
  timed: boolean;
  /** True when the labels restart in every part (the recording was sent in more than one part). */
  speakersPerPart: boolean;
}

export interface MergeOptions {
  /** How many parts the recording was cut into: speaker labels are per part when there are several. */
  partCount: number;
  /** User edits by segment id. */
  edits?: ReadonlyMap<string, string>;
}

/** A pause this long ends a segment built from words. */
const WORD_GAP_SECONDS = 1;
/** Segments built from words end at a sentence end once this long, and always at this length. */
const MIN_SENTENCE_SECONDS = 2;
const MAX_SEGMENT_SECONDS = 12;
/** How close to a seam a repeated word may be. */
const SEAM_WINDOW_SECONDS = 2;
/** The longest repeat looked for at a seam. */
const MAX_SEAM_WORDS = 6;

export const EMPTY_TRANSCRIPT: Transcript = {
  segments: [],
  words: [],
  speakers: [],
  language: null,
  timed: true,
  speakersPerPart: false,
};

/** The key a part's raw speaker label gets in the merged transcript. */
export function speakerKey(raw: string, part: number, perPart: boolean): string {
  return perPart ? `${part + 1}:${raw}` : raw;
}

interface LocalSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/** Groups words into segments at pauses, sentence ends, speaker changes and a maximum length. */
export function segmentsFromWords(words: readonly Word[]): LocalSegment[] {
  const segments: LocalSegment[] = [];
  let current: { start: number; end: number; parts: string[]; speaker?: string } | null = null;
  const flush = (): void => {
    if (!current) return;
    const segment: LocalSegment = {
      start: current.start,
      end: current.end,
      text: current.parts.join(' '),
    };
    if (current.speaker !== undefined) segment.speaker = current.speaker;
    segments.push(segment);
    current = null;
  };
  for (const word of words) {
    if (!word.word) continue;
    if (current) {
      const c: { start: number; end: number; parts: string[]; speaker?: string } = current;
      const length = c.end - c.start;
      const sentenceEnd = /[.!?…。？！]["')\]]?$/.test(c.parts.at(-1) ?? '');
      if (
        word.start - c.end >= WORD_GAP_SECONDS ||
        word.speaker !== c.speaker ||
        (sentenceEnd && length >= MIN_SENTENCE_SECONDS) ||
        word.end - c.start > MAX_SEGMENT_SECONDS
      ) {
        flush();
      }
    }
    if (!current) {
      current = { start: word.start, end: word.end, parts: [word.word] };
      if (word.speaker !== undefined) current.speaker = word.speaker;
    } else {
      current.parts.push(word.word);
      current.end = Math.max(current.end, word.end);
    }
  }
  flush();
  return segments;
}

/** A token as compared at seams: lower case, no accents, letters and digits only. */
export function seamToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

const tokens = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** How many tokens at the end of `before` repeat at the start of `after` (at most `MAX_SEAM_WORDS`). */
export function seamRepeat(before: readonly string[], after: readonly string[]): number {
  const a = before.map(seamToken);
  const b = after.map(seamToken);
  for (let k = Math.min(MAX_SEAM_WORDS, a.length, b.length); k >= 1; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) {
      const left = a[a.length - k + i];
      same = !!left && left === b[i];
    }
    if (same) return k;
  }
  return 0;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** One part's segments and words on the recording's timeline (not yet de-duplicated against its neighbour). */
function placePart(
  part: PartInput,
  perPart: boolean,
): { segments: Segment[]; words: Word[]; timed: boolean } {
  const { result, offset, index } = part;
  const end = offset + Math.max(0, part.duration);
  const at = (seconds: number): number => clamp(offset + seconds, offset, end);
  const key = (raw: string | undefined): string | undefined =>
    raw === undefined ? undefined : speakerKey(raw, index, perPart);

  const words: Word[] = [];
  for (const word of result.words) {
    if (!word.word) continue;
    const placed: Word = { start: at(word.start), end: at(word.end), word: word.word };
    const speaker = key(word.speaker);
    if (speaker !== undefined) placed.speaker = speaker;
    words.push(placed);
  }
  words.sort((a, b) => a.start - b.start);

  let local: LocalSegment[] = result.segments
    .filter((segment) => segment.text)
    .map((segment) => {
      const placed: LocalSegment = {
        start: at(segment.start),
        end: at(segment.end),
        text: segment.text,
      };
      const speaker = key(segment.speaker);
      if (speaker !== undefined) placed.speaker = speaker;
      return placed;
    });
  let timed = true;
  if (local.length === 0 && words.length > 0) local = segmentsFromWords(words);
  if (local.length === 0 && result.text) {
    local = [{ start: offset, end, text: result.text }];
    timed = false;
  }
  local.sort((a, b) => a.start - b.start);

  const segments = local.map((segment, n): Segment => {
    const placed: Segment = {
      id: `${index}:${n}`,
      part: index,
      start: segment.start,
      end: Math.max(segment.start, segment.end),
      text: segment.text.replace(/\s+/g, ' ').trim(),
    };
    if (segment.speaker !== undefined) placed.speaker = segment.speaker;
    return placed;
  });
  return { segments, words, timed };
}

/**
 * Drops a repeat at the seam between the last segment so far and the next part's first segment (and its words),
 * in place; a first segment left empty is removed.
 */
function dropSeamRepeat(
  previous: Segment | undefined,
  next: Segment[],
  nextWords: Word[],
  seam: number,
): void {
  const first = next[0];
  if (!previous || !first) return;
  if (previous.end < seam - SEAM_WINDOW_SECONDS || first.start > seam + SEAM_WINDOW_SECONDS) return;
  const firstTokens = tokens(first.text);
  const repeat = seamRepeat(tokens(previous.text), firstTokens);
  if (repeat === 0) return;
  const dropped = firstTokens.slice(0, repeat).map(seamToken);
  // The repeated words, if the model gave words and they start the part.
  const leading = nextWords.slice(0, repeat);
  if (
    leading.length === repeat &&
    leading.every((word, i) => seamToken(word.word) === dropped[i])
  ) {
    nextWords.splice(0, repeat);
    first.start = Math.max(first.start, leading.at(-1)?.end ?? first.start);
  }
  first.text = firstTokens.slice(repeat).join(' ');
  if (!first.text) next.shift();
  else first.end = Math.max(first.start, first.end);
}

/** Merges the parts transcribed so far (any order, gaps allowed) into one transcript. */
export function mergeParts(parts: readonly PartInput[], options: MergeOptions): Transcript {
  const perPart = options.partCount > 1;
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const segments: Segment[] = [];
  const words: Word[] = [];
  let timed = true;
  let language: string | null = null;
  let previousIndex = -2;

  for (const part of ordered) {
    const placed = placePart(part, perPart);
    timed &&= placed.timed;
    language ??= part.result.language;
    // Only neighbours share a seam: a failed part between two others leaves a real gap.
    if (part.index === previousIndex + 1) {
      dropSeamRepeat(segments.at(-1), placed.segments, placed.words, part.offset);
      const last = segments.at(-1);
      const first = placed.segments[0];
      if (last && first && last.end > first.start) last.end = Math.max(last.start, first.start);
    }
    segments.push(...placed.segments);
    words.push(...placed.words);
    previousIndex = part.index;
  }

  // Stable: equal starts keep their part and model order.
  segments.sort((a, b) => a.start - b.start || a.part - b.part);
  if (options.edits) {
    for (const segment of segments) {
      const edit = options.edits.get(segment.id);
      if (edit !== undefined && edit !== segment.text) {
        segment.text = edit;
        segment.edited = true;
      }
    }
  }
  const speakers: string[] = [];
  for (const item of [...segments, ...words]) {
    if (item.speaker !== undefined && !speakers.includes(item.speaker)) speakers.push(item.speaker);
  }
  return {
    segments,
    words,
    speakers,
    language,
    timed,
    speakersPerPart: perPart && speakers.length > 0,
  };
}

// --- speakers ---------------------------------------------------------------------------------------------

/** "Speaker 1" for the model's speaker 0; "Speaker 1 (part 2)" when labels are per part. */
export function defaultSpeakerName(key: string, perPart: boolean): string {
  let part: string | null = null;
  let raw = key;
  const colon = key.indexOf(':');
  if (perPart && colon > 0) {
    part = key.slice(0, colon);
    raw = key.slice(colon + 1);
  }
  const label = /^\d+$/.test(raw)
    ? String(Number(raw) + 1)
    : (/^speaker[\s_-]*(.+)$/i.exec(raw)?.[1] ?? raw);
  return part ? `Speaker ${label} (part ${part})` : `Speaker ${label}`;
}

/** The name shown and exported for a speaker key: the user's, else the default. */
export function speakerName(
  key: string,
  names: Readonly<Record<string, string>>,
  perPart: boolean,
): string {
  return names[key]?.trim() || defaultSpeakerName(key, perPart);
}

// --- reading ------------------------------------------------------------------------------------------------

/** Index of the segment playing at `time` (the last one started), or -1 before the first. */
export function segmentAt(segments: readonly Segment[], time: number): number {
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((segments[middle]?.start ?? Infinity) <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

const folded = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

/** True when the segment's text or speaker name contains the query (case and accents ignored). */
export function segmentMatches(segment: Segment, speaker: string | null, query: string): boolean {
  const q = folded(query.trim());
  if (!q) return true;
  return folded(segment.text).includes(q) || (speaker !== null && folded(speaker).includes(q));
}

/** A pause this long between segments starts a new paragraph in the text exports. */
const PARAGRAPH_PAUSE_SECONDS = 2;
/** A paragraph this long ends at the next segment. */
const PARAGRAPH_CHARACTERS = 800;

interface Paragraph {
  start: number;
  speaker: string | null;
  text: string;
}

function paragraphs(transcript: Transcript, names: Readonly<Record<string, string>>): Paragraph[] {
  const out: Paragraph[] = [];
  let previousEnd = -Infinity;
  for (const segment of transcript.segments) {
    if (!segment.text.trim()) continue;
    const speaker =
      segment.speaker === undefined
        ? null
        : speakerName(segment.speaker, names, transcript.speakersPerPart);
    const last = out.at(-1);
    if (
      last &&
      last.speaker === speaker &&
      segment.start - previousEnd < PARAGRAPH_PAUSE_SECONDS &&
      last.text.length < PARAGRAPH_CHARACTERS
    ) {
      last.text += ` ${segment.text.trim()}`;
    } else {
      out.push({ start: segment.start, speaker, text: segment.text.trim() });
    }
    previousEnd = segment.end;
  }
  return out;
}

/** Plain text: paragraphs at pauses and speaker changes, `Name: text` when speakers are labelled. */
export function transcriptText(
  transcript: Transcript,
  names: Readonly<Record<string, string>> = {},
): string {
  return paragraphs(transcript, names)
    .map((p) => (p.speaker ? `${p.speaker}: ${p.text}` : p.text))
    .join('\n\n');
}

/** Escapes what Markdown would read as formatting, so the text arrives in the document as written. */
function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]#<>|~])/g, '\\$1').replace(/^(\d+)\.(\s)/, '$1\\.$2');
}

/** Markdown for the Word export: `**[1:23] Name:** text` per paragraph (no time when untimed). */
export function transcriptMarkdown(
  transcript: Transcript,
  names: Readonly<Record<string, string>> = {},
): string {
  return paragraphs(transcript, names)
    .map((p) => {
      const lead = [
        transcript.timed ? `[${formatDuration(p.start)}]` : '',
        p.speaker ? `${escapeMarkdown(p.speaker)}:` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return lead ? `**${lead}** ${escapeMarkdown(p.text)}` : escapeMarkdown(p.text);
    })
    .join('\n\n');
}

/** Segments for `toSrt`/`toVtt`, with the speakers' names. */
export function subtitleSegments(
  transcript: Transcript,
  names: Readonly<Record<string, string>> = {},
): SubtitleSegment[] {
  return transcript.segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text,
    speaker:
      segment.speaker === undefined
        ? undefined
        : speakerName(segment.speaker, names, transcript.speakersPerPart),
  }));
}

const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;

export interface TranscriptMeta {
  source: string;
  model: string;
  /** Length of the recording in seconds, when known. */
  duration: number | null;
}

/** The JSON export: segments (with speaker names and edit marks) and words, times in seconds to the millisecond. */
export function transcriptJson(
  transcript: Transcript,
  names: Readonly<Record<string, string>>,
  meta: TranscriptMeta,
): Record<string, unknown> {
  const name = (key: string): string => speakerName(key, names, transcript.speakersPerPart);
  return {
    format: 'ortoolbox-transcript',
    version: 1,
    source: meta.source,
    model: meta.model,
    language: transcript.language,
    duration: meta.duration === null ? null : ms(meta.duration),
    timestamps: transcript.timed,
    speakers: transcript.speakers.map((id) => ({ id, name: name(id) })),
    segments: transcript.segments.map((segment) => ({
      start: ms(segment.start),
      end: ms(segment.end),
      text: segment.text,
      ...(segment.speaker === undefined
        ? {}
        : { speaker: segment.speaker, speakerName: name(segment.speaker) }),
      ...(segment.edited ? { edited: true } : {}),
    })),
    words: transcript.words.map((word) => ({
      start: ms(word.start),
      end: ms(word.end),
      word: word.word,
      ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
    })),
  };
}
