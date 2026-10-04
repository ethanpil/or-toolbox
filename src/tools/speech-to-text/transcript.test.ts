import { describe, expect, it } from 'vitest';
import type { TranscriptionResult } from '../../core/api/types';
import { toSrt, toVtt } from '../../core/export/subtitles';
import { parseKeyterms, partSeconds, sttSupport } from './model-support';
import {
  defaultSpeakerName,
  mergeParts,
  type PartInput,
  seamRepeat,
  segmentAt,
  segmentMatches,
  segmentsFromWords,
  speakerName,
  subtitleSegments,
  transcriptJson,
  transcriptMarkdown,
  transcriptText,
} from './transcript';

const result = (patch: Partial<TranscriptionResult>): TranscriptionResult => ({
  text: '',
  language: null,
  duration: null,
  segments: [],
  words: [],
  usage: null,
  ...patch,
});

const part = (index: number, offset: number, duration: number, r: Partial<TranscriptionResult>) =>
  ({ index, offset, duration, result: result(r) }) satisfies PartInput;

describe('mergeParts', () => {
  it('adds each part offset so the timeline is continuous, sorted and clamped to the part', () => {
    const merged = mergeParts(
      [
        // Arrives out of order; part 1's last segment claims to end after its 300 s of audio.
        part(1, 299.4, 300, {
          segments: [
            { start: 0.5, end: 4, text: 'Third.' },
            { start: 296, end: 301.5, text: 'Fourth.' },
          ],
        }),
        part(0, 0, 299.4, {
          language: 'en',
          segments: [
            { start: 0, end: 3, text: ' First.' },
            { start: 290, end: 298, text: 'Second.' },
          ],
        }),
      ],
      { partCount: 2 },
    );
    expect(merged.segments.map((s) => [s.id, s.start, s.end, s.text])).toEqual([
      ['0:0', 0, 3, 'First.'],
      ['0:1', 290, 298, 'Second.'],
      ['1:0', 299.9, 303.4, 'Third.'],
      ['1:1', 595.4, 599.4, 'Fourth.'],
    ]);
    expect(merged.language).toBe('en');
    expect(merged.timed).toBe(true);
    for (let i = 1; i < merged.segments.length; i++) {
      expect(merged.segments[i]!.start).toBeGreaterThanOrEqual(merged.segments[i - 1]!.end);
    }
  });

  it('trims a segment that runs past the next part’s first one (a seam overlap)', () => {
    const merged = mergeParts(
      [
        part(0, 0, 10, { segments: [{ start: 8, end: 10, text: 'Hello there' }] }),
        // The model put its first segment a little before the part's own start: clamped to 10.
        part(1, 10, 10, { segments: [{ start: 0, end: 2, text: 'General Kenobi' }] }),
      ],
      { partCount: 2 },
    );
    expect(merged.segments.map((s) => [s.start, s.end])).toEqual([
      [8, 10],
      [10, 12],
    ]);
    const overlapping = mergeParts(
      [
        part(0, 0, 10, { segments: [{ start: 8, end: 10, text: 'Hello there' }] }),
        part(1, 9, 10, { segments: [{ start: 0.2, end: 2, text: 'General Kenobi' }] }),
      ],
      { partCount: 2 },
    );
    expect(overlapping.segments[0]!.end).toBeCloseTo(9.2);
  });

  it('drops a word heard at the end of one part and the start of the next, with its word timestamps', () => {
    const merged = mergeParts(
      [
        part(0, 0, 60, {
          segments: [{ start: 55, end: 59.9, text: 'We will meet on Tuesday.' }],
          words: [
            { start: 58, end: 59, word: 'on' },
            { start: 59, end: 59.9, word: 'Tuesday.' },
          ],
        }),
        part(1, 60, 60, {
          segments: [{ start: 0, end: 3, text: 'tuesday at noon, then' }],
          words: [
            { start: 0, end: 0.4, word: 'tuesday' },
            { start: 0.5, end: 0.8, word: 'at' },
            { start: 0.8, end: 1.2, word: 'noon,' },
            { start: 1.3, end: 3, word: 'then' },
          ],
        }),
      ],
      { partCount: 2 },
    );
    expect(merged.segments.map((s) => s.text)).toEqual([
      'We will meet on Tuesday.',
      'at noon, then',
    ]);
    expect(merged.segments[1]!.start).toBeCloseTo(60.4);
    expect(merged.words.map((w) => w.word)).toEqual(['on', 'Tuesday.', 'at', 'noon,', 'then']);
  });

  it('removes a repeat of several words without word timestamps, and a segment left empty', () => {
    const merged = mergeParts(
      [
        part(0, 0, 30, { segments: [{ start: 25, end: 29.8, text: 'and that is all, folks' }] }),
        part(1, 30, 30, {
          segments: [
            { start: 0, end: 1, text: 'All folks.' },
            { start: 1.5, end: 4, text: 'Next topic.' },
          ],
        }),
      ],
      { partCount: 2 },
    );
    expect(merged.segments.map((s) => s.text)).toEqual(['and that is all, folks', 'Next topic.']);
  });

  it('keeps repeats away from the seam, and repeats across a missing part', () => {
    const far = mergeParts(
      [
        part(0, 0, 30, { segments: [{ start: 10, end: 20, text: 'Yes yes' }] }),
        part(1, 30, 30, { segments: [{ start: 0, end: 1, text: 'yes, indeed' }] }),
      ],
      { partCount: 2 },
    );
    expect(far.segments.map((s) => s.text)).toEqual(['Yes yes', 'yes, indeed']);
    const gap = mergeParts(
      [
        part(0, 0, 30, { segments: [{ start: 28, end: 30, text: 'Yes' }] }),
        part(2, 60, 30, { segments: [{ start: 0, end: 1, text: 'yes' }] }),
      ],
      { partCount: 3 },
    );
    expect(gap.segments.map((s) => s.text)).toEqual(['Yes', 'yes']);
  });

  it('builds segments from words, and one segment per part without timestamps', () => {
    const fromWords = mergeParts(
      [
        part(0, 100, 20, {
          words: [
            { start: 0, end: 0.5, word: 'Hi.' },
            { start: 3, end: 3.4, word: 'Again' },
            { start: 3.4, end: 4, word: 'here.' },
          ],
        }),
      ],
      { partCount: 1 },
    );
    expect(fromWords.segments.map((s) => [s.start, s.end, s.text])).toEqual([
      [100, 100.5, 'Hi.'],
      [103, 104, 'Again here.'],
    ]);
    const untimed = mergeParts(
      [part(0, 0, 300, { text: 'First part.' }), part(1, 300, 120, { text: 'Second part.' })],
      { partCount: 2 },
    );
    expect(untimed.timed).toBe(false);
    expect(untimed.segments.map((s) => [s.start, s.end, s.text])).toEqual([
      [0, 300, 'First part.'],
      [300, 420, 'Second part.'],
    ]);
  });

  it('applies edits by segment id', () => {
    const merged = mergeParts(
      [part(0, 0, 10, { segments: [{ start: 0, end: 2, text: 'Helo' }] })],
      {
        partCount: 1,
        edits: new Map([['0:0', 'Hello']]),
      },
    );
    expect(merged.segments[0]).toMatchObject({ text: 'Hello', edited: true });
  });
});

