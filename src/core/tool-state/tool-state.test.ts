import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NotJsonSafeError, createToolStateStore } from '.';
import { getDb } from '../storage/db';
import { resetDb } from '../testing/state-fakes';

beforeEach(resetDb);

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
