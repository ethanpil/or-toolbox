import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotJsonSafeError, createToolStateStore } from '.';
import { StateResetError } from '../errors';
import { getDb } from '../storage/db';
import { createTestCore, isolateChannels, resetDb } from '../testing/state-fakes';

beforeEach(async () => {
  isolateChannels();
  await resetDb();
});

/**
 * What Reset everything does to `kv`, in any tab: one transaction that clears it and bumps the reset generation.
 * Resolves once that transaction exists and has its requests queued, with its end (`done`) still ahead.
 */
async function startWipe(): Promise<{ done: Promise<void> }> {
  const tx = (await getDb()).transaction('kv', 'readwrite');
  const entry = await tx.store.get('meta:reset-generation');
  const generation = typeof entry?.value === 'number' ? entry.value : 0;
  void tx.store.clear();
  void tx.store.put({ key: 'meta:reset-generation', value: generation + 1, updatedAt: Date.now() });
  return { done: tx.done };
}
const wipe = async (): Promise<void> => {
  await (
    await startWipe()
  ).done;
};

describe('after a data reset', () => {
  it('refuses a write whose check ran before the reset but whose put would land behind the wipe', async () => {
    const store = createToolStateStore('bot-to-bot');
    await store.set('conversation', { turns: 3 });
    const { done: wiped } = await startWipe(); // the reset's transaction is queued first, not done yet
    const write = store.set('conversation', { turns: 4 }); // no data-reset event has arrived yet
    await wiped;
    await expect(write).rejects.toBeInstanceOf(StateResetError);
    expect(await (await getDb()).get('kv', 'tool:bot-to-bot:conversation')).toBeUndefined();
  });

  it('never lets a write started together with Reset everything bring the old value back', async () => {
    for (let round = 0; round < 6; round++) {
      await resetDb();
      const { core } = createTestCore();
      const store = core.toolState('bot-to-bot');
      await store.set('conversation', { turns: round });
      const reset = core.data.resetEverything();
      const write = store
        .set('conversation', { turns: round + 1 })
        .catch((error: unknown) => error);
      await reset;
      const outcome = await write;
      if (outcome !== undefined) expect(outcome).toBeInstanceOf(StateResetError);
      expect(await store.get('conversation')).toBeUndefined();
    }
  });

  it('refuses to store what the page held from before it, until the page reads the key again', async () => {
    const store = createToolStateStore('bot-to-bot');
    await store.set('conversation', { turns: 3 });
    await wipe();

    // An abort the reset caused writes its conversation back: refused.
    await expect(store.set('conversation', { turns: 4 })).rejects.toBeInstanceOf(StateResetError);
    await expect(store.update('conversation', () => ({ turns: 5 }))).resolves.toEqual({
      turns: 5,
    }); // update reads first

    // Deletes always go through; a key the page never knew is new data.
    await store.delete('draft');
    await store.set('fresh', { new: true });
    expect(await store.get('fresh')).toEqual({ new: true });
  });

  it('a read after the reset lets the key be written again, but never an object from before it', async () => {
    const store = createToolStateStore('chat');
    const thread = { id: 't1', messages: ['hi'] };
    await store.set('thread:t1', thread);
    await wipe();

    expect(await store.get('thread:t1')).toBeUndefined(); // e.g. a merge read before writing
    thread.messages.push('a reply that was streaming');
    await expect(store.set('thread:t1', thread)).rejects.toBeInstanceOf(StateResetError);
    await expect(store.update('thread:t1', () => thread)).rejects.toBeInstanceOf(StateResetError);
    await store.set('thread:t1', { id: 't1', messages: ['a new chat'] });
    expect(await store.get('thread:t1')).toEqual({ id: 't1', messages: ['a new chat'] });
  });

  it('applies to resets made in another tab, whether or not its event has arrived', async () => {
    const store = createTestCore().core.toolState('data-extractor');
    await store.get('schemas');
    await createTestCore().core.data.resetEverything(); // another tab
    await expect(store.set('schemas', [{ name: 'old' }])).rejects.toBeInstanceOf(StateResetError);
    expect(await (await getDb()).get('kv', 'tool:data-extractor:schemas')).toBeUndefined();
  });
});

