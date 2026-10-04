/**
 * The transcript model of Speech-to-text, pure and unit-tested: merging the transcripts of a recording's parts into
 * one timeline, speaker labels, and the text, subtitle and JSON exports.
 *
 * Merging (`mergeParts`):
 * - Every part's timestamps start at 0; its offset in the recording is added, so the timeline is continuous.
 *   Times are clamped to the part's own span (a model may report an end slightly past the audio it got).
 * - A part without segments gets them from its words (pauses, sentence ends, speaker changes), and a part without
 *   any timestamps (timestamps off, or a model that gives none) becomes one segment spanning the part.
 * - Seams: parts are cut in pauses and never share audio, so words said twice across a seam ("Okay." "Okay.") are
 *   real and stay. Only when the model's own times overlap the next part's (it reports sound past the end of the
 *   audio it got) and the words that end one part start the next (compared without case, Latin accents or
 *   punctuation; other scripts' vowel and tone marks count) and those words fit inside the overlap, the repeat is
 *   dropped from the later part, words included. Untimed parts are never compared. A segment that ends after the
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
/** Slack for rounding in the times models report, when checking that a repeat lies inside a seam overlap. */
const SEAM_TOLERANCE_SECONDS = 0.1;
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

/**
 * A token as compared at seams: lower case, without Latin accents (the U+0300 block) and punctuation. Other
 * combining marks (Mn/Mc: Devanagari vowel signs, Thai tone marks\u2026) are part of the word and stay: \u0939\u0948 is not \u0939\u094b.
 */
export function seamToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '')
    .normalize('NFC');
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

/** Times as the model reported them, moved onto the recording but not clamped to the part (for seam checks). */
interface Raw {
  rawStart: number;
  rawEnd: number;
}

interface PlacedPart {
  segments: (Segment & Raw)[];
  words: (Word & Raw)[];
  timed: boolean;
}

/** One part's segments and words on the recording's timeline (not yet de-duplicated against its neighbour). */
function placePart(part: PartInput, perPart: boolean): PlacedPart {
  const { result, offset, index } = part;
  const end = offset + Math.max(0, part.duration);
  const within = (seconds: number): number => clamp(seconds, offset, end);
  const key = (raw: string | undefined): string | undefined =>
    raw === undefined ? undefined : speakerKey(raw, index, perPart);

  const words: (Word & Raw)[] = [];
  for (const word of result.words) {
    if (!word.word) continue;
    const rawStart = offset + word.start;
    const rawEnd = offset + word.end;
    const placed: Word & Raw = {
      start: within(rawStart),
      end: within(rawEnd),
      word: word.word,
      rawStart,
      rawEnd,
    };
    const speaker = key(word.speaker);
    if (speaker !== undefined) placed.speaker = speaker;
    words.push(placed);
  }
  words.sort((a, b) => a.rawStart - b.rawStart);

  // On the recording's timeline, unclamped.
  let local: LocalSegment[] = result.segments
    .filter((segment) => segment.text)
    .map((segment) => {
      const placed: LocalSegment = {
        start: offset + segment.start,
        end: offset + segment.end,
        text: segment.text,
      };
      const speaker = key(segment.speaker);
      if (speaker !== undefined) placed.speaker = speaker;
      return placed;
    });
  let timed = true;
  if (local.length === 0 && words.length > 0) {
    local = segmentsFromWords(
      words.map((word) => {
        const raw: Word = { start: word.rawStart, end: word.rawEnd, word: word.word };
        if (word.speaker !== undefined) raw.speaker = word.speaker;
        return raw;
      }),
    );
  }
  if (local.length === 0 && result.text) {
    local = [{ start: offset, end, text: result.text }];
    timed = false;
  }
  local.sort((a, b) => a.start - b.start);

  const segments = local.map((segment, n): Segment & Raw => {
    const start = within(segment.start);
    const placed: Segment & Raw = {
      id: `${index}:${n}`,
      part: index,
      start,
      end: Math.max(start, within(segment.end)),
      text: segment.text.replace(/\s+/g, ' ').trim(),
      rawStart: segment.start,
      rawEnd: segment.end,
    };
    if (segment.speaker !== undefined) placed.speaker = segment.speaker;
    return placed;
  });
  return { segments, words, timed };
}

/**
 * Drops a repeat at the seam between the previous part's last segment and the next part's first segment (and its
 * words), in place, when both parts heard it: the model's times overlap and the repeat lies inside the overlap. A
 * first segment left empty is removed.
 */
