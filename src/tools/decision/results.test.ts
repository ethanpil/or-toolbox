import { describe, expect, it } from 'vitest';
import documentedResponse from '../../../tests/fixtures/openrouter/decisions-response.documented.json';
import jevResponse from '../../../tests/fixtures/openrouter/decisions-response-jev.recorded.json';
import mercuryResponse from '../../../tests/fixtures/openrouter/decisions-response.recorded.json';
import type { DecisionRequest, DecisionResponse } from '../../core/api/types';
import {
  exportDocument,
  formatPercent,
  formatScore,
  parseDecision,
  readAnswer,
  resultVerdict,
  verdictOf,
} from './results';
import { blankQuestion, type QuestionDef } from './schema';
import { templateQuestions } from './templates';

const triage = (): QuestionDef[] => templateQuestions('ticket-triage')!;
const [isBug, team, urgency] = triage() as [QuestionDef, QuestionDef, QuestionDef];

const noulQuestion = { ...blankQuestion(), name: 'Q', id: 'q', type: 'noul' as const };
const choiceQuestion = (): QuestionDef => ({ ...team });
const scoreQuestion = (): QuestionDef => ({ ...urgency });

describe('reading the tutorial answers', () => {
  it('reads the documented Jev response (rounded numbers, confidence on choice and score)', () => {
    const decision = parseDecision(documentedResponse, triage());
    expect(decision.model).toBe('typesafe/jev-1.13-20260917');
    expect(decision.provider).toBe('TypeSafe');
    expect(decision.costUsd).toBe(0.000019992);
    expect(decision.inputTokens).toBe(476);

    const [bug, owner, urgent] = decision.results;
    expect(bug).toMatchObject({ kind: 'noul', id: 'is_bug', yes: 0.96, basis: 'sides' });
    expect(bug!.kind === 'noul' && bug!.confidence).toBe(0.96);

    expect(owner).toMatchObject({
      kind: 'choice',
      choice: 'payments',
      confidence: 0.67,
      basis: 'reported',
    });
    expect(owner!.kind === 'choice' && owner!.bars).toEqual([
      { name: 'payments', probability: 0.78, chosen: true },
      { name: 'frontend', probability: 0.22, chosen: false },
      { name: 'account', probability: 0, chosen: false },
    ]);

    expect(urgent).toMatchObject({
      kind: 'score',
      score: 1.99,
      position: 1.99,
      nearest: 2,
      confidence: 0.99,
      basis: 'reported',
    });
    expect(urgent!.kind === 'score' && urgent!.levels).toEqual([
      { index: 0, text: 'Can wait for the next release', probability: 0 },
      { index: 1, text: 'Should be fixed this week', probability: 0 },
      { index: 2, text: 'Blocking revenue right now', probability: 1 },
    ]);
  });

  it('reads the recorded Jev answer, whose key order differs and whose options come unsorted', () => {
    const decision = parseDecision(jevResponse, triage());
    const owner = decision.results[1]!;
    // Highest first, whatever order the model listed them in (frontend came first in the body).
    expect(owner.kind === 'choice' && owner.bars.map((bar) => bar.name)).toEqual([
      'payments',
      'frontend',
      'account',
    ]);
    expect(owner.kind === 'choice' && owner.confidence).toBe(0.6);
    expect(decision.costUsd).toBe(0.000019992);
  });

  it('reads Mercury Decide, whose numbers are long unrounded floats', () => {
    const decision = parseDecision(mercuryResponse, triage());
    expect(decision.model).toBe('inception/mercury-decide-20260930');
    expect(decision.costUsd).toBe(0);
    const [bug, owner, urgent] = decision.results;
    expect(bug).toMatchObject({ kind: 'noul', yes: 0.9999251537754908 });
    expect(owner).toMatchObject({ kind: 'choice', confidence: 0.8390598148076417 });
    expect(urgent).toMatchObject({ kind: 'score', score: 1.9987874876411762, nearest: 2 });
    // Shown cut to a tenth of a percent, never rounded up to a claim the number does not make.
    expect(formatPercent(0.9999251537754908)).toBe('99.9%');
    expect(formatPercent(0.8390598148076417)).toBe('83.9%');
    expect(formatPercent(0.0006748653431688572)).toBe('<0.1%');
    expect(formatScore(1.9987874876411762)).toBe('2');
  });
});

