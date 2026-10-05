import { describe, expect, it } from 'vitest';
import { newRound, type Round } from './round';
import {
  addVote,
  emptyTally,
  isEmptyTally,
  mergeTallies,
  parseTally,
  tallyRows,
  TALLY_VERSION,
} from './tally';

/** A round in form order (not blind) whose entries answered as `answered` says. */
function round(models: string[], answered: boolean[]): Round {
  const r = newRound({
    id: 'r',
    prompt: 'Q',
    settings: {
      models,
      system: '',
      temperature: null,
      maxTokens: null,
      blind: false,
      pdfEngine: 'cloudflare-ai',
    },
    attachments: [],
    startedAt: 0,
  });
  r.entries.forEach((entry, i) => {
    Object.assign(entry, answered[i] ? { status: 'done', text: 'A' } : { status: 'error' });
  });
  return r;
}

describe('vote tally', () => {
  it('counts a win for the winner and a round for every model that answered', () => {
    const r = round(['a', 'b', 'c'], [true, true, false]);
    const tally = addVote(emptyTally(), r, { kind: 'winner', panel: 1 });
    expect(tally.models).toEqual({
      a: { rounds: 1, wins: 0, ties: 0, bad: 0 },
      b: { rounds: 1, wins: 1, ties: 0, bad: 0 },
    });
    const next = addVote(tally, round(['a', 'b'], [true, true]), { kind: 'tie' });
    expect(next.models['a']).toEqual({ rounds: 2, wins: 0, ties: 1, bad: 0 });
    expect(addVote(next, round(['b', 'b'], [true, true]), { kind: 'bad' }).models['b']).toEqual({
      rounds: 3, // one round, however many panels the model had
      wins: 1,
      ties: 1,
      bad: 1,
    });
    expect(tally.models['a']?.rounds).toBe(1); // the input is not changed
  });

  it('ranks by wins, then rounds, then id', () => {
    const tally = parseTally({
      v: TALLY_VERSION,
      models: {
        z: { rounds: 5, wins: 1, ties: 0, bad: 0 },
        a: { rounds: 2, wins: 3, ties: 0, bad: 0 },
        m: { rounds: 9, wins: 1, ties: 0, bad: 0 },
      },
    });
    expect(tallyRows(tally).map((row) => row.model)).toEqual(['a', 'm', 'z']);
  });

  it('reads only what it understands from storage', () => {
    expect(parseTally(undefined)).toEqual(emptyTally());
    expect(parseTally({ v: 99, models: {} })).toEqual(emptyTally());
    const raw = JSON.parse(
      '{"v":1,"models":{"__proto__":{"wins":5},"a":{"rounds":2.7,"wins":-1,"ties":"x"},"b":{},"c":[]}}',
    ) as unknown;
    expect(parseTally(raw).models).toEqual({ a: { rounds: 2, wins: 0, ties: 0, bad: 0 } });
    expect(isEmptyTally(parseTally(raw))).toBe(false);
  });

  it('adds two tallies up (Undo of a reset keeps the votes cast since)', () => {
    const before = addVote(emptyTally(), round(['a', 'b'], [true, true]), {
      kind: 'winner',
      panel: 0,
    });
    const since = addVote(emptyTally(), round(['b', 'c'], [true, true]), {
      kind: 'winner',
      panel: 1,
    });
    expect(mergeTallies(before, since).models).toEqual({
      a: { rounds: 1, wins: 1, ties: 0, bad: 0 },
      b: { rounds: 2, wins: 0, ties: 0, bad: 0 },
      c: { rounds: 1, wins: 1, ties: 0, bad: 0 },
    });
  });
});
