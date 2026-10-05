import { describe, expect, it } from 'vitest';
import {
  type Conversation,
  CONVERSATION_VERSION,
  createConversation,
  dropFailedEmpty,
  editEntry,
  endedBy,
  type Entry,
  nextSpeaker,
  parseConversation,
  turnCount,
  undoEdit,
} from './conversation';

const BOTS = {
  a: { name: 'Ada', model: 'm/a', persona: '' },
  b: { name: 'Bo', model: 'm/b', persona: '' },
};

let counter = 0;
const bot = (speaker: 'a' | 'b', content: string, status: Entry['status'] = 'done'): Entry => ({
  id: `t${++counter}`,
  kind: 'bot',
  speaker,
  name: speaker === 'a' ? 'Ada' : 'Bo',
  model: `m/${speaker}`,
  content,
  status,
  createdAt: counter,
});

function make(first: 'a' | 'b', ...entries: Entry[]): Conversation {
  const conversation = createConversation({ opener: 'Hello', first, bots: BOTS });
  conversation.entries.push(...entries);
  return conversation;
}

describe('turn order and counts', () => {
  it('starts with the first speaker, then alternates', () => {
    expect(nextSpeaker(make('b'))).toBe('b');
    expect(nextSpeaker(make('a', bot('a', 'Hi')))).toBe('b');
    expect(nextSpeaker(make('a', bot('a', 'Hi'), bot('b', 'Yo')))).toBe('a');
  });

  it('ignores moderator messages, failed and streaming turns', () => {
    const conversation = make('a', bot('a', 'Hi'), bot('b', '', 'error'), {
      id: 'm',
      kind: 'moderator',
      content: 'Go on',
      createdAt: 9,
    });
    expect(nextSpeaker(conversation)).toBe('b');
    expect(turnCount(conversation)).toBe(1);
    conversation.entries.push(bot('b', 'part', 'streaming'));
    expect(turnCount(conversation)).toBe(1);
  });

  it('counts cut and stopped turns: they were said', () => {
    expect(turnCount(make('a', bot('a', 'Hi', 'cut'), bot('b', 'Yo', 'stopped')))).toBe(2);
  });

  it('knows when the last entry is an end marker', () => {
    const conversation = make('a', bot('a', 'Hi'));
    expect(endedBy(conversation)).toBeNull();
    conversation.entries.push({
      id: 'e',
      kind: 'end',
      reason: 'turns',
      content: 'x',
      createdAt: 1,
    });
    expect(endedBy(conversation)).toBe('turns');
  });

  it('drops failed turns that said nothing', () => {
    const conversation = make(
      'a',
      bot('a', 'Hi'),
      bot('b', '', 'error'),
      bot('b', 'half', 'error'),
    );
    expect(dropFailedEmpty(conversation)).toBe(true);
    expect(conversation.entries.map((entry) => entry.content)).toEqual(['Hello', 'Hi', 'half']);
  });
});

