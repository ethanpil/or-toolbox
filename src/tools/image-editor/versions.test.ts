import { describe, expect, it } from 'vitest';
import { type NewVersion, VersionHistory, versionLabel } from './versions';

const blob = new Blob(['x'], { type: 'image/png' });
const edit = (parentId: string, patch: Partial<NewVersion> = {}): NewVersion => ({
  blob,
  name: 'edit.png',
  width: 100,
  height: 80,
  parentId,
  mode: 'inpaint',
  instruction: 'make it blue',
  model: 'test/image',
  ...patch,
});

describe('VersionHistory', () => {
  it('starts from an original and adds edits as the working version', () => {
    let now = 1000;
    const history = new VersionHistory(() => now++);
    expect(() => history.add(edit('none'))).toThrow();
    const original = history.reset({ blob, name: 'photo.png', width: 100, height: 80 });
    expect(original).toMatchObject({ number: 0, parentId: null, mode: null, createdAt: 1000 });
    expect(history.working).toBe(original);
    const first = history.add(edit(original.id));
    const second = history.add(edit(first.id, { mode: 'outpaint', width: 150 }));
    expect([first.number, second.number]).toEqual([1, 2]);
    expect(history.working).toBe(second);
    expect(history.parentOf(second.id)).toBe(first);
    expect(history.parentOf(original.id)).toBeNull();
    expect(history.all().map(versionLabel)).toEqual(['Original', 'Version 1', 'Version 2']);
  });

  it('continues from any version without overwriting the later ones', () => {
    const history = new VersionHistory();
    const original = history.reset({ blob, name: 'photo.png', width: 100, height: 80 });
    const first = history.add(edit(original.id));
    expect(history.select(original.id)).toBe(true);
    expect(history.select('missing')).toBe(false);
    const branch = history.add(edit(original.id));
    expect(branch.number).toBe(2);
    expect(history.all()).toHaveLength(3);
    expect(history.get(first.id)).toBe(first);
    expect(history.parentOf(branch.id)).toBe(original);
  });

  it('removes an edit: children move to its parent, the working version falls back, numbers stay', () => {
    const history = new VersionHistory();
    const original = history.reset({ blob, name: 'photo.png', width: 100, height: 80 });
    const first = history.add(edit(original.id));
    const second = history.add(edit(first.id));
    expect(history.remove(original.id)).toBeNull();
    expect(history.remove(first.id)).toBe(first);
    expect(history.parentOf(second.id)).toBe(original);
    expect(history.working).toBe(second);
    history.remove(second.id);
    expect(history.working).toBe(original);
    expect(history.add(edit(original.id)).number).toBe(3);
  });

  it('forgets everything on a new original', () => {
    const history = new VersionHistory();
    const original = history.reset({ blob, name: 'a.png', width: 10, height: 10 });
    history.add(edit(original.id));
    const next = history.reset({ blob, name: 'b.png', width: 20, height: 20 });
    expect(history.all()).toEqual([next]);
    expect(next.number).toBe(0);
    expect(history.original).toBe(next);
  });
});
