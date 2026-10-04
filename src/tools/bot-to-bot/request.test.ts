import { describe, expect, it } from 'vitest';
import { type Conversation, createConversation, type Entry, type Speaker } from './conversation';
import {
  buildTurn,
  contextParts,
  framing,
  framingLine,
  mergeParts,
  outputTokens,
  trimCount,
  type TurnOptions,
} from './request';

const BOTS = {
  a: { name: 'Ada', persona: 'You are a careful mathematician.' },
  b: { name: 'Bo', persona: '' },
};

function conversationWith(...entries: Omit<Entry, 'id' | 'createdAt'>[]): Conversation {
  const conversation = createConversation({
    opener: 'Is zero even?',
    first: 'a',
    bots: {
      a: { name: 'Ada', model: 'm/a', persona: BOTS.a.persona },
      b: { name: 'Bo', model: 'm/b', persona: '' },
    },
  });
  entries.forEach((entry, index) => {
    conversation.entries.push({ id: `e${index}`, createdAt: index, ...entry });
  });
  return conversation;
}

const turn = (speaker: Speaker, content: string, status: Entry['status'] = 'done') => ({
  kind: 'bot' as const,
  speaker,
  name: speaker === 'a' ? 'Ada' : 'Bo',
  model: `m/${speaker}`,
  content,
  status,
});
const moderator = (content: string) => ({ kind: 'moderator' as const, content });

const options = (overrides: Partial<TurnOptions> = {}): TurnOptions => ({
  model: 'm/a',
  bots: BOTS,
  stopPhrase: '[END]',
  maxTokens: 500,
  contextLength: null,
  maxCompletionTokens: null,
  ...overrides,
});

describe('framing', () => {
  it('is the persona, then a line naming both bots and the stop phrase', () => {
    expect(framing('a', BOTS, '[END]')).toBe(
      `You are a careful mathematician.\n\n${framingLine('Ada', 'Bo', '[END]')}`,
    );
    const line = framingLine('Ada', 'Bo', '[END]');
    expect(line).toContain('You are Ada, in a conversation with Bo.');
    expect(line).toContain('[Moderator]');
    expect(line).toContain('end your message with [END]');
  });

  it('leaves the stop instruction out without a phrase, and the persona out when empty', () => {
    expect(framing('b', BOTS, '  ')).toBe(framingLine('Bo', 'Ada', ''));
    expect(framingLine('Bo', 'Ada', '')).not.toContain('end your message');
  });
});

describe('messages per speaker', () => {
  it('gives the first speaker the opener as marked user content', () => {
    const built = buildTurn(conversationWith(), 'a', options());
    expect(built.body.messages).toEqual([
      { role: 'system', content: framing('a', BOTS, '[END]') },
      { role: 'user', content: '[Moderator] Is zero even?' },
    ]);
    expect(built.body.max_tokens).toBe(500);
    expect(built.body.model).toBe('m/a');
  });

  it('shows each bot its own turns as assistant and the other’s as user, merged and labelled', () => {
    const conversation = conversationWith(turn('a', 'Yes, zero is even.'), turn('b', 'Agreed.'));
    const forB = buildTurn(conversation, 'b', options({ model: 'm/b' })).body.messages.slice(1);
    // The opener and Ada's turn are both user content: one message, every part labelled.
    expect(forB).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?\n\n[Ada] Yes, zero is even.' },
      { role: 'assistant', content: 'Agreed.' },
    ]);
    const forA = buildTurn(conversation, 'a', options()).body.messages.slice(1);
    expect(forA).toEqual([
      { role: 'user', content: '[Moderator] Is zero even?' },
      { role: 'assistant', content: 'Yes, zero is even.' },
      { role: 'user', content: 'Agreed.' },
    ]);
  });

  it('sends moderator messages to both bots, marked', () => {
    const conversation = conversationWith(
      turn('a', 'Yes.'),
      turn('b', 'Sure.'),
      moderator('Now discuss one.'),
    );
    const forA = buildTurn(conversation, 'a', options()).body.messages.slice(1);
    expect(forA.at(-1)).toEqual({
      role: 'user',
      content: '[Bo] Sure.\n\n[Moderator] Now discuss one.',
    });
    const forB = buildTurn(conversation, 'b', options()).body.messages.slice(1);
    expect(forB.at(-2)).toEqual({ role: 'assistant', content: 'Sure.' });
    expect(forB.at(-1)).toEqual({ role: 'user', content: '[Moderator] Now discuss one.' });
  });

  it('leaves out failed turns and end markers', () => {
    const conversation = conversationWith(turn('a', 'Yes.'), turn('b', '', 'error'), {
      kind: 'end',
      content: 'Stopped by you.',
      reason: 'stopped',
    });
    const parts = contextParts(conversation.entries, 'b');
    expect(parts.rest.map((part) => part.text)).toEqual(['Yes.']);
  });

  it('merges consecutive messages of one role', () => {
    const merged = mergeParts([
      { role: 'assistant', label: null, moderator: false, text: 'One.', tokens: 1 },
      { role: 'assistant', label: null, moderator: false, text: 'Two.', tokens: 1 },
      { role: 'user', label: '[Bo]', moderator: false, text: 'Three.', tokens: 1 },
    ]);
    expect(merged).toEqual([
      { role: 'assistant', content: 'One.\n\nTwo.' },
      { role: 'user', content: 'Three.' },
    ]);
  });
});

describe('trimming and max_tokens', () => {
  it('drops the oldest first and always keeps the last', () => {
    expect(trimCount([10, 10, 10], 25)).toBe(1);
    expect(trimCount([10, 10, 10], 5)).toBe(2);
    expect(trimCount([10, 10, 10], 100)).toBe(0);
  });

  it('keeps the framing and the opener and says how many turns went', () => {
    const long = 'word '.repeat(400); // ~500 tokens each
    const conversation = conversationWith(
      turn('a', `First ${long}`),
      turn('b', `Second ${long}`),
      turn('a', `Third ${long}`),
      turn('b', 'Fourth, short.'),
    );
    const built = buildTurn(conversation, 'a', options({ contextLength: 1300, maxTokens: 300 }));
    expect(built.trimmed).toBe(2);
    const messages = built.body.messages;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: '[Moderator] Is zero even?' });
    expect(
      messages
        .slice(2)
        .map((message) => (typeof message.content === 'string' ? message.content : '').slice(0, 6)),
    ).toEqual(['Third ', 'Fourth']);
    expect(built.tooLong).toBe(false);
  });

  it('clamps max_tokens to the model’s cap and to what the context leaves', () => {
    expect(
      buildTurn(conversationWith(), 'a', options({ maxCompletionTokens: 200 })).body.max_tokens,
    ).toBe(200);
    const tight = buildTurn(
      conversationWith(),
      'a',
      options({ contextLength: 120, maxTokens: 1000 }),
    );
    expect(tight.body.max_tokens).toBeLessThan(120);
    expect(tight.body.max_tokens).toBeGreaterThan(0);
    expect(
      buildTurn(conversationWith(), 'a', options({ maxTokens: null })).body.max_tokens,
    ).toBeUndefined();
    expect(outputTokens(null, null)).toBe(4096);
    expect(outputTokens(null, 1000)).toBe(1000);
  });

  it('says when even the last message does not fit', () => {
    const conversation = conversationWith(turn('b', 'x'.repeat(4000)));
    expect(
      buildTurn(conversation, 'a', options({ contextLength: 300, maxTokens: 50 })).tooLong,
    ).toBe(true);
  });
});
