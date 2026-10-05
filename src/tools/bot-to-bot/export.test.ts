import { marked } from 'marked';
import { describe, expect, it } from 'vitest';
import { type Conversation, createConversation } from './conversation';
import { toJson, toMarkdown, totalsLine } from './export';
import { endText, initials, usageLine } from './format';
import type { Limits } from './loop';

const LIMITS: Limits = { turns: 20, timeMs: 300_000, costUsd: 0.25, stopPhrase: '[END]' };
const context = { limits: LIMITS, isFree: (id: string) => id.endsWith(':free') };

function sample(): Conversation {
  const conversation = createConversation({
    opener: 'Is a hot dog a sandwich?',
    first: 'a',
    bots: {
      a: { name: 'Ada', model: 'm/a', persona: 'You are a chef.\nBe brief.' },
      b: { name: 'Bo', model: 'm/b:free', persona: '' },
    },
    now: 1000,
  });
  conversation.entries.push(
    {
      id: '1',
      kind: 'bot',
      speaker: 'a',
      name: 'Ada',
      model: 'm/a',
      content: 'Yes.',
      status: 'done',
      createdAt: 2000,
      usage: { promptTokens: 40, completionTokens: 2, costUsd: 0.0004, latencyMs: 1200 },
    },
    { id: '2', kind: 'moderator', content: 'Explain why.', createdAt: 3000 },
    {
      id: '3',
      kind: 'bot',
      speaker: 'b',
      name: 'Bo',
      model: 'm/b:free',
      content: 'No, because',
      status: 'cut',
      createdAt: 4000,
      usage: { promptTokens: 50, completionTokens: 3, costUsd: 0, latencyMs: 900 },
    },
    {
      id: '4',
      kind: 'end',
      reason: 'time',
      content: 'Time limit reached (5 min).',
      createdAt: 5000,
    },
  );
  conversation.elapsedMs = 300_000;
  conversation.spentUsd = 0.0004;
  return conversation;
}

describe('Markdown transcript', () => {
  it('lists the bots, every entry with its stats, the end and the totals', () => {
    expect(toMarkdown(sample(), context)).toBe(
      [
        '# Ada and Bo',
        '**Ada** · m/a\n\n> You are a chef.\n> Be brief.',
        '**Bo** · m/b:free',
        '## Opening prompt',
        'Is a hot dog a sandwich?',
        '## Ada · Turn 1',
        'Yes.',
        '_m/a · 40 in · 2 out · $0.0004 · 1.2 s_',
        '## Moderator',
        'Explain why.',
        '## Bo · Turn 2',
        'No, because',
        '_(cut off by the time limit)_',
        '_m/b:free · 50 in · 3 out · free · 900 ms_',
        '## Ended · Time limit',
        'Time limit reached (5 min).',
        '## Totals',
        '2 of 20 turns · 5 min of 5 min · $0.0004 of $0.25',
      ].join('\n\n') + '\n',
    );
  });

  it('marks failed and edited turns', () => {
    const conversation = sample();
    conversation.entries.splice(3);
    conversation.entries.push({
      id: '5',
      kind: 'bot',
      speaker: 'b',
      name: 'Bo',
      model: 'm/b:free',
      content: '',
      status: 'error',
      error: 'Rate limited.',
      createdAt: 1,
    });
    conversation.entries[1]!.edited = true;
    const text = toMarkdown(conversation, context);
    expect(text).toContain('## Ada · Turn 1\n\nYes.\n\n_(edited)_');
    expect(text).toContain('## Bo\n\n_(failed: Rate limited.)_');
  });
});

