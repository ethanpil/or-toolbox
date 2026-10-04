import { describe, expect, it } from 'vitest';
import { activeLine, insertTag, lyricsText, parseTimedLyrics, validateLyrics } from './lyrics';

/** The timed lyrics of the recorded Lyria 3 Clip answer (tests/fixtures/openrouter/music-lyria-clip.recorded.sse.txt). */
const CLIP = [
  '[0.0:3.7] HELLO WORLD, HELLO DAY',
  '[3.8:7.4] SUNSHINE ON THE WAY',
  '[7.5:11.2] LA LA LA, WE SING ALONG',
  '[11.3:14.9] THIS IS OUR LITTLE SONG',
  '[15.0:18.7] HELLO WORLD, HELLO DAY',
  '[18.8:22.4] SUNSHINE ON THE WAY',
  '[22.5:26.2] LA LA LA, WE SING ALONG',
  '[26.3:29.9] THIS IS OUR LITTLE SONG',
].join('\n');

/** The start of the recorded Lyria 3 Pro answer: section markers and start times only. */
const PRO = [
  '[[A0]]',
  '[[B1]]',
  '[12.0:] Morning light on the quiet hill',
  '[18.0:] Mist is rising and the air is still',
  '[[C2]]',
  '[36.0:] Carry me home, carry me home',
  '[42.0:] To the place where I am known',
  '[48.0:] Carry me home, carry me home',
  '[54.0:] No more walking on my own',
  '[[D3]]',
  '[[B4]]',
  '[72.0:] Dusty photos on the mantle place',
].join('\n');

describe('insertTag', () => {
  it('puts the tag on a line of its own, after a blank line when there is text before', () => {
    expect(insertTag('', 0, 0, 'Verse')).toEqual({ value: '[Verse]\n', cursor: 8 });
    expect(insertTag('Hello', 5, 5, 'Chorus')).toEqual({
      value: 'Hello\n\n[Chorus]\n',
      cursor: 16,
    });
    expect(insertTag('Line one\n', 9, 9, 'Bridge')).toEqual({
      value: 'Line one\n\n[Bridge]\n',
      cursor: 19,
    });
  });

  it('moves the rest of the line below the tag, and replaces a selection', () => {
    expect(insertTag('abc def', 4, 4, 'Outro').value).toBe('abc\n\n[Outro]\ndef');
    expect(insertTag('[Chorsu]\nla la', 0, 8, 'Chorus').value).toBe('[Chorus]\nla la');
  });
});

describe('validateLyrics', () => {
  const vocal = { instrumental: false, clip: false };

  it('accepts well-formed lyrics', () => {
    expect(validateLyrics('[Intro]\n\n[Verse 1]\nOne\nTwo\n\n[Chorus]\nThree', vocal)).toEqual([]);
    expect(validateLyrics('', vocal)).toEqual([]);
  });

  it('stops a run on an unclosed bracket and warns about everything else', () => {
    const issues = validateLyrics(
      '[Verse\nOne\n[Chrous]\nTwo\n[Chorus]\n\n[Bridge]\nI said [loud] words',
      vocal,
    );
    expect(issues).toEqual([
      { line: 1, level: 'error', message: 'Line 1: a square bracket is not closed.' },
      {
        line: 3,
        level: 'warning',
        message: 'Line 3: [Chrous] is not a section Lyria knows, so it may be sung as words.',
      },
      { line: 5, level: 'warning', message: 'Line 5: [Chorus] has no lyrics under it.' },
      {
        line: 8,
        level: 'warning',
        message:
          'Line 8: put section tags on a line of their own; use (round brackets) for backing vocals.',
      },
    ]);
  });

  it('says when lyrics will not be sent or will not fit', () => {
    expect(validateLyrics('[Verse]\nOne', { instrumental: true, clip: false })).toEqual([
      {
        line: 0,
        level: 'warning',
        message: 'Instrumental is chosen, so these lyrics are not sent.',
      },
    ]);
    const long = Array.from({ length: 12 }, (_, i) => `Line ${i}`).join('\n');
    expect(validateLyrics(long, { instrumental: false, clip: true })[0]?.message).toMatch(
      /^Lyria 3 Clip makes about 30 seconds.*Choose Song for all 12\.$/,
    );
    expect(validateLyrics(long, vocal)).toEqual([]);
  });
});

describe('parseTimedLyrics', () => {
  it('reads Clip lines with their own start and end', () => {
    const lyrics = parseTimedLyrics(CLIP);
    expect(lyrics.lines).toHaveLength(8);
    expect(lyrics.lines[0]).toEqual({
      start: 0,
      end: 3.7,
      text: 'HELLO WORLD, HELLO DAY',
      sectionStart: false,
    });
    expect(lyrics.lines[7]).toMatchObject({ start: 26.3, end: 29.9 });
    expect(lyrics.instrumental).toBe(false);
  });

  it('gives Pro lines an end from the next line, never across a section break', () => {
    const { lines } = parseTimedLyrics(PRO);
    expect(lines.map((line) => [line.start, line.end, line.sectionStart])).toEqual([
      [12, 18, false],
      [18, 24, false], // a section follows: a typical line length (6 s)
      [36, 42, true],
      [42, 48, false],
      [48, 54, false],
      [54, 60, false], // an instrumental passage follows
      [72, 78, true],
    ]);
    expect(lyricsText(parseTimedLyrics(PRO))).toBe(
      [
        'Morning light on the quiet hill',
        'Mist is rising and the air is still',
        '',
        'Carry me home, carry me home',
        'To the place where I am known',
        'Carry me home, carry me home',
        'No more walking on my own',
        '',
        'Dusty photos on the mantle place',
      ].join('\n'),
    );
  });

  it('recognises an instrumental and keeps untimed text', () => {
    const instrumental = parseTimedLyrics('<instrumental>');
    expect(instrumental).toEqual({ lines: [], instrumental: true, untimed: [] });
    expect(lyricsText(instrumental)).toBe('Instrumental');
    expect(parseTimedLyrics('Just words').untimed).toEqual(['Just words']);
  });
});

describe('activeLine', () => {
  const { lines } = parseTimedLyrics(CLIP);
  it('finds the line being sung, and none in a gap or outside', () => {
    expect(activeLine(lines, 0)).toBe(0);
    expect(activeLine(lines, 5)).toBe(1);
    expect(activeLine(lines, 3.75)).toBe(-1);
    expect(activeLine(lines, 29.5)).toBe(7);
    expect(activeLine(lines, 31)).toBe(-1);
    expect(activeLine([], 1)).toBe(-1);
  });
});
