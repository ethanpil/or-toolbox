import { describe, expect, it } from 'vitest';
import documentedRequest from '../../../tests/fixtures/openrouter/decisions-request.documented.json';
import recordedRequest from '../../../tests/fixtures/openrouter/decisions-request.recorded.json';
import {
  blankQuestion,
  blankState,
  buildRequest,
  isDerivedId,
  moveBy,
  moveTo,
  type QuestionDef,
  readFieldRows,
  readQuestion,
  readQuestions,
  readState,
  runTitle,
  slugify,
  stateValue,
  thresholdOf,
  uniqueId,
  validateQuestions,
  validateState,
  wireQuestion,
} from './schema';
import { templateQuestions } from './templates';

const question = (patch: Partial<QuestionDef> = {}): QuestionDef => ({
  ...blankQuestion(),
  name: 'Is it a bug?',
  id: 'is_bug',
  instructions: 'Is the customer reporting a software defect?',
  ...patch,
});

const choice = (patch: Partial<QuestionDef> = {}): QuestionDef =>
  question({
    type: 'choice',
    id: 'team',
    options: [
      { name: 'payments', description: 'Billing.' },
      { name: 'frontend', description: '' },
    ],
    ...patch,
  });

const score = (patch: Partial<QuestionDef> = {}): QuestionDef =>
  question({ type: 'score', id: 'urgency', levels: ['Low', 'High'], ...patch });

