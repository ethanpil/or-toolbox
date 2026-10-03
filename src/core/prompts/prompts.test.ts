import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RECENT_PROMPTS_CAP } from '.';
import type { CoreServices, ToolId } from '../types';
import { createTestCore, isolateChannels, resetDb } from '../testing/state-fakes';

let core: CoreServices;
let clock = Date.UTC(2026, 9, 1);

/** Advances the fake clock so usedAt values are distinct and ordered. */
const tick = (): void => {
  clock += 1000;
  vi.setSystemTime(clock);
};

beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  tick();
  core = createTestCore().core;
});
afterEach(() => vi.useRealTimers());

describe('recent prompts', () => {
  it('adds a recent prompt with a copy of the settings', async () => {
    const settings = { voice: 'alloy', nested: { speed: 1 } };
    const entry = await core.prompts.addRecent('text-to-speech', 'Read this', settings);
    settings.nested.speed = 2;
    expect(entry).toMatchObject({
      tool: 'text-to-speech',
      kind: 'recent',
      name: null,
      text: 'Read this',
      settings: { voice: 'alloy', nested: { speed: 1 } },
    });
    expect(await core.prompts.list('text-to-speech', 'recent')).toEqual([entry]);
  });

  it('moves the same text to the top with the newest settings instead of duplicating', async () => {
    const first = await core.prompts.addRecent('chat', 'hello', { t: 1 });
    tick();
    await core.prompts.addRecent('chat', 'other', {});
    tick();
    const again = await core.prompts.addRecent('chat', '  hello ', { t: 2 });
    const list = await core.prompts.list('chat', 'recent');
    expect(list.map((p) => p.text.trim())).toEqual(['hello', 'other']);
    expect(again).toMatchObject({ id: first!.id, createdAt: first!.createdAt, settings: { t: 2 } });
    expect(again!.usedAt).toBeGreaterThan(first!.usedAt);
  });

  it('keeps at most 50 per tool, dropping the oldest', async () => {
    for (let i = 0; i < RECENT_PROMPTS_CAP + 5; i++) {
      tick();
      await core.prompts.addRecent('chat', `prompt ${i}`, {});
    }
    await core.prompts.addRecent('ocr', 'other tool', {});
    const list = await core.prompts.list('chat', 'recent');
    expect(list).toHaveLength(RECENT_PROMPTS_CAP);
    expect(list[0]?.text).toBe(`prompt ${RECENT_PROMPTS_CAP + 4}`);
    expect(list.at(-1)?.text).toBe('prompt 5');
    expect(await core.prompts.list('ocr', 'recent')).toHaveLength(1);
  });

  it('ignores blank text and respects the recording switch', async () => {
    expect(await core.prompts.addRecent('chat', '   ', {})).toBeNull();
    core.settings.update((d) => {
      d.data.recordRecentPrompts = false;
    });
    expect(await core.prompts.addRecent('chat', 'private', {})).toBeNull();
    expect(await core.prompts.list('chat', 'recent')).toEqual([]);
  });
});

describe('saved prompts', () => {
  it('saves with a trimmed name, and copies a recent entry into Saved', async () => {
    const saved = await core.prompts.save({
      tool: 'image-generation',
      text: 'A red fox',
      settings: { aspect: '16:9' },
      name: '  Fox  ',
    });
    expect(saved).toMatchObject({ kind: 'saved', name: 'Fox', settings: { aspect: '16:9' } });

    const recent = await core.prompts.addRecent('image-generation', 'A blue owl', {
      aspect: '1:1',
    });
    const copy = await core.prompts.saveFromRecent(recent!.id, 'Owl');
    expect(copy).toMatchObject({
      kind: 'saved',
      name: 'Owl',
      text: 'A blue owl',
      settings: { aspect: '1:1' },
    });
    expect(copy.id).not.toBe(recent!.id);
    expect(await core.prompts.list('image-generation', 'recent')).toHaveLength(1);
    expect(await core.prompts.list('image-generation', 'saved')).toHaveLength(2);
    await expect(core.prompts.saveFromRecent('missing')).rejects.toThrow('no longer exists');
  });

  it('renames (blank → no name) and touches entries', async () => {
    const a = await core.prompts.save({ tool: 'chat', text: 'a', settings: {} });
    tick();
    const b = await core.prompts.save({ tool: 'chat', text: 'b', settings: {} });
    await core.prompts.rename(a.id, 'Alpha');
    expect((await core.prompts.list('chat', 'saved')).map((p) => p.name)).toEqual([null, 'Alpha']);
    await core.prompts.rename(a.id, '   ');
    tick();
    await core.prompts.touch(a.id);
    const list = await core.prompts.list('chat', 'saved');
    expect(list.map((p) => p.id)).toEqual([a.id, b.id]);
    expect(list[0]?.name).toBeNull();
  });
});