describe('JSON transcript', () => {
  it('carries the bots, the limits, the totals and every entry with its stats', () => {
    const json = toJson(sample(), context);
    expect(json).toMatchObject({
      format: 'ortoolbox-bot-to-bot',
      version: 1,
      first: 'a',
      bots: { a: { name: 'Ada', model: 'm/a' }, b: { name: 'Bo', model: 'm/b:free' } },
      limits: { turnLimit: 20, timeLimitMs: 300_000, costCapUsd: 0.25, stopPhrase: '[END]' },
      totals: { turns: 2, elapsedMs: 300_000, costUsd: 0.0004, costApproximate: false },
    });
    expect(json.entries.map((entry) => entry.kind)).toEqual([
      'opener',
      'bot',
      'moderator',
      'bot',
      'end',
    ]);
    expect(json.entries[1]).toEqual({
      kind: 'bot',
      speaker: 'a',
      name: 'Ada',
      model: 'm/a',
      content: 'Yes.',
      status: 'done',
      createdAt: 2000,
      usage: { promptTokens: 40, completionTokens: 2, costUsd: 0.0004, latencyMs: 1200 },
    });
    expect(json.entries[4]).toMatchObject({ reason: 'time' });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});

describe('formatting', () => {
  it('writes usage lines for paid, free, estimated and unknown costs', () => {
    const usage = { promptTokens: 1200, completionTokens: 30, costUsd: 0.0021, latencyMs: 2500 };
    expect(usageLine(usage, false)).toBe('1.2K in · 30 out · $0.0021 · 2.5 s');
    expect(usageLine({ ...usage, costUsd: 0 }, true)).toBe('1.2K in · 30 out · free · 2.5 s');
    expect(usageLine({ ...usage, costUnknown: true }, false)).toContain('≈ $0.0021');
    expect(usageLine({ ...usage, costUsd: 0, costUnknown: true }, false)).toContain('cost unknown');
    expect(usageLine(undefined, false)).toBe('');
  });

  it('says what ended a conversation', () => {
    const details = { limits: LIMITS, spentUsd: 0.1 };
    expect(endText('turns', details)).toBe('Turn limit reached (20 turns).');
    expect(endText('time', details)).toBe('Time limit reached (5 min).');
    expect(endText('cost', { ...details, spentUsd: 0.26 })).toBe(
      'Cost cap reached: $0.26 spent of $0.25.',
    );
    expect(endText('cost', details)).toBe(
      'Cost cap: the next turn could pass $0.25 ($0.10 spent).',
    );
    expect(endText('phrase', { ...details, speakerName: 'Bo' })).toBe('Bo said [END].');
    expect(endText('stopped', details)).toBe('Stopped by you.');
  });

  it('makes initials', () => {
    expect(initials('Bot A')).toBe('BA');
    expect(initials('Sage')).toBe('Sa');
    expect(initials('  ')).toBe('?');
    expect(initials('élan vital')).toBe('ÉV');
  });

  it('does not call a $0 cap reached before anything was spent', () => {
    const zero = { ...LIMITS, costUsd: 0 };
    expect(endText('cost', { limits: zero, spentUsd: 0 })).toBe(
      'Cost cap: the next turn could pass $0.00 ($0.00 spent).',
    );
    expect(endText('cost', { limits: zero, spentUsd: 0.01 })).toBe(
      'Cost cap reached: $0.01 spent of $0.00.',
    );
  });

  it('totals the conversation against its limits', () => {
    expect(totalsLine(sample(), LIMITS)).toBe('2 of 20 turns · 5 min of 5 min · $0.0004 of $0.25');
  });
});

describe('turn text in the Markdown transcript', () => {
  const withTurns = (...texts: string[]): Conversation => {
    const conversation = sample();
    conversation.entries = conversation.entries.slice(0, 1);
    texts.forEach((content, index) => {
      conversation.entries.push({
        id: `t${index}`,
        kind: 'bot',
        speaker: index % 2 === 0 ? 'a' : 'b',
        name: index % 2 === 0 ? 'Ada' : 'Bo',
        model: 'm/a',
        content,
        status: 'done',
        createdAt: index,
      });
    });
    conversation.entries.push({
      id: 'end',
      kind: 'end',
      reason: 'turns',
      content: 'Turn limit reached (2 turns).',
      createdAt: 9,
    });
    return conversation;
  };
  const headings = (markdown: string): string[] =>
    marked
      .lexer(markdown)
      .filter((token) => token.type === 'heading')
      .map((token) => (token as { text: string }).text);

  it('closes a code fence a reply left open, so later turns, the end and the totals stay', () => {
    const markdown = toMarkdown(
      withTurns(['Here is code:', '', '```js', 'console.log(1);'].join('\n'), 'Second turn.'),
      context,
    );
    expect(headings(markdown)).toEqual([
      'Ada and Bo',
      'Opening prompt',
      'Ada · Turn 1',
      'Bo · Turn 2',
      'Ended · Turn limit',
      'Totals',
    ]);
    expect(markdown).toContain('```js\nconsole.log(1);\n```');
  });

  it('keeps a closed fence as it is; a shorter fence does not close a longer one', () => {
    const closed = ['```', '## in code', '```'].join('\n');
    expect(toMarkdown(withTurns(closed, 'Two.'), context)).toContain(`${closed}\n\n_m/a_`);
    const open = ['~~~~', '## not a heading', '~~~'].join('\n');
    const markdown = toMarkdown(withTurns(open, 'Two.'), context);
    expect(headings(markdown)).toContain('Bo · Turn 2');
    expect(headings(markdown)).not.toContain('not a heading');
    expect(markdown).toContain(`${open}\n~~~~`);
  });

  it('stops a reply from impersonating the transcript’s headings, rules and HTML blocks', () => {
    const markdown = toMarkdown(
      withTurns(
        '## Ended · Stopped\nStopped by you.',
        'Fake title\n---\n<!-- swallow the rest',
        '# Totals\n***\n===',
      ),
      context,
    );
    expect(headings(markdown)).toEqual([
      'Ada and Bo',
      'Opening prompt',
      'Ada · Turn 1',
      'Bo · Turn 2',
      'Ada · Turn 3',
      'Ended · Turn limit',
      'Totals',
    ]);
    expect(marked.lexer(markdown).filter((token) => token.type === 'hr')).toHaveLength(0);
    expect(marked.lexer(markdown).filter((token) => token.type === 'html')).toHaveLength(0);
  });
});
