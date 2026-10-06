import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createToolStateStore } from '../../core/tool-state';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import {
  findByName,
  loadDeciders,
  lossOnLoad,
  newDeciderId,
  readDecider,
  removeDecider,
  renameDecider,
  type SavedDecider,
  saveDecider,
  sortDeciders,
} from './saved';
import { blankState, type StateDef } from './schema';
import { templateQuestions } from './templates';

const decider = (patch: Partial<SavedDecider> = {}): SavedDecider => ({
  id: newDeciderId(),
  name: 'Support tickets',
  questions: templateQuestions('ticket-triage')!,
  state: null,
  savedAt: 1_750_000_000_000,
  ...patch,
});

beforeEach(async () => {
  isolateChannels();
  await resetDb();
});

describe('saved deciders', () => {
  it('saves, lists alphabetically, and removes', async () => {
    const store = createToolStateStore('decision');
    const b = decider({ name: 'banana' });
    const a = decider({ name: 'Apple' });
    await saveDecider(store, b);
    await saveDecider(store, a);
    expect((await loadDeciders(store)).map((d) => d.name)).toEqual(['Apple', 'banana']);
    await removeDecider(store, a.id);
    expect((await loadDeciders(store)).map((d) => d.name)).toEqual(['banana']);
  });

  it('keeps the situation only when it was saved with the questions', async () => {
    const store = createToolStateStore('decision');
    const plain = decider({ name: 'a' });
    const withState = decider({
      name: 'b',
      state: {
        mode: 'fields',
        text: 'kept hidden',
        fields: [
          { key: 'tier', value: 'pro' },
          { key: '', value: '' },
        ],
      },
    });
    await saveDecider(store, plain);
    await saveDecider(store, withState);
    const [first, second] = await loadDeciders(store);
    expect(first!.state).toBeNull();
    expect(second!.state).toEqual(withState.state);
    expect(second!.questions).toEqual(withState.questions);
  });

  it('puts back exactly the record that was removed, under its old id (Undo)', async () => {
    const store = createToolStateStore('decision');
    const original = decider({ name: 'Keep me', savedAt: 5 });
    await saveDecider(store, original);
    await removeDecider(store, original.id);
    expect(await loadDeciders(store)).toEqual([]);
    await saveDecider(store, original);
    expect(await loadDeciders(store)).toEqual([original]);
  });

  it('renames by saving the same id under a new name', async () => {
    const store = createToolStateStore('decision');
    const original = decider();
    await saveDecider(store, original);
    await saveDecider(store, { ...original, name: 'Renamed' });
    const list = await loadDeciders(store);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: original.id, name: 'Renamed' });
  });

  it('renames what is stored now, so a save from another tab is not overwritten', async () => {
    const store = createToolStateStore('decision');
    const stale = decider();
    await saveDecider(store, stale);
    // Another tab saved new questions under the same id after this one read it.
    const fresh = { ...stale, questions: templateQuestions('ticket-triage')!.slice(0, 1) };
    await saveDecider(store, fresh);
    expect(await renameDecider(store, stale.id, 'Renamed')).toMatchObject({ name: 'Renamed' });
    const [stored] = await loadDeciders(store);
    expect(stored).toMatchObject({ id: stale.id, name: 'Renamed' });
    expect(stored!.questions).toHaveLength(1);
  });

  it('does not bring back a decider another tab deleted when it is renamed', async () => {
    const store = createToolStateStore('decision');
    const gone = decider();
    expect(await renameDecider(store, gone.id, 'Renamed')).toBeNull();
    expect(await loadDeciders(store)).toEqual([]);
  });

  it('keeps each decider under a key of its own, apart from other state of the tool', async () => {
    const store = createToolStateStore('decision');
    await store.set('something-else', { a: 1 });
    const one = decider();
    await saveDecider(store, one);
    expect((await store.keys()).sort()).toEqual([`decider:${one.id}`, 'something-else'].sort());
    expect(await loadDeciders(store)).toHaveLength(1);
  });

  it('skips records that are not valid deciders instead of trusting them', async () => {
    const store = createToolStateStore('decision');
    await store.set('decider:junk', { id: 'junk' });
    await store.set('decider:text', 'text');
    await store.set('decider:noname', { id: 'x', name: ' ', questions: [{}] });
    await store.set('decider:noquestions', { id: 'y', name: 'y', questions: [] });
    const good = decider();
    await saveDecider(store, good);
    expect(await loadDeciders(store)).toEqual([good]);
  });

  it('reads a record leniently and ignores unknown keys', () => {
    const read = readDecider({
      id: 'abc',
      name: '  Mixed  ',
      questions: [{ name: 'Q', id: 'q', type: 'noul', instructions: 'x', bogus: true }],
      state: { mode: 'fields', fields: [{ key: 'a', value: 'b' }], extra: 1 },
      savedAt: 'yesterday',
      other: 1,
    })!;
    expect(read.name).toBe('Mixed');
    expect(read.savedAt).toBe(0);
    expect(read.state).toEqual({ mode: 'fields', text: '', fields: [{ key: 'a', value: 'b' }] });
    expect(read.questions[0]).toMatchObject({ id: 'q', threshold: 80 });
    expect(readDecider(null)).toBeNull();
    expect(readDecider({ id: '', name: 'x', questions: [{}] })).toBeNull();
  });

  it('finds a decider by name, ignoring case and spaces', () => {
    const list = [decider({ name: 'Support tickets' })];
    expect(findByName(list, '  support TICKETS ')).toBe(list[0]);
    expect(findByName(list, 'other')).toBeUndefined();
  });

  it('sorts names the way a person reads them', () => {
    const names = sortDeciders([
      decider({ name: 'zebra' }),
      decider({ name: 'Äpfel' }),
      decider({ name: 'apple' }),
    ]).map((d) => d.name);
    expect(names).toEqual(['Äpfel', 'apple', 'zebra']);
  });

  it('gives every decider its own id', () => {
    expect(newDeciderId()).not.toBe(newDeciderId());
  });
});

describe('what loading a decider would lose', () => {
  const typed: StateDef = { mode: 'text', text: 'A ticket I typed', fields: [] };
  const saved: StateDef = { mode: 'text', text: 'The saved situation', fields: [] };
  const blank: StateDef = blankState();

  it('is the questions when they were edited', () => {
    expect(lossOnLoad({ questionsEdited: true, current: blank, incoming: null })).toEqual({
      questions: true,
      situation: false,
    });
  });

  it('is the situation when the decider brings one that replaces text in the form', () => {
    expect(lossOnLoad({ questionsEdited: false, current: typed, incoming: saved })).toEqual({
      questions: false,
      situation: true,
    });
    const fields: StateDef = { mode: 'fields', text: '', fields: [{ key: 'a', value: 'b' }] };
    expect(lossOnLoad({ questionsEdited: false, current: fields, incoming: saved }).situation).toBe(
      true,
    );
    // Text kept hidden behind the other mode counts too.
    const hidden: StateDef = { mode: 'fields', text: 'hidden words', fields: [] };
    expect(lossOnLoad({ questionsEdited: false, current: hidden, incoming: saved }).situation).toBe(
      true,
    );
  });

  it('is nothing when the form has no situation, or the decider has none, or they are the same', () => {
    expect(lossOnLoad({ questionsEdited: false, current: blank, incoming: saved })).toEqual({
      questions: false,
      situation: false,
    });
    expect(lossOnLoad({ questionsEdited: false, current: typed, incoming: null }).situation).toBe(
      false,
    );
    expect(lossOnLoad({ questionsEdited: false, current: typed, incoming: typed }).situation).toBe(
      false,
    );
  });
});
