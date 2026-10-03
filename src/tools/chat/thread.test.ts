import { describe, expect, it } from 'vitest';
import {
  activePath,
  addNode,
  appendUser,
  createThread,
  deleteBranch,
  editUser,
  leaf,
  matchesQuery,
  parseThread,
  pathTo,
  regenerate,
  selectSibling,
  siblingInfo,
  type Thread,
  threadTotals,
  THREAD_VERSION,
  titleFrom,
} from './thread';

/** A thread: "Hi" → "Hello", "Plan a trip" → "Where to?". */
function conversation(): Thread {
  const thread = createThread({ id: 't1', now: 1000 });
  const hi = appendUser(thread, 'Hi');
  addNode(thread, hi.id, { role: 'assistant', content: 'Hello', model: 'a/model', status: 'done' });
  const trip = appendUser(thread, 'Plan a trip');
  addNode(thread, trip.id, {
    role: 'assistant',
    content: 'Where to?',
    model: 'a/model',
    status: 'done',
    usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.002, latencyMs: 800 },
  });
  return thread;
}

const texts = (thread: Thread): string[] => activePath(thread).map((node) => node.content);

describe('thread tree', () => {
  it('appends messages along the active path and names the thread from the first one', () => {
    const thread = conversation();
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?']);
    expect(thread.title).toBe('Hi');
    expect(leaf(thread)?.content).toBe('Where to?');
    expect(pathTo(thread, leaf(thread)!.id).map((node) => node.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('edits a user message into a sibling branch and keeps the original', () => {
    const thread = conversation();
    const trip = activePath(thread)[2]!;
    const edited = editUser(thread, trip.id, 'Plan a weekend in Rome');
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a weekend in Rome']);
    expect(siblingInfo(thread, edited.id)).toEqual({ index: 1, count: 2 });

    // Back to the first version: its reply is still there.
    expect(selectSibling(thread, edited.id, -1)).toBe(trip.id);
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?']);
    expect(selectSibling(thread, trip.id, -1)).toBeNull();
    expect(selectSibling(thread, trip.id, 1)).toBe(edited.id);
  });

  it('keeps attachments when a message is edited', () => {
    const thread = createThread();
    const ref = { id: 'a1', name: 'x.png', type: 'image/png', size: 3, kind: 'image' as const };
    const first = appendUser(thread, 'What is this?', [ref]);
    const edited = editUser(thread, first.id, 'Describe this');
    expect(edited.attachments).toEqual([ref]);
    expect(thread.roots).toEqual([first.id, edited.id]);
  });

  it('regenerates a reply as a sibling, selected, with the model asked', () => {
    const thread = conversation();
    const reply = leaf(thread)!;
    const again = regenerate(thread, reply.id, 'b/other');
    expect(again).toMatchObject({ role: 'assistant', model: 'b/other', status: 'streaming' });
    expect(leaf(thread)?.id).toBe(again.id);
    expect(siblingInfo(thread, reply.id)).toEqual({ index: 0, count: 2 });
    expect(() => regenerate(thread, activePath(thread)[0]!.id, 'x')).toThrow(/Not a reply/);
  });

  it('deletes a branch with everything below it and selects a neighbour', () => {
    const thread = conversation();
    const trip = activePath(thread)[2]!;
    const edited = editUser(thread, trip.id, 'Edited');
    const removed = deleteBranch(thread, edited.id);
    expect(removed).toEqual([edited.id]);
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?']);

    const removedAll = deleteBranch(thread, activePath(thread)[1]!.id);
    expect(removedAll).toHaveLength(3);
    expect(texts(thread)).toEqual(['Hi']);
    expect(Object.keys(thread.nodes)).toHaveLength(1);
  });

  it('adds up usage of every reply on every branch', () => {
    const thread = conversation();
    const reply = leaf(thread)!;
    const again = regenerate(thread, reply.id, 'a/model');
    again.usage = {
      promptTokens: 20,
      completionTokens: 7,
      costUsd: 0.003,
      latencyMs: 200,
      costUnknown: true,
    };
    expect(threadTotals(thread)).toEqual({
      replies: 2,
      promptTokens: 30,
      completionTokens: 12,
      costUsd: 0.005,
      latencyMs: 1000,
      approximate: true,
    });
  });

  it('searches titles and every message', () => {
    const thread = conversation();
    expect(matchesQuery(thread, 'where')).toBe(true);
    expect(matchesQuery(thread, '  HI ')).toBe(true);
    expect(matchesQuery(thread, 'rome')).toBe(false);
    expect(matchesQuery(thread, '')).toBe(true);
  });

  it('makes short titles from the first line', () => {
    expect(titleFrom('\n  First line \nsecond')).toBe('First line');
    expect(titleFrom('x'.repeat(80))).toHaveLength(60);
    expect(titleFrom('   ')).toBe('New chat');
  });
});

describe('parseThread', () => {
  it('round-trips a stored thread exactly', () => {
    const thread = conversation();
    editUser(thread, activePath(thread)[2]!.id, 'Edited');
    thread.system = 'Be brief.';
    thread.model = 'b/other';
    const stored: unknown = JSON.parse(JSON.stringify(thread));
    expect(parseThread(stored)).toEqual(thread);
  });

  it('repairs broken links and selections, and drops orphans and unknown fields', () => {
    const thread = conversation();
    const raw = JSON.parse(JSON.stringify(thread)) as Record<string, unknown> & {
      nodes: Record<string, Record<string, unknown>>;
    };
    const [first] = thread.roots;
    // A child list that lost an entry, a dangling selection, an orphan and an injected field.
    raw.nodes[first!]!['children'] = [];
    raw.nodes[first!]!['selected'] = 'nope';
    raw.nodes['orphan'] = {
      id: 'orphan',
      parent: 'gone',
      role: 'user',
      content: 'x',
      children: [],
    };
    raw.nodes[first!]!['evil'] = '<script>';
    raw['selected'] = 'missing';
    const parsed = parseThread(raw)!;
    expect(parsed.nodes['orphan']).toBeUndefined();
    expect(parsed.nodes[first!]).not.toHaveProperty('evil');
    expect(activePath(parsed).map((node) => node.content)).toEqual([
      'Hi',
      'Hello',
      'Plan a trip',
      'Where to?',
    ]);
  });

  it('ends a reply that was still streaming as stopped', () => {
    const thread = conversation();
    regenerate(thread, leaf(thread)!.id, 'a/model');
    const parsed = parseThread(JSON.parse(JSON.stringify(thread)))!;
    expect(leaf(parsed)?.status).toBe('stopped');
  });

  it('keeps text attachments’ text and only the name, type and size of binaries', () => {
    const thread = createThread();
    appendUser(thread, 'Look', [
      { id: 'i', name: 'a.png', type: 'image/png', size: 9, kind: 'image', text: 'not kept' },
      { id: 't', name: 'notes.md', type: 'text/markdown', size: 4, kind: 'text', text: 'abcd' },
    ]);
    const parsed = parseThread(JSON.parse(JSON.stringify(thread)))!;
    expect(leaf(parsed)?.attachments).toEqual([
      { id: 'i', name: 'a.png', type: 'image/png', size: 9, kind: 'image' },
      { id: 't', name: 'notes.md', type: 'text/markdown', size: 4, kind: 'text', text: 'abcd' },
    ]);
  });

  it('migrates the linear form (the JSON export) into a tree', () => {
    const parsed = parseThread({
      title: 'Imported',
      system: 'Be kind.',
      messages: [
        { role: 'user', content: 'One' },
        { role: 'assistant', content: 'Two', model: 'a/model' },
        { role: 'tool', content: 'skipped' },
        { role: 'user', content: 'Three' },
      ],
    })!;
    expect(parsed.v).toBe(THREAD_VERSION);
    expect(parsed).toMatchObject({ title: 'Imported', named: true, system: 'Be kind.' });
    expect(activePath(parsed).map((node) => [node.role, node.content, node.model])).toEqual([
      ['user', 'One', undefined],
      ['assistant', 'Two', 'a/model'],
      ['user', 'Three', undefined],
    ]);
  });

  it('refuses newer versions and garbage, and never lets a __proto__ id through', () => {
    expect(parseThread({ v: THREAD_VERSION + 1, id: 'x', nodes: {} })).toBeNull();
    expect(parseThread(null)).toBeNull();
    expect(parseThread([])).toBeNull();
    expect(parseThread({ v: THREAD_VERSION, id: '__proto__', nodes: {} })).toBeNull();
    const parsed = parseThread(
      JSON.parse(
        `{"v":${THREAD_VERSION},"id":"t","nodes":{"__proto__":{"id":"__proto__","role":"user","content":"x","parent":null,"children":[]}},"roots":["__proto__"]}`,
      ),
    )!;
    expect(Object.keys(parsed.nodes)).toEqual([]);
    expect(Object.getPrototypeOf(parsed.nodes)).toBe(Object.prototype);
  });

  it('drops nodes that no root reaches', () => {
    const thread = conversation();
    const raw = JSON.parse(JSON.stringify(thread)) as { nodes: Record<string, unknown> };
    raw.nodes['a'] = { id: 'a', parent: 'b', role: 'user', content: 'a', children: ['b'] };
    raw.nodes['b'] = { id: 'b', parent: 'a', role: 'assistant', content: 'b', children: ['a'] };
    const parsed = parseThread(raw)!;
    expect(Object.keys(parsed.nodes)).toHaveLength(4);
  });
});