describe('tool state store', () => {
  it('stores JSON values under tool:<id>:<key>', async () => {
    const video = createToolStateStore('video-studio');
    const value = { steps: [{ prompt: 'a cat', seconds: 5 }], title: 'Cats', done: false };
    await video.set('sequence:1', value);
    expect(await video.get('sequence:1')).toEqual(value);
    expect((await (await getDb()).get('kv', 'tool:video-studio:sequence:1'))?.value).toEqual(value);
    expect(await video.get('missing')).toBeUndefined();
  });

  it('keeps tools apart and lists keys without the prefix', async () => {
    const chat = createToolStateStore('chat');
    const decision = createToolStateStore('decision');
    await chat.set('thread:a', 1);
    await chat.set('thread:b', 2);
    await decision.set('decider', { q: 'x' });
    await (await getDb()).put('kv', { key: 'models:catalog', value: [], updatedAt: 0 });

    expect((await chat.keys()).sort()).toEqual(['thread:a', 'thread:b']);
    expect(await decision.keys()).toEqual(['decider']);
    await chat.delete('thread:a');
    expect(await chat.keys()).toEqual(['thread:b']);
    expect(await chat.get('decider')).toBeUndefined();
  });

  it('tells the bus about every stored change, and nothing about a refused one', async () => {
    const events: unknown[] = [];
    const store = createToolStateStore('chat', { emit: (event) => events.push(event) });
    await store.set('thread:a', { x: 1 });
    await store.delete('thread:a');
    await store.set('thread:b', new Blob(['x'])).catch(() => undefined);
    await store.get('thread:a');
    await store.keys();
    expect(events).toEqual([
      { type: 'tool-state-changed', tool: 'chat', key: 'thread:a' },
      { type: 'tool-state-changed', tool: 'chat', key: 'thread:a' },
    ]);
  });

  it('update: reads, changes and writes one key, and loses no update of parallel callers', async () => {
    const events: unknown[] = [];
    const store = createToolStateStore('model-arena', { emit: (event) => events.push(event) });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.update<number>('tally', async (current) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return (current ?? 0) + 1;
        }),
      ),
    );
    expect(await store.get('tally')).toBe(10);
    expect(events).toHaveLength(10);
  });

  it('update: returning the current value writes nothing; undefined deletes the key', async () => {
    const events: unknown[] = [];
    const store = createToolStateStore('chat', { emit: (event) => events.push(event) });
    await store.set('k', { n: 1 });
    events.length = 0;
    await expect(store.update('k', (current) => current)).resolves.toEqual({ n: 1 });
    expect(events).toEqual([]);
    await expect(store.update('k', () => undefined)).resolves.toBeUndefined();
    expect(await store.keys()).toEqual([]);
    expect(events).toEqual([{ type: 'tool-state-changed', tool: 'chat', key: 'k' }]);
  });

  it('update: a failing change writes nothing and does not block the next one', async () => {
    const store = createToolStateStore('chat');
    await store.set('k', 1);
    await expect(
      store.update('k', () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    await expect(store.update<number>('k', (n) => (n ?? 0) + 1)).resolves.toBe(2);
  });

  it('stores a detached copy', async () => {
    const store = createToolStateStore('chat');
    const value = { list: [1] };
    await store.set('k', value);
    value.list.push(2);
    expect(await store.get('k')).toEqual({ list: [1] });
  });

  it.each([
    ['a Blob', { image: new Blob(['x']) }, 'value.image is a Blob'],
    ['an ArrayBuffer', [new ArrayBuffer(4)], 'value[0] is binary data'],
    ['a typed array', { a: { b: new Uint8Array(2) } }, 'value.a.b is binary data'],
    ['a Date', { when: new Date(0) }, 'value.when is a Date'],
    ['a Map', new Map(), 'value is a Map'],
    ['a function', { f: () => 1 }, 'value.f is a function'],
    ['NaN', { n: Number.NaN }, 'value.n is NaN'],
    ['undefined', undefined, 'value is undefined'],
  ])('rejects %s with a clear error', async (_label, value, message) => {
    const store = createToolStateStore('chat');
    const error = (await store.set('k', value).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(NotJsonSafeError);
    expect(error.message).toContain(message);
    expect(await store.get('k')).toBeUndefined();
  });
});