describe('ids', () => {
  it('turns a name into a slug', () => {
    expect(slugify('Is it a bug?')).toBe('is_it_a_bug');
    expect(slugify('  Owning   team ')).toBe('owning_team');
    expect(slugify('Café déjà vu')).toBe('cafe_deja_vu');
    expect(slugify('是否缺陷')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(slugify(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('makes ids unique with a numeric suffix, and never empty', () => {
    expect(uniqueId('team', [])).toBe('team');
    expect(uniqueId('team', ['team'])).toBe('team_2');
    expect(uniqueId('team', ['team', 'team_2'])).toBe('team_3');
    expect(uniqueId('', [])).toBe('question');
    expect(uniqueId('', ['question'])).toBe('question_2');
  });

  it('never derives an id the response parser would drop', () => {
    expect(uniqueId('prototype', [])).toBe('prototype_2');
    expect(uniqueId('constructor', ['constructor_2'])).toBe('constructor_3');
  });

  it('knows an id that follows its name', () => {
    expect(isDerivedId('is_it_a_bug', 'Is it a bug?')).toBe(true);
    expect(isDerivedId('is_it_a_bug_2', 'Is it a bug?')).toBe(true);
    expect(isDerivedId('is_bug', 'Is it a bug?')).toBe(false);
    expect(isDerivedId('question', '')).toBe(true);
  });
});

describe('reading what storage returns', () => {
  it('keeps a valid question exactly and ignores unknown keys', () => {
    const def = choice({ threshold: 65 });
    expect(readQuestion({ ...def, extra: 1, __proto__: { polluted: true } })).toEqual(def);
  });

  it('repairs what is wrong instead of failing', () => {
    expect(readQuestion(null)).toBeNull();
    expect(readQuestion('x')).toBeNull();
    const read = readQuestion({ name: 7, type: 'weird', threshold: 'high', options: 'no' })!;
    expect(read.name).toBe('');
    expect(read.type).toBe('noul');
    expect(read.threshold).toBe(80);
    expect(read.options).toHaveLength(2);
    expect(read.levels).toHaveLength(2);
    expect(readQuestion({ name: 'Is it a bug?' })!.id).toBe('is_it_a_bug');
  });

  it('clamps thresholds to 0 to 100', () => {
    expect(thresholdOf(150)).toBe(100);
    expect(thresholdOf(-5)).toBe(0);
    expect(thresholdOf(12.5)).toBe(12.5);
    expect(thresholdOf(Number.NaN)).toBe(80);
    expect(thresholdOf('80')).toBe(80);
  });

  it('reads a list of questions, dropping entries that are not questions', () => {
    expect(readQuestions('no')).toBeNull();
    expect(readQuestions([question(), 3, null])).toEqual([question()]);
  });

  it('reads the situation', () => {
    expect(readFieldRows([{ key: 'a', value: 'b' }, 4, { key: 1 }])).toEqual([
      { key: 'a', value: 'b' },
      { key: '', value: '' },
    ]);
    expect(readFieldRows('x')).toBeNull();
    expect(readState({ mode: 'fields', text: 'hi', fields: [{ key: 'a', value: 'b' }] })).toEqual({
      mode: 'fields',
      text: 'hi',
      fields: [{ key: 'a', value: 'b' }],
    });
    expect(readState({ mode: 'anything', text: 3 })).toEqual({
      mode: 'text',
      text: '',
      fields: [],
    });
  });
});

describe('validating the questions', () => {
  it('accepts a complete set', () => {
    expect(validateQuestions([question(), choice(), score()])).toEqual([]);
    expect(
      validateQuestions([question({ yes: 'It is a defect.', no: 'It is a question.' })]),
    ).toEqual([]);
  });

  it('needs at least one question', () => {
    expect(validateQuestions([])).toEqual([
      { question: -1, field: 'questions', message: 'Add at least one question.' },
    ]);
  });

  it('reports a blank question once per missing piece, in form order', () => {
    const problems = validateQuestions([blankQuestion()]);
    expect(problems.map((p) => p.field)).toEqual(['name', 'instructions']);
    // A blank id is not worth a message while the name is blank too.
  });

  it('wants an id once there is a name, and unique ids', () => {
    expect(validateQuestions([question({ id: '' })]).map((p) => p.field)).toEqual(['id']);
    const duplicate = validateQuestions([question(), question({ name: 'Other' })]);
    expect(duplicate).toEqual([
      { question: 1, field: 'id', message: 'Another question already uses “is_bug”.' },
    ]);
  });

  it('refuses ids and option names that the response parser would drop', () => {
    expect(validateQuestions([question({ id: 'prototype' })])).toEqual([
      expect.objectContaining({ field: 'id' }),
    ]);
    expect(
      validateQuestions([
        choice({
          options: [
            { name: 'constructor', description: '' },
            { name: 'ok', description: '' },
          ],
        }),
      ]),
    ).toEqual([expect.objectContaining({ field: 'option', item: 0 })]);
  });

  it('keeps the threshold between 0 and 100', () => {
    expect(validateQuestions([question({ threshold: 101 })])[0]).toMatchObject({
      field: 'threshold',
    });
    expect(validateQuestions([question({ threshold: -1 })])[0]).toMatchObject({
      field: 'threshold',
    });
    expect(validateQuestions([question({ threshold: Number.NaN })])[0]).toMatchObject({
      field: 'threshold',
    });
    expect(validateQuestions([question({ threshold: 0 }), choice({ threshold: 100 })])).toEqual([]);
  });

  it('wants both Yes/No criteria or neither', () => {
    expect(validateQuestions([question({ yes: 'A defect.' })])).toEqual([
      expect.objectContaining({ field: 'no' }),
    ]);
    expect(validateQuestions([question({ no: 'A request.' })])).toEqual([
      expect.objectContaining({ field: 'yes' }),
    ]);
    expect(validateQuestions([question({ yes: '  ', no: '' })])).toEqual([]);
  });

  it('wants a Choice to have two named options with unique names', () => {
    expect(validateQuestions([choice({ options: [{ name: 'a', description: '' }] })])).toEqual([
      expect.objectContaining({ field: 'options', message: 'Add at least 2 options.' }),
    ]);
    const blank = validateQuestions([
      choice({
        options: [
          { name: 'a', description: '' },
          { name: ' ', description: '' },
        ],
      }),
    ]);
    expect(blank).toEqual([expect.objectContaining({ field: 'option', item: 1 })]);
    const same = validateQuestions([
      choice({
        options: [
          { name: 'Bug', description: '' },
          { name: 'x', description: '' },
          { name: ' bug ', description: '' },
        ],
      }),
    ]);
    expect(same).toEqual([
      expect.objectContaining({
        field: 'option',
        item: 2,
        message: 'Another option is already called “bug”.',
      }),
    ]);
  });

  it('wants a Score to have two described levels', () => {
    expect(validateQuestions([score({ levels: ['only'] })])).toEqual([
      expect.objectContaining({ field: 'levels', message: 'Add at least 2 levels.' }),
    ]);
    expect(validateQuestions([score({ levels: ['Low', '  '] })])).toEqual([
      expect.objectContaining({ field: 'level', item: 1 }),
    ]);
  });

  it('only checks the part of the question its type uses', () => {
    // A Yes/No question may keep half-written options and levels from before.
    const mixed = question({
      options: [{ name: '', description: '' }],
      levels: [''],
    });
    expect(validateQuestions([mixed])).toEqual([]);
  });
});

describe('validating the situation', () => {
  it('needs text in text mode', () => {
    expect(validateState({ ...blankState(), text: '   ' })).toEqual([
      expect.objectContaining({ field: 'text' }),
    ]);
    expect(validateState({ ...blankState(), text: 'A ticket' })).toEqual([]);
  });

  it('needs a field with a value in field mode, ignoring blank rows', () => {
    expect(validateState({ mode: 'fields', text: 'unused', fields: [] })).toEqual([
      expect.objectContaining({ field: 'rows' }),
    ]);
    expect(validateState({ mode: 'fields', text: '', fields: [{ key: '', value: '' }] })).toEqual([
      expect.objectContaining({ field: 'rows' }),
    ]);
    expect(
      validateState({
        mode: 'fields',
        text: '',
        fields: [
          { key: '', value: '' },
          { key: 'tier', value: 'pro' },
        ],
      }),
    ).toEqual([]);
  });

  it('wants a name for every value, and unique names', () => {
    const problems = validateState({
      mode: 'fields',
      text: '',
      fields: [
        { key: 'tier', value: 'pro' },
        { key: '', value: 'orphan' },
        { key: ' tier ', value: 'again' },
      ],
    });
    expect(problems).toEqual([
      { field: 'key', row: 1, message: 'Give this field a name.' },
      { field: 'key', row: 2, message: '“tier” is used by another field.' },
    ]);
  });
});

describe('the request', () => {
  it('sends the text block as a string and the fields as an object', () => {
    expect(stateValue({ mode: 'text', text: '  A ticket \n', fields: [] })).toBe('A ticket');
    expect(
      stateValue({
        mode: 'fields',
        text: 'ignored',
        fields: [
          { key: ' tier ', value: ' pro ' },
          { key: '', value: '' },
          { key: 'note', value: '' },
        ],
      }),
    ).toEqual({ tier: 'pro', note: '' });
  });

  it('keeps a field called __proto__ as data', () => {
    const value = stateValue({
      mode: 'fields',
      text: '',
      fields: [{ key: '__proto__', value: 'x' }],
    }) as Record<string, string>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
    expect(JSON.stringify(value)).toBe('{"__proto__":"x"}');
  });

  it('writes a Yes/No question as noul, with criteria only when both are given', () => {
    expect(wireQuestion(question({ instructions: ' Q? ' }))).toEqual({
      type: 'noul',
      instructions: 'Q?',
    });
    expect(wireQuestion(question({ yes: ' Y ', no: ' N ' }))).toEqual({
      type: 'noul',
      instructions: 'Is the customer reporting a software defect?',
      criteria: { true: 'Y', false: 'N' },
    });
    expect(wireQuestion(question({ yes: 'Y' }))).not.toHaveProperty('criteria');
  });

  it('writes a Choice as an object of options, null for no description', () => {
    expect(wireQuestion(choice())).toEqual({
      type: 'choice',
      instructions: 'Is the customer reporting a software defect?',
      criteria: { payments: 'Billing.', frontend: null },
    });
    // A half-written option row is left out of the request.
    expect(
      wireQuestion(
        choice({
          options: [
            { name: 'a', description: '' },
            { name: '', description: 'orphan' },
          ],
        }),
      ),
    ).toMatchObject({ criteria: { a: null } });
  });

  it('writes a Score as the ordered array of levels', () => {
    expect(wireQuestion(score({ levels: [' Low ', 'Mid', 'High'] }))).toEqual({
      type: 'score',
      instructions: 'Is the customer reporting a software defect?',
      criteria: ['Low', 'Mid', 'High'],
    });
  });

  it('sends nothing of the other types a question still holds', () => {
    const noul = question({
      yes: 'Y',
      no: 'N',
      options: [{ name: 'a', description: '' }],
      levels: ['x', 'y'],
    });
    expect(Object.keys(wireQuestion(noul)).sort()).toEqual(['criteria', 'instructions', 'type']);
    expect(wireQuestion({ ...noul, type: 'choice' })).toMatchObject({ criteria: { a: null } });
    expect(wireQuestion({ ...noul, type: 'score' })).toMatchObject({ criteria: ['x', 'y'] });
  });

  it('is exactly the Jev tutorial request (§8.1) for the ticket triage template', () => {
    const request = buildRequest(
      'typesafe/jev-1.13',
      {
        mode: 'fields',
        text: '',
        fields: [
          { key: 'customer_tier', value: 'enterprise' },
          {
            key: 'ticket',
            value:
              'My checkout page shows a blank screen after I click Pay. I have tried two browsers.',
          },
        ],
      },
      templateQuestions('ticket-triage')!,
    );
    expect(request).toEqual(documentedRequest);
    // Key order is part of the contract with the model's prompt: questions in the order asked.
    expect(Object.keys(request.questions)).toEqual(['is_bug', 'team', 'urgency']);
    expect(Object.keys(request)).toEqual(['model', 'state', 'questions']);
  });

  it('is the recorded request for the free model', () => {
    const request = buildRequest(
      'inception/mercury-decide:free',
      {
        mode: 'fields',
        text: '',
        fields: [
          { key: 'customer_tier', value: 'enterprise' },
          {
            key: 'ticket',
            value:
              'My checkout page shows a blank screen after I click Pay. I have tried two browsers.',
          },
        ],
      },
      templateQuestions('ticket-triage')!,
    );
    expect(request).toEqual(recordedRequest);
  });

  it('survives a JSON round trip (it is what goes over the wire and into storage)', () => {
    const request = buildRequest('m', { ...blankState(), text: 'x' }, [question(), choice()]);
    expect(JSON.parse(JSON.stringify(request))).toEqual(request);
  });
});

describe('small helpers', () => {
  it('titles a run with the question names', () => {
    expect(runTitle([question(), choice({ name: 'Team' })])).toBe('Decide: Is it a bug?, Team');
    expect(runTitle([])).toBe('Decide: questions');
    expect(runTitle([question({ name: 'x'.repeat(200) })])).toHaveLength(80);
  });

  it('moves items without touching the original', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveBy(list, 1, -1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveBy(list, 1, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveBy(list, 0, -1)).toEqual(list);
    expect(moveBy(list, 3, 1)).toEqual(list);
    expect(moveTo(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveTo(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveTo(list, 9, 0)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });
});