describe('speakers', () => {
  const diarized = (partCount: number) =>
    mergeParts(
      [
        part(0, 0, 10, {
          segments: [
            { start: 0, end: 2, text: 'Hi.', speaker: '0' },
            { start: 2, end: 4, text: 'Hello.', speaker: '1' },
          ],
          words: [{ start: 0, end: 2, word: 'Hi.', speaker: '0' }],
        }),
        ...(partCount > 1
          ? [part(1, 10, 10, { segments: [{ start: 0, end: 2, text: 'Bye.', speaker: '0' }] })]
          : []),
      ],
      { partCount },
    );

  it('keeps one part’s labels as they are', () => {
    const merged = diarized(1);
    expect(merged.speakers).toEqual(['0', '1']);
    expect(merged.speakersPerPart).toBe(false);
    expect(merged.words[0]!.speaker).toBe('0');
    expect(transcriptText(merged)).toBe('Speaker 1: Hi.\n\nSpeaker 2: Hello.');
  });

  it('labels speakers per part when there are several parts, and renames apply everywhere', () => {
    const merged = diarized(2);
    expect(merged.speakers).toEqual(['1:0', '1:1', '2:0']);
    expect(merged.speakersPerPart).toBe(true);
    expect(defaultSpeakerName('2:0', true)).toBe('Speaker 1 (part 2)');
    const names = { '1:0': 'Ana', '2:0': 'Ana', '1:1': ' ' };
    expect(transcriptText(merged, names)).toBe(
      'Ana: Hi.\n\nSpeaker 2 (part 1): Hello.\n\nAna: Bye.',
    );
    expect(subtitleSegments(merged, names).map((s) => s.speaker)).toEqual([
      'Ana',
      'Speaker 2 (part 1)',
      'Ana',
    ]);
  });

  it('names labels that are not numbers', () => {
    expect(defaultSpeakerName('A', false)).toBe('Speaker A');
    expect(defaultSpeakerName('speaker_2', false)).toBe('Speaker 2');
    expect(speakerName('A', { A: 'Ben' }, false)).toBe('Ben');
  });
});