describe('editing', () => {
  it('replaces the text, removes what follows, and Undo brings it back', () => {
    const first = bot('a', 'Original');
    const conversation = make('a', first, bot('b', 'Reply'), bot('a', 'More'));
    const undo = editEntry(conversation, first.id, 'Edited');
    expect(undo?.removed.map((entry) => entry.content)).toEqual(['Reply', 'More']);
    expect(conversation.entries.map((entry) => entry.content)).toEqual(['Hello', 'Edited']);
    expect(conversation.entries[1]?.edited).toBe(true);
    expect(nextSpeaker(conversation)).toBe('b');

    expect(undoEdit(conversation, undo!)).toBe(true);
    expect(conversation.entries.map((entry) => entry.content)).toEqual([
      'Hello',
      'Original',
      'Reply',
      'More',
    ]);
    expect(conversation.entries[1]?.edited).toBeUndefined();
  });

  it('refuses Undo once the conversation went on', () => {
    const first = bot('a', 'Original');
    const conversation = make('a', first, bot('b', 'Reply'));
    const undo = editEntry(conversation, first.id, 'Edited')!;
    conversation.entries.push(bot('b', 'New reply'));
    expect(undoEdit(conversation, undo)).toBe(false);
    expect(conversation.entries.map((entry) => entry.content)).toEqual([
      'Hello',
      'Edited',
      'New reply',
    ]);
  });

  it('makes an edited cut turn a finished one, and edits the opener too', () => {
    const cut = bot('a', 'Half a sent', 'cut');
    const conversation = make('a', cut);
    editEntry(conversation, cut.id, 'A whole sentence.');
    expect(conversation.entries[1]?.status).toBe('done');
    const opener = conversation.entries[0]!;
    editEntry(conversation, opener.id, 'New topic');
    expect(conversation.entries).toHaveLength(1);
    expect(nextSpeaker(conversation)).toBe('a');
  });

  it('does not edit end markers or failed turns', () => {
    const failed = bot('b', '', 'error');
    const conversation = make('a', bot('a', 'Hi'), failed, {
      id: 'end',
      kind: 'end',
      reason: 'stopped',
      content: 'Stopped by you.',
      createdAt: 1,
    });
    expect(editEntry(conversation, failed.id, 'x')).toBeNull();
    expect(editEntry(conversation, 'end', 'x')).toBeNull();
    expect(editEntry(conversation, 'missing', 'x')).toBeNull();
  });
});

describe('parseConversation', () => {
  const stored = (): Conversation =>
    make('b', bot('b', 'Hi'), bot('a', 'Half', 'streaming'), bot('b', '', 'streaming'));

  it('round-trips a stored conversation through JSON', () => {
    const conversation = make('a', bot('a', 'Hi'));
    conversation.spentUsd = 0.01;
    conversation.elapsedMs = 5000;
    expect(parseConversation(JSON.parse(JSON.stringify(conversation)))).toEqual(conversation);
  });

  it('turns a turn left streaming into a stopped one, or drops it when it said nothing', () => {
    const parsed = parseConversation(JSON.parse(JSON.stringify(stored())))!;
    expect(parsed.entries.map((entry) => [entry.content, entry.status])).toEqual([
      ['Hello', undefined],
      ['Hi', 'done'],
      ['Half', 'stopped'],
    ]);
  });

  it('refuses what it cannot use and repairs what it can', () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation({ ...stored(), version: CONVERSATION_VERSION + 1 })).toBeNull();
    expect(parseConversation({ ...stored(), entries: [] })).toBeNull();
    const repaired = parseConversation({
      ...stored(),
      first: 'z',
      spentUsd: -4,
      entries: [
        { id: 'o', kind: 'opener', content: 'Topic', createdAt: 1 },
        { id: 'o', kind: 'moderator', content: 'duplicate id', createdAt: 1 },
        { id: 'x', kind: 'bot', content: 'no speaker', createdAt: 1 },
        { id: 'y', kind: 'end', content: 'no reason', createdAt: 1 },
        { id: 'z', kind: 'opener', content: 'second opener', createdAt: 1 },
        { id: 'w', kind: 'moderator', content: 'kept', createdAt: 1 },
      ],
    })!;
    expect(repaired.first).toBe('a');
    expect(repaired.spentUsd).toBe(0);
    expect(repaired.entries.map((entry) => entry.content)).toEqual(['Topic', 'kept']);
  });
});

describe('stored markers', () => {
  it('keeps the write id (how tabs tell versions apart) and a maybe-billed failure', () => {
    const conversation = make('a', {
      ...bot('a', '', 'error'),
      error: 'The connection dropped.',
      outcomeUnknown: true,
    });
    conversation.writeId = 'w-1';
    const parsed = parseConversation(JSON.parse(JSON.stringify(conversation)));
    expect(parsed).toEqual(conversation);
    expect(parsed?.entries[1]?.outcomeUnknown).toBe(true);
  });
});
