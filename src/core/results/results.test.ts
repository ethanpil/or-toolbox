import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { createResultsService } from '.';
import type { CoreServices, ResultKind, ResultsService } from '../types';

let results: ResultsService;
let created: Blob[];
let revoked: string[];
let clicks: { href: string; download: string }[];

const add = (kind: ResultKind, name: string, content = name) =>
  results.add({ tool: 'image-generation', kind, name, blob: new Blob([content]) });

/** Dispatches beforeunload and reports whether the page asked to confirm leaving. */
const leaveIsGuarded = (): boolean => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

beforeEach(() => {
  created = [];
  revoked = [];
  clicks = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    created.push(blob as Blob);
    return `blob:test/${created.length}`;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  results = createResultsService({} as CoreServices);
});
afterEach(() => {
  for (const result of results.pending()) results.remove(result.id);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('summary', () => {
  it('is null when nothing is pending', () => {
    expect(results.summary()).toBeNull();
  });

  it('pluralises and joins by kind', () => {
    add('image', 'a.png');
    expect(results.summary()).toBe('1 image not downloaded');
    add('image', 'b.png');
    add('image', 'c.png');
    add('video', 'v.mp4');
    expect(results.summary()).toBe('3 images and 1 video not downloaded');
    add('audio', 's.mp3');
    add('file', 'x.zip');
    add('file', 'y.zip');
    expect(results.summary()).toBe('3 images, 1 audio file, 1 video and 2 files not downloaded');
  });

  it('leaves out downloaded results', () => {
    const a = add('image', 'a.png');
    add('video', 'v.mp4');
    results.markDownloaded(a.id);
    expect(results.summary()).toBe('1 video not downloaded');
    expect(results.pending().map((r) => r.name)).toEqual(['v.mp4']);
  });
});

describe('object URLs and downloads', () => {
  it('caches object URLs and revokes them on remove', () => {
    const a = add('image', 'a.png');
    const url = results.objectUrl(a.id);
    expect(results.objectUrl(a.id)).toBe(url);
    expect(created).toHaveLength(1);
    results.remove(a.id);
    expect(revoked).toEqual([url]);
    expect(() => results.objectUrl(a.id)).toThrow('Unknown result');
  });

  it('downloads one result with its name and marks it downloaded', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const fn = vi.fn();
    results.subscribe(fn);
    const a = add('audio', 'speech.mp3');
    results.download(a.id);
    expect(clicks).toEqual([{ href: 'blob:test/1', download: 'speech.mp3' }]);
    expect(results.pending()).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(revoked).toEqual(['blob:test/1']); // temporary URL freed later
  });

  it('keeps the display URL alive when downloading', () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const a = add('image', 'a.png');
    const url = results.objectUrl(a.id);
    results.download(a.id);
    vi.advanceTimersByTime(60_000);
    expect(revoked).not.toContain(url);
    expect(results.objectUrl(a.id)).toBe(url);
  });

  it('marks the object that add() returned as downloaded', () => {
    const a = add('image', 'a.png');
    const b = add('image', 'b.png');
    results.download(a.id);
    results.markDownloaded(b.id);
    expect(a.downloaded).toBe(true);
    expect(b.downloaded).toBe(true);
  });

  it('downloads under a safe file name', () => {
    const a = add('image', 'cats/dogs: "best"?.png');
    results.download(a.id);
    expect(clicks[0]?.download).toBe('cats_dogs_ _best__.png');
  });

  it('names the ZIP after the UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 2, 23, 30));
    add('image', 'a.png');
    add('image', 'b.png');
    await results.downloadAll();
    expect(clicks[0]?.download).toBe('ortoolbox-results-2026-10-02.zip');
  });

  it('downloadAll downloads a single result directly', async () => {
    add('video', 'clip.mp4');
    await results.downloadAll();
    expect(clicks.map((c) => c.download)).toEqual(['clip.mp4']);
  });

  it('downloadAll zips several results, with unique names', async () => {
    add('image', 'img.png', 'one');
    add('image', 'img.png', 'two');
    add('audio', 'IMG.png', 'three');
    const done = add('file', 'done.txt');
    results.markDownloaded(done.id);

    await results.downloadAll();

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.download).toMatch(/^ortoolbox-results-\d{4}-\d{2}-\d{2}\.zip$/);
    const zip = created.at(-1)!;
    expect(zip.type).toBe('application/zip');
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const decoded = Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]),
    );
    expect(decoded).toEqual({ 'img.png': 'one', 'img (2).png': 'two', 'IMG (3).png': 'three' });
    expect(results.summary()).toBeNull();
  });

  it('does nothing when everything is downloaded', async () => {
    await results.downloadAll();
    expect(clicks).toEqual([]);
  });
});

describe('leave-page guard', () => {
  it('is registered only while something is pending', () => {
    expect(leaveIsGuarded()).toBe(false);
    const a = add('image', 'a.png');
    const b = add('video', 'b.mp4');
    expect(leaveIsGuarded()).toBe(true);
    results.download(a.id);
    expect(leaveIsGuarded()).toBe(true);
    results.remove(b.id);
    expect(leaveIsGuarded()).toBe(false);
  });

  it('stops notifying after unsubscribe', () => {
    const fn = vi.fn();
    results.subscribe(fn)();
    add('image', 'a.png');
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('hold', () => {
  it('guards leaving while unsaved work is held, and lists it', () => {
    expect(results.holds()).toEqual([]);
    const release = results.hold('A recording in progress');
    const other = results.hold('3 paid parts not joined');
    expect(results.holds()).toEqual(['A recording in progress', '3 paid parts not joined']);
    expect(leaveIsGuarded()).toBe(true);
    expect(results.summary()).toBeNull(); // holds are not results
    const seen = vi.fn();
    results.subscribe(seen);
    release();
    release(); // idempotent
    expect(results.holds()).toEqual(['3 paid parts not joined']);
    expect(seen).toHaveBeenCalledOnce();
    expect(leaveIsGuarded()).toBe(true);
    other();
    expect(leaveIsGuarded()).toBe(false);
  });

  it('releaseHolds drops every hold (after "Leave anyway")', () => {
    results.hold('A recording in progress');
    results.releaseHolds();
    expect(results.holds()).toEqual([]);
    expect(leaveIsGuarded()).toBe(false);
  });
});