describe('exports', () => {
  const merged = mergeParts(
    [
      part(0, 0, 70, {
        language: 'en',
        segments: [
          { start: 0, end: 2.5, text: 'Hello & welcome.', speaker: '0' },
          { start: 2.5, end: 5, text: 'Thanks <all>.', speaker: '1' },
          { start: 65, end: 69.9996, text: '*Bye* #1', speaker: '1' },
        ],
        words: [{ start: 0, end: 0.123456, word: 'Hello', speaker: '0' }],
      }),
    ],
    { partCount: 1, edits: new Map([['0:1', 'Thanks <all>.']]) },
  );
  const names = { '1': 'Ben' };

  it('writes SRT and VTT with continuous cues and speaker names', () => {
    expect(toSrt(subtitleSegments(merged, names))).toBe(
      [
        '1\n00:00:00,000 --> 00:00:02,500\nSpeaker 1: Hello & welcome.',
        '2\n00:00:02,500 --> 00:00:05,000\nBen: Thanks <all>.',
        '3\n00:01:05,000 --> 00:01:10,000\nBen: *Bye* #1\n',
      ].join('\n\n'),
    );
    expect(toVtt(subtitleSegments(merged, names))).toBe(
      [
        'WEBVTT',
        '00:00:00.000 --> 00:00:02.500\n<v Speaker 1>Hello &amp; welcome.',
        '00:00:02.500 --> 00:00:05.000\n<v Ben>Thanks &lt;all&gt;.',
        '00:01:05.000 --> 00:01:10.000\n<v Ben>*Bye* #1\n',
      ].join('\n\n'),
    );
  });

  it('writes JSON with segments, words, names and millisecond times', () => {
    const json = transcriptJson(merged, names, {
      source: 'a.mp3',
      model: 'm/x',
      duration: 70.00049,
    });
    expect(json).toMatchObject({
      format: 'ortoolbox-transcript',
      version: 1,
      source: 'a.mp3',
      model: 'm/x',
      language: 'en',
      duration: 70,
      timestamps: true,
      speakers: [
        { id: '0', name: 'Speaker 1' },
        { id: '1', name: 'Ben' },
      ],
    });
    expect((json['segments'] as unknown[])[2]).toEqual({
      start: 65,
      end: 70,
      text: '*Bye* #1',
      speaker: '1',
      speakerName: 'Ben',
    });
    expect(json['words']).toEqual([{ start: 0, end: 0.123, word: 'Hello', speaker: '0' }]);
  });

  it('writes plain text paragraphs and escaped Markdown for Word', () => {
    expect(transcriptText(merged, names)).toBe(
      'Speaker 1: Hello & welcome.\n\nBen: Thanks <all>.\n\nBen: *Bye* #1',
    );
    expect(transcriptMarkdown(merged, names)).toBe(
      [
        '**[0:00] Speaker 1:** Hello & welcome.',
        '**[0:02] Ben:** Thanks \\<all\\>.',
        '**[1:05] Ben:** \\*Bye\\* \\#1',
      ].join('\n\n'),
    );
  });
});

