import { describe, expect, it } from 'vitest';
import { queryWords } from '../../ui/shell/palette-search';
import {
  activePath,
  addNode,
  appendUser,
  attachmentIds,
  baseOf,
  createThread,
  deleteBranch,
  editUser,
  leaf,
  matchesQuery,
  mergeInto,
  parseThread,
  pathTo,
  regenerate,
  restoreBranch,
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
    expect(removed).toMatchObject({ parent: trip.parent, index: 1, selected: true });
    expect(removed?.nodes.map((node) => node.id)).toEqual([edited.id]);
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?']);

    const removedAll = deleteBranch(thread, activePath(thread)[1]!.id);
    expect(removedAll?.nodes.map((node) => node.content)).toEqual([
      'Hello',
      'Plan a trip',
      'Where to?',
    ]);
    expect(texts(thread)).toEqual(['Hi']);
    expect(Object.keys(thread.nodes)).toHaveLength(1);
    expect(deleteBranch(thread, 'nope')).toBeNull();
  });

  it('restores just the deleted branch into the thread as it is now', () => {
    const thread = conversation();
    const [, hello, trip] = activePath(thread);
    const removed = deleteBranch(thread, trip!.id)!;
    // Meanwhile the conversation went on from the same point.
    const later = appendUser(thread, 'Something else');
    expect(later.parent).toBe(hello!.id);

    expect(restoreBranch(thread, removed)).toBe(true);
    expect(texts(thread)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?']);
    expect(siblingInfo(thread, trip!.id)).toEqual({ index: 0, count: 2 });
    expect(thread.nodes[later.id]?.content).toBe('Something else');
  });

  it('refuses to restore a branch that is back already or whose parent is gone', () => {
    const thread = conversation();
    const [, hello, trip] = activePath(thread);
    const removed = deleteBranch(thread, trip!.id)!;
    expect(restoreBranch(thread, removed)).toBe(true);
    expect(restoreBranch(thread, removed)).toBe(false);

    const again = deleteBranch(thread, trip!.id)!;
    deleteBranch(thread, hello!.id);
    const before = JSON.stringify(thread);
    expect(restoreBranch(thread, again)).toBe(false);
    expect(JSON.stringify(thread)).toBe(before);
  });

  it('lists the attachment ids of every branch', () => {
    const thread = createThread();
    const ref = { id: 'a1', name: 'x.png', type: 'image/png', size: 3, kind: 'image' as const };
    const first = appendUser(thread, 'One', [ref]);
    editUser(thread, first.id, 'Two');
    appendUser(thread, 'Three', [{ ...ref, id: 'a2' }]);
    expect([...attachmentIds(thread)].sort()).toEqual(['a1', 'a2']);
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

  it('searches titles and every message, ignoring case and accents', () => {
    const thread = conversation();
    const matches = (query: string): boolean => matchesQuery(thread, queryWords(query));
    expect(matches('where')).toBe(true);
    expect(matches('  HI ')).toBe(true);
    expect(matches('trip where')).toBe(true);
    expect(matches('rome')).toBe(false);
    expect(matches('')).toBe(true);
    appendUser(thread, 'Café in Zürich?');
    expect(matches('cafe zurich')).toBe(true);
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

describe('merging another tab’s changes', () => {
  /** What another tab reads back from storage. */
  const copy = (thread: Thread): Thread => parseThread(JSON.parse(JSON.stringify(thread)))!;

  it('keeps what both tabs added, and the title and system prompt each side changed', () => {
    const stored = conversation();
    stored.rev = 3;
    const ours = copy(stored);
    const base = baseOf(ours);
    const theirs = copy(stored);

    const ourQuestion = appendUser(ours, 'Ours');
    addNode(ours, ourQuestion.id, { role: 'assistant', content: 'Our answer', status: 'done' });
    ours.system = 'Be brief.';
    const trip = activePath(theirs)[2]!;
    const theirEdit = editUser(theirs, trip.id, 'Theirs');
    theirs.title = 'Renamed there';
    theirs.named = true;
    theirs.rev = 4;

    mergeInto(ours, base, theirs);
    expect(texts(ours)).toEqual(['Hi', 'Hello', 'Plan a trip', 'Where to?', 'Ours', 'Our answer']);
    expect(siblingInfo(ours, theirEdit.id)).toEqual({ index: 1, count: 2 });
    expect(ours).toMatchObject({
      title: 'Renamed there',
      named: true,
      system: 'Be brief.',
      rev: 4,
    });
  });

  it('keeps deletions on either side deleted', () => {
    const stored = conversation();
    const ours = copy(stored);
    const base = baseOf(ours);
    const theirs = copy(stored);
    const [, hello, trip] = activePath(theirs);
    // They deleted the trip; we deleted nothing but answered "Hello" again.
    deleteBranch(theirs, trip!.id);
    theirs.rev = 1;
    regenerate(ours, ours.nodes[hello!.id]!.id, 'a/model');
    mergeInto(ours, base, theirs);
    expect(ours.nodes[trip!.id]).toBeUndefined();
    expect(siblingInfo(ours, hello!.id).count).toBe(2);

    // Now we delete "Hi" and its subtree; they still have it and added a message under it.
    const base2 = baseOf(ours);
    const theirs2 = copy(ours);
    deleteBranch(ours, activePath(ours)[0]!.id);
    appendUser(theirs2, 'Added there');
    theirs2.rev = 2;
    mergeInto(ours, base2, theirs2);
    expect(Object.keys(ours.nodes)).toEqual([]);
  });

  it('keeps the most final version of a reply, and never touches one streaming here', () => {
    const stored = conversation();
    const question = appendUser(stored, 'Long question');
    const reply = addNode(stored, question.id, {
      role: 'assistant',
      content: '',
      status: 'streaming',
    });
    // Our tab stored the reply as it started; the other tab read it (as stopped) and continued after it.
    const ours = copy(stored);
    ours.nodes[reply.id]!.status = 'streaming';
    const base = baseOf(ours);
    const theirs = copy(stored);
    expect(theirs.nodes[reply.id]?.status).toBe('stopped');
    appendUser(theirs, 'Follow-up there');
    theirs.rev = 1;

    mergeInto(ours, base, theirs);
    expect(ours.nodes[reply.id]).toMatchObject({ status: 'streaming', content: '' });

    // Finished here: our answer stays; finished there (and stopped here): theirs comes in.
    ours.nodes[reply.id]!.status = 'done';
    ours.nodes[reply.id]!.content = 'Full answer';
    mergeInto(ours, baseOf(ours), copy(theirs));
    expect(ours.nodes[reply.id]).toMatchObject({ status: 'done', content: 'Full answer' });

    const there = copy(ours);
    there.nodes[reply.id]!.content = 'Full answer, revised there';
    there.rev = 9;
    ours.nodes[reply.id]!.status = 'stopped';
    mergeInto(ours, baseOf(ours), there);
    expect(ours.nodes[reply.id]).toMatchObject({
      status: 'done',
      content: 'Full answer, revised there',
    });
    expect(ours.rev).toBe(9);
  });

  it('stores the revision and the parser text of PDFs', () => {
    const thread = createThread({ id: 't' });
    thread.rev = 7;
    appendUser(thread, 'Read this', [
      { id: 'p', name: 'a.pdf', type: 'application/pdf', size: 9, kind: 'pdf', parsed: 'Page 1' },
    ]);
    const parsed = copy(thread);
    expect(parsed.rev).toBe(7);
    expect(activePath(parsed)[0]?.attachments?.[0]?.parsed).toBe('Page 1');
  });
});