function dropSeamRepeat(
  previous: (Segment & Raw) | undefined,
  previousWords: readonly (Word & Raw)[],
  next: (Segment & Raw)[],
  nextWords: (Word & Raw)[],
): void {
  const first = next[0];
  if (!previous || !first) return;
  // The previous part still hears something after this one started; parts that meet in a pause never overlap.
  const overlap = previous.rawEnd - first.rawStart;
  if (!(overlap > 0)) return;
  const firstTokens = tokens(first.text);
  const repeat = seamRepeat(tokens(previous.text), firstTokens);
  if (repeat === 0) return;
  const dropped = firstTokens.slice(0, repeat).map(seamToken);
  const leading = nextWords.slice(0, repeat);
  const haveWords =
    leading.length === repeat && leading.every((word, i) => seamToken(word.word) === dropped[i]);
  if (haveWords) {
    // Every repeated word starts before the previous part's sound ends, and its copy there ends after this
    // part's sound starts.
    if (leading.some((word) => word.rawStart >= previous.rawEnd + SEAM_TOLERANCE_SECONDS)) return;
    const tail = previousWords.slice(-repeat);
    if (
      tail.length === repeat &&
      tail.some((word) => word.rawEnd <= first.rawStart - SEAM_TOLERANCE_SECONDS)
    ) {
      return;
    }
    nextWords.splice(0, repeat);
    first.start = Math.max(first.start, leading.at(-1)?.end ?? first.start);
  } else {
    // Without word times: the repeat's share of the segment must fit inside the overlap.
    const share = ((first.rawEnd - first.rawStart) * repeat) / firstTokens.length;
    if (share > overlap + SEAM_TOLERANCE_SECONDS) return;
  }
  first.text = firstTokens.slice(repeat).join(' ');
  if (!first.text) next.shift();
  else first.end = Math.max(first.start, first.end);
}

/** Without the seam-check times. */
function withoutRaw<T extends Raw>(item: T): Omit<T, keyof Raw> {
  const copy: Partial<T> = { ...item };
  delete copy.rawStart;
  delete copy.rawEnd;
  return copy as Omit<T, keyof Raw>;
}

/** Merges the parts transcribed so far (any order, gaps allowed) into one transcript. */
export function mergeParts(parts: readonly PartInput[], options: MergeOptions): Transcript {
  const perPart = options.partCount > 1;
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  const placedSegments: (Segment & Raw)[] = [];
  const placedWords: (Word & Raw)[] = [];
  let timed = true;
  let language: string | null = null;
  let previous: (PlacedPart & { index: number }) | null = null;

  for (const part of ordered) {
    const placed = placePart(part, perPart);
    timed &&= placed.timed;
    language ??= part.result.language;
    // Only timed neighbours share a seam: a failed part between two others leaves a real gap, and a part without
    // timestamps cannot say what it heard where.
    if (previous && part.index === previous.index + 1 && previous.timed && placed.timed) {
      dropSeamRepeat(placedSegments.at(-1), previous.words, placed.segments, placed.words);
      const last = placedSegments.at(-1);
      const first = placed.segments[0];
      if (last && first && last.end > first.start) last.end = Math.max(last.start, first.start);
    }
    placedSegments.push(...placed.segments);
    placedWords.push(...placed.words);
    previous = { ...placed, index: part.index };
  }
  const segments: Segment[] = placedSegments.map(withoutRaw);
  const words: Word[] = placedWords.map(withoutRaw);

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

/** How one part was transcribed (a retry may use another model or other options than the first run). */
export interface PartMeta {
  index: number;
  start: number;
  duration: number;
  model: string;
  /** ISO-639-1 sent, or null for auto-detection. */
  language: string | null;
  timestamps: boolean;
  diarize: boolean;
  /** Vocabulary terms sent. */
  keyterms: number;
}

export interface TranscriptMeta {
  source: string;
  /** Length of the recording in seconds, when known. */
  duration: number | null;
  /** The transcribed parts. */
  parts: readonly PartMeta[];
}

/** The models used, in part order, each once. */
export function modelsUsed(parts: readonly PartMeta[]): string[] {
  return [...new Set([...parts].sort((a, b) => a.index - b.index).map((part) => part.model))];
}

/** "openai/whisper-1 (parts 1 and 3), deepgram/nova-3 (part 2)" when parts used different models, else null. */
export function mixedModelsNote(parts: readonly PartMeta[]): string | null {
  const models = modelsUsed(parts);
  if (models.length < 2) return null;
  return models
    .map((model) => {
      const numbers = parts
        .filter((part) => part.model === model)
        .map((part) => part.index + 1)
        .sort((a, b) => a - b);
      const list =
        numbers.length === 1
          ? `part ${numbers[0]}`
          : `parts ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
      return `${model} (${list})`;
    })
    .join(', ');
}

/** The JSON export: segments (with speaker names and edit marks) and words, times in seconds to the millisecond. */
export function transcriptJson(
  transcript: Transcript,
  names: Readonly<Record<string, string>>,
  meta: TranscriptMeta,
): Record<string, unknown> {
  const name = (key: string): string => speakerName(key, names, transcript.speakersPerPart);
  const models = modelsUsed(meta.parts);
  return {
    format: 'ortoolbox-transcript',
    version: 1,
    source: meta.source,
    // Never a silent mix: "mixed" with every model listed, and each part says which one it had.
    model: models.length === 1 ? models[0] : models.length === 0 ? null : 'mixed',
    models,
    parts: [...meta.parts]
      .sort((a, b) => a.index - b.index)
      .map((part) => ({
        part: part.index + 1,
        start: ms(part.start),
        end: ms(part.start + part.duration),
        model: part.model,
        language: part.language,
        timestamps: part.timestamps,
        speakerLabels: part.diarize,
        keyterms: part.keyterms,
      })),
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