describe('helpers', () => {
  it('finds the segment playing at a time', () => {
    const segments = mergeParts(
      [
        part(0, 0, 30, {
          segments: [
            { start: 1, end: 2, text: 'a' },
            { start: 5, end: 9, text: 'b' },
            { start: 20, end: 25, text: 'c' },
          ],
        }),
      ],
      { partCount: 1 },
    ).segments;
    expect([0, 1, 4, 5, 19.9, 20, 100].map((t) => segmentAt(segments, t))).toEqual([
      -1, 0, 0, 1, 1, 2, 2,
    ]);
  });

  it('matches text and speaker names without case or accents', () => {
    const segment = { id: '0:0', part: 0, start: 0, end: 1, text: 'Café au lait' };
    expect(segmentMatches(segment, null, 'CAFE')).toBe(true);
    expect(segmentMatches(segment, 'Zoë', 'zoe')).toBe(true);
    expect(segmentMatches(segment, null, 'tea')).toBe(false);
    expect(segmentMatches(segment, null, '  ')).toBe(true);
  });

  it('counts repeated words at a seam', () => {
    expect(seamRepeat(['so', 'we', 'went'], ['Went', 'home'])).toBe(1);
    expect(seamRepeat(['the', 'end.'], ['The', 'end', 'credits'])).toBe(2);
    expect(seamRepeat(['a'], ['b'])).toBe(0);
    expect(seamRepeat(['!'], ['?'])).toBe(0);
  });

  it('splits words at sentence ends once long enough, and at speaker changes', () => {
    expect(
      segmentsFromWords([
        { start: 0, end: 1, word: 'One.' },
        { start: 1, end: 2.5, word: 'Two' },
        { start: 2.5, end: 3, word: 'three.' },
        { start: 3, end: 4, word: 'Four', speaker: 'x' },
      ]).map((s) => s.text),
    ).toEqual(['One. Two three.', 'Four']);
  });
});

describe('model support', () => {
  it('knows timestamps, speaker labels, vocabulary and part limits per model', () => {
    expect(sttSupport('deepgram/nova-3')).toEqual({
      timestamps: true,
      diarization: true,
      keyterms: true,
      maxPartSeconds: null,
    });
    expect(sttSupport('microsoft/mai-transcribe-2').diarization).toBe(true);
    expect(sttSupport('microsoft/mai-transcribe-1.5')).toMatchObject({
      timestamps: false,
      diarization: false,
    });
    expect(sttSupport('openai/whisper-large-v3-turbo')).toMatchObject({
      timestamps: true,
      diarization: false,
      keyterms: false,
    });
    expect(sttSupport('openai/gpt-4o-mini-transcribe').timestamps).toBe(false);
    expect(partSeconds(5, 'assemblyai/universal-3-5-pro')).toBe(110);
    expect(partSeconds(5, 'openai/whisper-1')).toBe(300);
    expect(partSeconds(0, null)).toBe(30);
  });

  it('splits the vocabulary into distinct terms of at most 100 characters', () => {
    expect(parseKeyterms('ORtoolbox, OpenRouter\nKubernetes;  ortoolbox ,,')).toEqual([
      'ORtoolbox',
      'OpenRouter',
      'Kubernetes',
    ]);
    expect(parseKeyterms('x'.repeat(150))[0]).toHaveLength(100);
  });
});
