import { describe, expect, it } from 'vitest';
import {
  clampTrim,
  insertClip,
  joinLength,
  joinPlan,
  moveClip,
  parseTimeline,
  playLength,
  removeClip,
  slotPlacement,
  type TimelineClip,
  timelineJson,
  updateClip,
} from './timeline';

const clip = (id: string, patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id,
  name: `${id}.mp4`,
  source: 'generated',
  jobId: `job-${id}`,
  remoteId: `gen-vid-${id}`,
  keyId: 'key',
  model: 'x-ai/grok-imagine-video',
  prompt: id,
  duration: 1,
  trimStart: 0,
  trimEnd: 0,
  continues: false,
  dropFirstFrame: false,
  included: true,
  sequenceId: null,
  slotKey: null,
  attempt: 1,
  expired: false,
  staleSource: false,
  createdAt: 1,
  ...patch,
});
const ids = (clips: readonly TimelineClip[]): string[] => clips.map((c) => c.id);

describe('timeline', () => {
  it('inserts at the end, after or before a clip (end when the anchor is gone)', () => {
    let clips = insertClip([], clip('a'), 'end');
    clips = insertClip(clips, clip('c'), 'end');
    clips = insertClip(clips, clip('b'), { after: 'a' });
    expect(ids(clips)).toEqual(['a', 'b', 'c']);
    clips = insertClip(clips, clip('z'), { before: 'a' });
    expect(ids(clips)).toEqual(['z', 'a', 'b', 'c']);
    expect(ids(insertClip(clips, clip('y'), { after: 'gone' }))).toEqual(['z', 'a', 'b', 'c', 'y']);
    // Inserting a known id moves it instead of duplicating it.
    expect(ids(insertClip(clips, clip('z'), 'end'))).toEqual(['a', 'b', 'c', 'z']);
  });

  it('moves clips by one, clamped at the ends', () => {
    const clips = [clip('a'), clip('b'), clip('c')];
    expect(ids(moveClip(clips, 'a', 1))).toEqual(['b', 'a', 'c']);
    expect(ids(moveClip(clips, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(moveClip(clips, 'a', -1)).toBe(clips);
    expect(moveClip(clips, 'c', 1)).toBe(clips);
    expect(moveClip(clips, 'nope', 1)).toBe(clips);
  });

  it('removes and updates clips', () => {
    const clips = [clip('a'), clip('b')];
    expect(ids(removeClip(clips, 'a'))).toEqual(['b']);
    expect(updateClip(clips, 'b', { included: false })[1]?.included).toBe(false);
  });

  it('keeps trims within the clip, leaving at least a tenth of a second', () => {
    expect(clampTrim(1, 0.2, 0.3)).toEqual({ trimStart: 0.2, trimEnd: 0.3 });
    expect(clampTrim(1, -1, Number.NaN)).toEqual({ trimStart: 0, trimEnd: 0 });
    expect(clampTrim(1, 0.5, 0.9)).toEqual({ trimStart: 0.5, trimEnd: 0.4 });
    expect(clampTrim(1, 2, 0)).toEqual({ trimStart: 0.9, trimEnd: 0 });
    expect(clampTrim(null, 3, 1)).toEqual({ trimStart: 3, trimEnd: 1 });
  });

  it('plans the join: included clips in order, with trims and dropped first frames', () => {
    const clips = [
      clip('a', { trimEnd: 0.25 }),
      clip('b', { continues: true, dropFirstFrame: true }),
      clip('c', { included: false }),
      clip('d', { continues: true, dropFirstFrame: false, trimStart: 0.1 }),
      // OpenRouter no longer has it: it cannot be joined.
      clip('e', { expired: true }),
    ];
    expect(joinPlan(clips)).toEqual([
      { id: 'a', trimEnd: 0.25 },
      { id: 'b', dropFirstFrame: true },
      { id: 'd', trimStart: 0.1 },
    ]);
    expect(playLength(clips[1]!)).toBeCloseTo(1 - 1 / 24);
    expect(joinLength(clips)).toBeCloseTo(0.75 + (1 - 1 / 24) + 0.9);
    expect(joinLength([clip('x', { duration: null })])).toBeNull();
  });

  it('places sequence clips in step order, whatever order they finish in', () => {
    const keys = ['0:a', '0:b', '0:c', '0:d'];
    const of = (key: string): TimelineClip => clip(key, { sequenceId: 'run', slotKey: key });
    let clips: TimelineClip[] = [clip('upload')];
    clips = insertClip(clips, of('0:c'), slotPlacement(clips, keys, 'run', '0:c'));
    expect(ids(clips)).toEqual(['upload', '0:c']);
    clips = insertClip(clips, of('0:a'), slotPlacement(clips, keys, 'run', '0:a'));
    expect(ids(clips)).toEqual(['upload', '0:a', '0:c']);
    clips = insertClip(clips, of('0:d'), slotPlacement(clips, keys, 'run', '0:d'));
    clips = insertClip(clips, of('0:b'), slotPlacement(clips, keys, 'run', '0:b'));
    expect(ids(clips)).toEqual(['upload', '0:a', '0:b', '0:c', '0:d']);
    expect(slotPlacement([], keys, 'run', '0:a')).toBe('end');
  });

  it('round-trips through storage and drops broken or repeated entries', () => {
    const clips = [clip('a', { source: 'upload', remoteId: null, jobId: null }), clip('b')];
    expect(parseTimeline(JSON.parse(JSON.stringify(timelineJson(clips))))).toEqual(clips);
    expect(
      parseTimeline({ v: 1, clips: [{ id: 'a' }, { id: 'a' }, { nope: 1 }, null] }),
    ).toHaveLength(1);
    expect(parseTimeline({ v: 2, clips: [clip('a')] })).toEqual([]);
    expect(parseTimeline(undefined)).toEqual([]);
  });
});