describe('remove, clear and restore', () => {
  beforeEach(async () => {
    await core.prompts.addRecent('chat', 'c-recent', {});
    await core.prompts.save({ tool: 'chat', text: 'c-saved', settings: {} });
    await core.prompts.addRecent('ocr', 'o-recent', {});
    await core.prompts.save({ tool: 'ocr', text: 'o-saved', settings: {} });
  });

  const texts = async (tool: ToolId) =>
    [...(await core.prompts.list(tool, 'recent')), ...(await core.prompts.list(tool, 'saved'))].map(
      (p) => p.text,
    );

  it('removes by id and returns the removed entries for Undo', async () => {
    const [entry] = await core.prompts.list('chat', 'saved');
    const removed = await core.prompts.remove([entry!.id, 'unknown']);
    expect(removed).toEqual([entry]);
    expect(await texts('chat')).toEqual(['c-recent']);
    await core.prompts.restore(removed);
    expect(await texts('chat')).toEqual(['c-recent', 'c-saved']);
  });

  it('clears by tool and kind', async () => {
    const recent = await core.prompts.clear('chat', 'recent');
    expect(recent.map((p) => p.text)).toEqual(['c-recent']);
    expect(await texts('chat')).toEqual(['c-saved']);
    expect(await texts('ocr')).toEqual(['o-recent', 'o-saved']);

    const saved = await core.prompts.clear('all', 'saved');
    expect(saved.map((p) => p.text).sort()).toEqual(['c-saved', 'o-saved']);
    const rest = await core.prompts.clear('all', 'all');
    expect(rest.map((p) => p.text)).toEqual(['o-recent']);
    expect(await core.prompts.counts()).toEqual({});

    await core.prompts.restore([...recent, ...saved, ...rest]);
    expect(await core.prompts.counts()).toEqual({
      chat: { recent: 1, saved: 1 },
      ocr: { recent: 1, saved: 1 },
    });
  });

  it('counts per tool', async () => {
    await core.prompts.save({ tool: 'chat', text: 'more', settings: {} });
    expect(await core.prompts.counts()).toEqual({
      chat: { recent: 1, saved: 2 },
      ocr: { recent: 1, saved: 1 },
    });
  });
});

describe('change notifications', () => {
  it('broadcasts the changed tool, or all for several tools', async () => {
    const seen: (ToolId | 'all')[] = [];
    core.prompts.subscribe((tool) => seen.push(tool));
    const a = await core.prompts.save({ tool: 'chat', text: 'a', settings: {} });
    const b = await core.prompts.save({ tool: 'ocr', text: 'b', settings: {} });
    await core.prompts.remove([a.id, b.id]);
    await core.prompts.clear('ocr', 'all'); // nothing left: no event
    core.bus.emit({ type: 'data-reset' });
    expect(seen).toEqual(['chat', 'ocr', 'all', 'all']);
  });

  it('reaches other tabs', async () => {
    const other = createTestCore().core;
    const seen: (ToolId | 'all')[] = [];
    other.prompts.subscribe((tool) => seen.push(tool));
    await core.prompts.addRecent('decision', 'Should I?', {});
    await Promise.resolve();
    expect(seen).toEqual(['decision']);
    expect(await other.prompts.list('decision', 'recent')).toHaveLength(1);
  });
});