describe('confidence', () => {
  it('is the stronger side for Yes/No, which has none on the wire', () => {
    expect(readAnswer(noulQuestion, { type: 'noul', noul: 0.96 })).toMatchObject({
      confidence: 0.96,
    });
    expect(readAnswer(noulQuestion, { type: 'noul', noul: 0.1 })).toMatchObject({
      confidence: 0.9,
      yes: 0.1,
    });
    expect(readAnswer(noulQuestion, { type: 'noul', noul: 0.5 })).toMatchObject({
      confidence: 0.5,
    });
    // Whatever the model sends as confidence on a yes/no answer is not used.
    expect(readAnswer(noulQuestion, { type: 'noul', noul: 0.6, confidence: 0.99 })).toMatchObject({
      confidence: 0.6,
    });
  });

  it('is the API confidence for Choice and Score when there is one', () => {
    const answer = {
      type: 'choice',
      choice: 'payments',
      confidence: 0.5,
      probabilities: { payments: 0.9, frontend: 0.1 },
    };
    expect(readAnswer(choiceQuestion(), answer)).toMatchObject({
      confidence: 0.5,
      basis: 'reported',
    });
  });

  it('falls back to the top probability when the API sends none', () => {
    const choice = readAnswer(choiceQuestion(), {
      type: 'choice',
      choice: 'payments',
      probabilities: { payments: 0.78, frontend: 0.22, account: 0 },
    });
    expect(choice).toMatchObject({ confidence: 0.78, basis: 'top-probability' });
    const score = readAnswer(scoreQuestion(), {
      type: 'score',
      score: 0.4,
      probabilities: { '0': 0.6, '1': 0.4, '2': 0 },
    });
    expect(score).toMatchObject({ confidence: 0.6, basis: 'top-probability' });
  });

  it('has none when the answer carries nothing to go by', () => {
    const choice = readAnswer(choiceQuestion(), { type: 'choice', choice: 'payments' });
    expect(choice).toMatchObject({ kind: 'choice', confidence: null, basis: null });
    expect(choice.kind === 'choice' && choice.bars).toEqual([
      { name: 'payments', probability: null, chosen: true },
    ]);
    const score = readAnswer(scoreQuestion(), { type: 'score', score: 1 });
    expect(score).toMatchObject({ kind: 'score', confidence: null });
    expect(score.kind === 'score' && score.levels.every((l) => l.probability === null)).toBe(true);
  });

  it('ignores a confidence that is not a number, and holds a stray one to 0..1', () => {
    expect(
      readAnswer(choiceQuestion(), {
        choice: 'payments',
        confidence: '0.9',
        probabilities: { payments: 0.7 },
      }),
    ).toMatchObject({ confidence: 0.7, basis: 'top-probability' });
    expect(
      readAnswer(choiceQuestion(), { choice: 'payments', confidence: 1.0000000002 }),
    ).toMatchObject({ confidence: 1 });
  });
});

