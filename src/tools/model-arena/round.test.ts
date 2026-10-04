import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../../core/types';
import {
  anonymize,
  type ArenaSettings,
  canVote,
  castVote,
  defaultContenders,
  entryAt,
  metricsOf,
  newRound,
  panelLabel,
  panelOf,
  reveal,
  type Round,
  settingsFrom,
  shuffle,
  summary,
} from './round';

const settings = (patch: Partial<ArenaSettings> = {}): ArenaSettings => ({
  models: ['a/one', 'b/two', 'c/three', 'd/four'],
  system: '',
  temperature: null,
  blind: true,
  pdfEngine: 'cloudflare-ai',
  ...patch,
});

/** A deterministic "random" that walks through `values`. */
const sequence = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

const round = (patch: Partial<ArenaSettings> = {}, random = sequence(0)): Round =>
  newRound({
    id: 'r1',
    prompt: 'Hi',
    settings: settings(patch),
    attachments: [],
    startedAt: 0,
    random,
  });

const answer = (r: Round, index: number, text = 'An answer'): void => {
  Object.assign(r.entries[index]!, { status: 'done', text });
};

describe('settings', () => {
  it('takes every valid field and keeps the base for the rest', () => {
    const base = settings({ models: ['x/a', 'x/b'] });
    expect(settingsFrom({}, base)).toEqual(base);
    expect(
      settingsFrom(
        {
          models: ['m/1', 'm/2', 'm/3'],
          system: 'Be brief.',
          temperature: 0.7,
          blind: false,
          pdfEngine: 'mistral-ocr',
          unknown: 1,
        },
        base,
      ),
    ).toEqual({
      models: ['m/1', 'm/2', 'm/3'],
      system: 'Be brief.',
      temperature: 0.7,
      blind: false,
      pdfEngine: 'mistral-ocr',
    });
    // Too few or too many contenders, blanks, an out-of-range temperature, an unknown engine: ignored.
    for (const models of [['m/1'], ['m/1', 'm/2', 'm/3', 'm/4', 'm/5'], ['m/1', ' '], 'm/1']) {
      expect(settingsFrom({ models }, base).models).toEqual(['x/a', 'x/b']);
    }
    expect(settingsFrom({ temperature: 3 }, base).temperature).toBeNull();
    expect(
      settingsFrom({ temperature: null }, settings({ temperature: 1 })).temperature,
    ).toBeNull();
    expect(settingsFrom({ pdfEngine: 'pdf-text' }, base).pdfEngine).toBe('cloudflare-ai');
  });
});

describe('default contenders', () => {
  const model = (id: string, isFree: boolean, created = 1): ModelInfo =>
    ({ id, author: id.split('/')[0]!, isFree, created }) as ModelInfo;
  const catalog = [
    model('qwen/big:free', true, 5),
    model('qwen/small:free', true, 9),
    model('meta/llama:free', true, 7),
    model('mistral/tiny:free', true, 8),
    model('openai/paid', false, 10),
  ];

  it('starts with the preferred free models, then the newest of other providers', () => {
    expect(defaultContenders(catalog, ['openai/paid', 'qwen/big:free'], [])).toEqual([
      'qwen/big:free',
      'mistral/tiny:free',
    ]);
    expect(defaultContenders(catalog, [], [], 4)).toEqual([
      'qwen/small:free',
      'mistral/tiny:free',
      'meta/llama:free',
      'qwen/big:free',
    ]);
  });

  it('falls back to known ids when the catalog has too few free models', () => {
    expect(defaultContenders([], ['x/free:free', null], ['openai/paid'])).toEqual([
      'x/free:free',
      'openai/paid',
    ]);
    expect(defaultContenders([model('a/only:free', true)], [], ['openai/paid'])).toEqual([
      'a/only:free',
      'openai/paid',
    ]);
  });
});

