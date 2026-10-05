import { describe, expect, it } from 'vitest';
import { ApiError } from '../../core/errors';
import { failureText } from '../../ui/feedback/errors';
import { roundJson, roundMarkdown, voteLine } from './export';
import { newRound, type Round } from './round';

/** What a failed panel stores: the wording after the reveal, and the blind one. */
const failure = (error: unknown) => ({
  shown: failureText(error),
  blind: failureText(error, { blind: true }),
});

function sampleRound(): Round {
  const round = newRound({
    id: 'r',
    prompt: 'Name a prime.',
    settings: {
      models: ['a/one', 'b/two'],
      system: 'Be brief.',
      temperature: 0.2,
      maxTokens: null,
      blind: true,
      pdfEngine: 'cloudflare-ai',
    },
    attachments: [{ name: 'notes.md', type: 'text/markdown', size: 9 }],
    startedAt: Date.UTC(2026, 9, 4, 12),
    random: () => 0, // panels: B/A → order [1, 0]
  });
  Object.assign(round.entries[0]!, {
    status: 'done',
    text: '7',
    startedAt: 0,
    firstTokenAt: 250,
    endedAt: 1250,
    usage: {
      promptTokens: 10,
      completionTokens: 50,
      costUsd: 0.0012,
      costEstimated: false,
      costUnknown: false,
    },
  });
  Object.assign(round.entries[1]!, {
    status: 'error',
    failure: failure(new ApiError('Rate limited.', 400)),
    startedAt: 0,
    endedAt: 300,
  });
  round.vote = { kind: 'winner', panel: 1 };
  round.revealed = true;
  return round;
}

const name = (id: string): string => (id === 'a/one' ? 'One' : 'Two');

describe('round export', () => {
  it('closes a code fence an answer left open, so the rest of the export stays readable', () => {
    const round = sampleRound();
    Object.assign(round.entries[0]!, {
      status: 'stopped',
      text: 'Here:\n\n````ts\nconst a = 1;\n```\nstill inside',
    });
    Object.assign(round.entries[1]!, {
      status: 'done',
      text: 'Fine\n~~~\ncode',
      finishReason: 'length',
    });
    const markdown = roundMarkdown(round, name);
    expect(markdown).toContain('```\nstill inside\n````\n\n_(stopped)_');
    expect(markdown).toContain('~~~\ncode\n~~~\n\n_(cut off at the length limit)_');
    // Every fence is closed: the vote is not swallowed into a code block.
    const fences = markdown.split('\n').filter((line) => /^(`{3,}|~{3,})/.test(line));
    expect(fences).toHaveLength(5); // ```` ``` ```` (one closed by us), ~~~ ~~~
    expect(markdown.endsWith('## Vote\n\nModel B (One) won.\n')).toBe(true);
  });

  it('words costs as everywhere else: Free on a free model, Unknown, an estimate with ≈', () => {
    const round = sampleRound();
    const usage = (patch: Record<string, unknown>) => ({
      promptTokens: 10,
      completionTokens: 50,
      costUsd: 0,
      costEstimated: false,
      costUnknown: false,
      ...patch,
    });
    round.entries[0]!.usage = usage({});
    const free = roundMarkdown(round, name, (id) => id === 'a/one');
    expect(free).toContain('| 250 ms | 1.3 s | 50 | 50.0 | Free |');
    round.entries[0]!.usage = usage({ costUnknown: true });
    expect(roundMarkdown(round, name)).toContain('| 50.0 | Unknown |');
    round.entries[0]!.usage = usage({ costUsd: 0.0012, costEstimated: true });
    expect(roundMarkdown(round, name)).toContain('| 50.0 | ≈ $0.0012 |');
  });

  it('marks an answer cut off at the length limit in JSON', () => {
    const round = sampleRound();
    round.entries[0]!.finishReason = 'length';
    expect(roundJson(round).contenders[1]).toMatchObject({ model: 'a/one', cutOff: true });
    expect(roundJson(round).contenders[0]).toMatchObject({ model: 'b/two', cutOff: false });
  });

  it('writes Markdown in panel order with metrics and the vote', () => {
    expect(roundMarkdown(sampleRound(), name)).toBe(
      [
        '# Model arena round',
        '## Prompt',
        'Name a prime.',
        '_Attachments: notes.md_',
        '**System prompt:**\n\nBe brief.',
        '**Temperature:** 0.2',
        '## Model A: Two (`b/two`)',
        '_(failed: Rate limited.)_',
        '| First token | Total | Output tokens | Tokens/s | Cost |\n| --- | --- | --- | --- | --- |\n| — | 300 ms | — | — | — |',
        '## Model B: One (`a/one`)',
        '7',
        '| First token | Total | Output tokens | Tokens/s | Cost |\n| --- | --- | --- | --- | --- |\n| 250 ms | 1.3 s | 50 | 50.0 | $0.0012 |',
        '## Vote',
        'Model B (One) won.',
      ].join('\n\n') + '\n',
    );
  });

  it('writes JSON with each contender, its metrics and the vote', () => {
    const json = roundJson(sampleRound());
    expect(json).toMatchObject({
      startedAt: '2026-10-04T12:00:00.000Z',
      prompt: 'Name a prime.',
      system: 'Be brief.',
      temperature: 0.2,
      blind: true,
      attachments: [{ name: 'notes.md', type: 'text/markdown', size: 9 }],
      vote: { kind: 'winner', panel: 'B', model: 'a/one' },
    });
    expect(json.contenders.map((c) => [c.panel, c.model, c.status])).toEqual([
      ['A', 'b/two', 'error'],
      ['B', 'a/one', 'done'],
    ]);
    expect(json.contenders[1]?.metrics).toMatchObject({
      ttftMs: 250,
      totalMs: 1250,
      costUsd: 0.0012,
    });
    expect(json.contenders[0]?.error).toBe('Rate limited.');
  });

  it('says how the round ended', () => {
    const round = sampleRound();
    round.vote = { kind: 'tie' };
    expect(voteLine(round, name)).toBe('Tie.');
    expect(roundJson(round).vote).toEqual({ kind: 'tie' });
    round.vote = { kind: 'bad' };
    expect(voteLine(round, name)).toBe('All bad.');
    expect(roundJson(round).vote).toEqual({ kind: 'all-bad' });
    round.vote = null;
    expect(voteLine(round, name)).toBe('Revealed without a vote.');
    round.settings.blind = false;
    expect(voteLine(round, name)).toBe('No vote.');
  });
});
