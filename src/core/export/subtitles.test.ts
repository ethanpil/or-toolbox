// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatTimestamp, toSrt, toVtt, wrapLines } from './subtitles';

describe('formatTimestamp', () => {
  it('formats hours, minutes, seconds and milliseconds', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(83.5)).toBe('00:01:23,500');
    expect(formatTimestamp(3661.001)).toBe('01:01:01,001');
    expect(formatTimestamp(36000)).toBe('10:00:00,000');
    expect(formatTimestamp(83.5, '.')).toBe('00:01:23.500');
  });

  it('carries rounding instead of printing 60 seconds', () => {
    expect(formatTimestamp(59.9996)).toBe('00:01:00,000');
    expect(formatTimestamp(3599.9999)).toBe('01:00:00,000');
  });

  it('clamps negatives and non-numbers to zero', () => {
    expect(formatTimestamp(-3)).toBe('00:00:00,000');
    expect(formatTimestamp(Number.NaN)).toBe('00:00:00,000');
  });
});

describe('wrapLines', () => {
  it('wraps at word boundaries and keeps long words whole', () => {
    expect(wrapLines('The quick brown fox jumps over the lazy dog', 20)).toEqual([
      'The quick brown fox',
      'jumps over the lazy',
      'dog',
    ]);
    expect(wrapLines('a supercalifragilistic word', 10)).toEqual([
      'a',
      'supercalifragilistic',
      'word',
    ]);
  });

  it('keeps existing line breaks and can be turned off', () => {
    expect(wrapLines('one\ntwo three', 5)).toEqual(['one', 'two', 'three']);
    expect(wrapLines('a very long line indeed', 0)).toEqual(['a very long line indeed']);
  });
});

describe('toSrt', () => {
  it('numbers cues and writes timestamps with commas', () => {
    const srt = toSrt([
      { start: 0, end: 2.5, text: 'Hello there.' },
      { start: 2.5, end: 61.25, text: 'Second cue.' },
    ]);
    expect(srt).toBe(
      [
        '1',
        '00:00:00,000 --> 00:00:02,500',
        'Hello there.',
        '',
        '2',
        '00:00:02,500 --> 00:01:01,250',
        'Second cue.',
        '',
      ].join('\n'),
    );
  });

  it('wraps long text at the line length', () => {
    const srt = toSrt([{ start: 0, end: 1, text: 'The quick brown fox jumps over the lazy dog' }], {
      maxLineLength: 20,
    });
    expect(srt.split('\n').slice(2, 5)).toEqual([
      'The quick brown fox',
      'jumps over the lazy',
      'dog',
    ]);
  });

  it('prefixes the speaker, skips empty cues and renumbers', () => {
    const srt = toSrt([
      { start: 0, end: 1, text: '   ', speaker: 'A' },
      { start: 1, end: 2, text: 'Hi', speaker: ' Speaker  1 ' },
    ]);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,000\nSpeaker 1: Hi\n');
  });

  it('keeps cue text from ending the cue early', () => {
    const srt = toSrt([{ start: 0, end: 1, text: 'one\n\n\ntwo --> three' }]);
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\none\ntwo -> three\n');
  });

  it('never writes a cue that ends before it starts', () => {
    const srt = toSrt([
      { start: 5, end: 5, text: 'x' },
      { start: 6, end: 2, text: 'y' },
    ]);
    expect(srt).toContain('00:00:05,000 --> 00:00:05,001');
    expect(srt).toContain('00:00:06,000 --> 00:00:06,001');
  });
});

describe('toVtt', () => {
  it('starts with WEBVTT and uses dots in timestamps', () => {
    const vtt = toVtt([{ start: 1, end: 3.25, text: 'Hello' }]);
    expect(vtt).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.250\nHello\n');
  });

  it('escapes markup characters and uses voice tags for speakers', () => {
    const vtt = toVtt([{ start: 0, end: 1, text: 'a < b & c > d', speaker: 'Ann <B>' }]);
    expect(vtt).toBe(
      'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Ann &lt;B&gt;>a &lt; b &amp; c &gt; d\n',
    );
  });

  it('is just the header for no segments', () => {
    expect(toVtt([])).toBe('WEBVTT\n');
  });
});