describe('blind rounds', () => {
  it('shuffles the panels (Fisher–Yates) only when blind', () => {
    expect(shuffle(4, sequence(0))).toEqual([1, 2, 3, 0]);
    expect(shuffle(4, sequence(0.99))).toEqual([0, 1, 2, 3]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 2400; i++) {
      const key = shuffle(3).join('');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(6); // every order happens

    const blind = round({}, sequence(0));
    expect(blind.order).toEqual([1, 2, 3, 0]);
    expect(blind.revealed).toBe(false);
    expect(entryAt(blind, 0).model).toBe('b/two');
    expect(panelOf(blind, 0)).toBe(3);
    expect(panelLabel(3)).toBe('Model D');

    const open = round({ blind: false });
    expect(open.order).toEqual([0, 1, 2, 3]);
    expect(open.revealed).toBe(true);
  });

  it('takes one vote once everyone settled and someone answered; voting reveals', () => {
    const r = round();
    expect(canVote(r)).toBe(false);
    answer(r, 0);
    answer(r, 1);
    r.entries[2]!.status = 'error';
    expect(canVote(r)).toBe(false); // d/four still waiting
    r.entries[3]!.status = 'stopped'; // stopped before any text: nothing to judge
    expect(canVote(r)).toBe(true);
    // Panel A shows entry 1 (answered); panel B shows entry 2 (failed) and cannot win.
    expect(castVote(r, { kind: 'winner', panel: 1 })).toBe(false);
    expect(castVote(r, { kind: 'winner', panel: 0 })).toBe(true);
    expect(r.revealed).toBe(true);
    expect(canVote(r)).toBe(false);
    expect(castVote(r, { kind: 'tie' })).toBe(false);
  });

  it('closes voting when a blind round is revealed by hand, not an open one', () => {
    const blind = round();
    blind.entries.forEach((_, i) => answer(blind, i));
    reveal(blind);
    expect(blind.revealed).toBe(true);
    expect(canVote(blind)).toBe(false);

    const open = round({ blind: false });
    open.entries.forEach((_, i) => answer(open, i));
    expect(canVote(open)).toBe(true);
    expect(castVote(open, { kind: 'bad' })).toBe(true);
  });

  it('keeps model names out of a blind error message', () => {
    expect(
      anonymize('qwen/big:free is not available (Qwen Big)', ['qwen/big:free', 'Qwen Big', '']),
    ).toBe('this model is not available (this model)');
  });
});

describe('metrics', () => {
  const usage = {
    promptTokens: 20,
    completionTokens: 100,
    costEstimated: false,
    costUnknown: false,
  };

  it('measures first token, total time, tokens per second and cost', () => {
    expect(
      metricsOf({
        model: 'a',
        status: 'done',
        text: 'x',
        startedAt: 1000,
        firstTokenAt: 1400,
        endedAt: 3400,
        usage: { ...usage, costUsd: 0.002 },
      }),
    ).toEqual({
      ttftMs: 400,
      totalMs: 2400,
      promptTokens: 20,
      completionTokens: 100,
      tokensPerSecond: 50,
      costUsd: 0.002,
      costEstimated: false,
      costUnknown: false,
    });
  });

  it('leaves out what it cannot know', () => {
    const streaming = metricsOf({ model: 'a', status: 'streaming', text: '', startedAt: 5 });
    expect(streaming).toMatchObject({ ttftMs: null, totalMs: null, tokensPerSecond: null });
    // Everything in one piece: no meaningful rate.
    const burst = metricsOf({
      model: 'a',
      status: 'done',
      text: 'x',
      startedAt: 0,
      firstTokenAt: 300,
      endedAt: 310,
      usage: { ...usage, costUsd: 0 },
    });
    expect(burst.tokensPerSecond).toBeNull();
    expect(
      metricsOf({
        model: 'a',
        status: 'error',
        text: '',
        usage: { ...usage, costUsd: 0, costUnknown: true },
      }),
    ).toMatchObject({ costUsd: null, costUnknown: true });
  });

  it('marks the fastest and the cheapest finished answers, in panel order', () => {
    const r = round({}, sequence(0.99)); // identity order
    const finish = (index: number, totalMs: number, costUsd: number, estimated = false): void => {
      Object.assign(r.entries[index]!, {
        status: 'done',
        text: 'x',
        startedAt: 0,
        firstTokenAt: 10,
        endedAt: totalMs,
        usage: { ...usage, costUsd, costEstimated: estimated },
      });
    };
    finish(0, 900, 0.003);
    finish(1, 500, 0.001);
    finish(2, 500, 0.0001, true); // estimated costs are not compared
    Object.assign(r.entries[3]!, { status: 'error', startedAt: 0, endedAt: 50 });
    const rows = summary(r);
    expect(rows.map((row) => row.fastest)).toEqual([false, true, true, false]);
    expect(rows.map((row) => row.cheapest)).toEqual([false, true, false, false]);
    expect(rows[3]!.metrics.totalMs).toBe(50); // a failure still shows how long it took

    // One finished answer compares with nothing.
    const single = round({ models: ['a/one', 'b/two'] }, sequence(0.99));
    Object.assign(single.entries[0]!, { status: 'done', text: 'x', startedAt: 0, endedAt: 9 });
    expect(summary(single).some((row) => row.fastest || row.cheapest)).toBe(false);
  });
});