describe('thresholds', () => {
  it('is clear at or above the threshold and needs review below it', () => {
    expect(verdictOf(0.8, 80)).toBe('clear');
    expect(verdictOf(0.7999, 80)).toBe('review');
    expect(verdictOf(0.96, 80)).toBe('clear');
    expect(verdictOf(0.67, 80)).toBe('review');
    expect(verdictOf(0.67, 67)).toBe('clear');
    expect(verdictOf(0.5, 0)).toBe('clear');
    expect(verdictOf(1, 100)).toBe('clear');
    expect(verdictOf(0.9999, 100)).toBe('review');
  });

  it('compares as a fraction, so 57% is met by 0.57 (0.57 * 100 is 56.99999999999999)', () => {
    expect(0.57 * 100).toBeLessThan(57);
    expect(verdictOf(0.57, 57)).toBe('clear');
    expect(verdictOf(0.29, 29)).toBe('clear');
    expect(verdictOf(0.58, 58)).toBe('clear');
  });

  it('never shows a number the badge disagrees with (Yes/No confidence is 1 - p, which carries float noise)', () => {
    // 1 - 0.07 is 0.9299999999999999: compared exactly it missed 93, though the card says 93%.
    for (const [yes, threshold] of [
      [0.07, 93],
      [0.32, 68],
      [0.33, 67],
      [0.34, 66],
    ] as const) {
      const answer = readAnswer(noulQuestion, { type: 'noul', noul: yes });
      const confidence = answer.kind === 'noul' ? answer.confidence : null;
      expect(formatPercent(confidence ?? Number.NaN)).toBe(`${threshold}%`);
      expect(resultVerdict(answer, threshold), `${yes} at ${threshold}`).toBe('clear');
      expect(resultVerdict(answer, threshold + 1)).toBe('review');
    }
  });

  it('clear exactly when the displayed percentage reaches the threshold, for every tenth of a percent', () => {
    const shown = (p: number): number => {
      const text = formatPercent(p);
      return text.startsWith('<') ? 0 : Number.parseFloat(text);
    };
    const disagreements: string[] = [];
    for (let k = 0; k <= 1000; k++) {
      const yes = k / 1000;
      for (const confidence of [yes, 1 - yes, Math.max(yes, 1 - yes)]) {
        for (let threshold = 0; threshold <= 100; threshold++) {
          const clear = verdictOf(confidence, threshold) === 'clear';
          if (clear !== shown(confidence) >= threshold) {
            disagreements.push(`${confidence} at ${threshold}: ${formatPercent(confidence)}`);
          }
        }
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([]);
  });

  it('does not round a probability just under 1 up to 100%', () => {
    expect(formatPercent(0.9999999995)).toBe('99.9%');
    expect(formatPercent(1 - 5e-10)).toBe('99.9%');
    expect(verdictOf(0.9999999995, 100)).toBe('review');
    // Float noise around exactly 1 is still 100%.
    expect(formatPercent(1 - 1e-16)).toBe('100%');
    expect(verdictOf(1 - 1e-16, 100)).toBe('clear');
    expect(formatPercent(0.1 + 0.2 + 0.7)).toBe('100%');
  });

  it('never calls an answer without a confidence clear', () => {
    expect(verdictOf(null, 0)).toBe('review');
    const answer = readAnswer(choiceQuestion(), { choice: 'payments' });
    expect(resultVerdict(answer, 0)).toBe('review');
    expect(resultVerdict({ kind: 'none', id: 'x', name: 'x', reason: 'none' }, 0)).toBe('review');
  });

  it('shows a percentage that never claims more than the number', () => {
    expect(formatPercent(0.96)).toBe('96%');
    expect(formatPercent(0.57)).toBe('57%');
    expect(formatPercent(1 - 0.9)).toBe('10%');
    expect(formatPercent(1 - 0.96)).toBe('4%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.6789)).toBe('67.8%');
    expect(formatPercent(0.9999)).toBe('99.9%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(Number.NaN)).toBe('—');
    // The text and the verdict never disagree: 83.9% is below an 84% threshold.
    expect(verdictOf(0.8390598148076417, 84)).toBe('review');
    expect(verdictOf(0.8390598148076417, 83)).toBe('clear');
  });

  it('shows a score with at most two decimals', () => {
    expect(formatScore(1.99)).toBe('1.99');
    expect(formatScore(2)).toBe('2');
    expect(formatScore(0.123456)).toBe('0.12');
    expect(formatScore(0)).toBe('0');
  });
});

describe('question ids', () => {
  it('looks answers up by the id the request used, without surrounding spaces', () => {
    const asked = { ...noulQuestion, id: ' bug ' };
    const decision = parseDecision({ model: 'm', answers: { bug: { type: 'noul', noul: 0.9 } } }, [
      asked,
    ]);
    expect(decision.results[0]).toMatchObject({ kind: 'noul', id: 'bug', yes: 0.9 });
  });
});

describe('answers that are missing, odd or extra', () => {
  it('has no confidence or cost where the response has none', () => {
    const decision = parseDecision(
      { id: 'g', model: 'm', answers: { q: { type: 'noul', noul: 0.7 } } },
      [noulQuestion],
    );
    expect(decision.costUsd).toBeNull();
    expect(decision.inputTokens).toBeNull();
    expect(decision.provider).toBeNull();
    expect(decision.results[0]).toMatchObject({ confidence: 0.7 });
    expect(parseDecision({ answers: {}, usage: { cost: 'free' } }, []).costUsd).toBeNull();
    expect(parseDecision({ answers: {}, usage: { cost: -1 } }, []).costUsd).toBeNull();
    expect(parseDecision({ answers: {}, usage: { cost: 0 } }, []).costUsd).toBe(0);
  });

  it('ignores answers nobody asked for and keys it does not know', () => {
    const decision = parseDecision(
      {
        model: 'm',
        answers: {
          q: { type: 'noul', noul: 0.7, mystery: [1, 2], nested: { deep: true } },
          stray: { type: 'noul', noul: 0.1 },
        },
        extra: 'x',
      },
      [noulQuestion],
    );
    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]).toMatchObject({ id: 'q', kind: 'noul', yes: 0.7 });
  });

  it('makes a card for a question the model did not answer', () => {
    const decision = parseDecision({ model: 'm', answers: {} }, [noulQuestion]);
    expect(decision.results[0]).toEqual({
      kind: 'none',
      id: 'q',
      name: 'Q',
      reason: 'The model sent no answer for this question.',
    });
  });

  it('does not take an inherited key for an answer', () => {
    const asked = { ...noulQuestion, id: 'constructor' };
    const decision = parseDecision({ answers: {} }, [asked]);
    expect(decision.results[0]).toMatchObject({ kind: 'none' });
  });

  it('does not read a body that is not a decision at all', () => {
    for (const body of [null, undefined, 'text', 42, [], { answers: 'no' }]) {
      const decision = parseDecision(body, [noulQuestion]);
      expect(decision.results).toEqual([expect.objectContaining({ kind: 'none' })]);
      expect(decision.model).toBeNull();
    }
  });

  it('refuses an answer of the wrong type or with unusable numbers', () => {
    const none: unknown = expect.objectContaining({ kind: 'none' });
    expect(readAnswer(noulQuestion, { type: 'choice', choice: 'a' })).toEqual(none);
    expect(readAnswer(noulQuestion, { type: 'noul', noul: 'high' })).toEqual(none);
    expect(readAnswer(noulQuestion, { type: 'noul', noul: null })).toEqual(none);
    expect(readAnswer(noulQuestion, { type: 'noul', noul: Number.NaN })).toEqual(none);
    expect(readAnswer(noulQuestion, 'yes')).toEqual(none);
    expect(readAnswer(scoreQuestion(), { type: 'score', score: 'two' })).toEqual(none);
    expect(readAnswer(choiceQuestion(), { type: 'choice' })).toEqual(none);
    expect(readAnswer(choiceQuestion(), { type: 'choice', choice: '' })).toEqual(none);
  });

  it('accepts an answer without its type field', () => {
    expect(readAnswer(noulQuestion, { noul: 0.7 })).toMatchObject({ kind: 'noul', yes: 0.7 });
  });

  it('holds a Yes/No probability to 0..1', () => {
    expect(readAnswer(noulQuestion, { noul: 1.0000000002 })).toMatchObject({ yes: 1 });
    expect(readAnswer(noulQuestion, { noul: -0.0000001 })).toMatchObject({ yes: 0 });
  });

  it('takes the leader as the choice when the answer names none', () => {
    const answer = readAnswer(choiceQuestion(), {
      probabilities: { payments: 0.2, frontend: 0.7, account: 0.1 },
    });
    expect(answer).toMatchObject({ kind: 'choice', choice: 'frontend' });
  });

  it('lists an option the model left out as 0, and one it added as it came', () => {
    const answer = readAnswer(choiceQuestion(), {
      choice: 'payments',
      probabilities: { payments: 0.6, billing: 0.4 },
    });
    expect(answer.kind === 'choice' && answer.bars).toEqual([
      { name: 'payments', probability: 0.6, chosen: true },
      { name: 'billing', probability: 0.4, chosen: false },
      { name: 'frontend', probability: 0, chosen: false },
      { name: 'account', probability: 0, chosen: false },
    ]);
  });

  it('marks a choice the probabilities do not list', () => {
    const answer = readAnswer(choiceQuestion(), {
      choice: 'other',
      probabilities: { payments: 1 },
    });
    expect(answer.kind === 'choice' && answer.bars.find((bar) => bar.chosen)).toEqual({
      name: 'other',
      probability: 0,
      chosen: true,
    });
  });

  it('skips probabilities that are not numbers', () => {
    const answer = readAnswer(choiceQuestion(), {
      choice: 'payments',
      probabilities: { payments: 0.9, frontend: 'lots', account: null },
    });
    expect(answer.kind === 'choice' && answer.bars[0]).toEqual({
      name: 'payments',
      probability: 0.9,
      chosen: true,
    });
    expect(answer).toMatchObject({ confidence: 0.9 });
  });

  it('holds a score inside the scale, and finds the nearest level', () => {
    const above = readAnswer(scoreQuestion(), { type: 'score', score: 7.2 });
    expect(above).toMatchObject({ score: 7.2, position: 2, nearest: 2 });
    const below = readAnswer(scoreQuestion(), { type: 'score', score: -3 });
    expect(below).toMatchObject({ position: 0, nearest: 0 });
    expect(readAnswer(scoreQuestion(), { score: 0.49 })).toMatchObject({ nearest: 0 });
    expect(readAnswer(scoreQuestion(), { score: 0.5 })).toMatchObject({ nearest: 1 });
  });

  it('reads score probabilities by level, ignoring keys beyond the scale', () => {
    const answer = readAnswer(scoreQuestion(), {
      score: 1,
      probabilities: { '1': 0.7, '2': 0.1, '9': 0.99, x: 0.99 },
    });
    expect(answer.kind === 'score' && answer.levels.map((l) => l.probability)).toEqual([
      0, 0.7, 0.1,
    ]);
    // The top probability is read among the levels that exist.
    expect(answer).toMatchObject({ confidence: 0.7 });
  });
});

describe('the export file', () => {
  it('holds the request state and questions with the answers, as sent and received', () => {
    const request: DecisionRequest = {
      model: 'typesafe/jev-1.13',
      state: { ticket: 'x' },
      questions: { is_bug: { type: 'noul', instructions: 'Bug?' } },
    };
    const response = documentedResponse as unknown as DecisionResponse;
    expect(exportDocument(request, response)).toEqual({
      model: 'typesafe/jev-1.13',
      answeredBy: 'typesafe/jev-1.13-20260917',
      state: { ticket: 'x' },
      questions: request.questions,
      answers: response.answers,
      usage: response.usage,
    });
    expect(isBug.id).toBe('is_bug');
  });
});
