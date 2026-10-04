import { describe, expect, it } from 'vitest';
import { validateQuestions } from './schema';
import { TEMPLATES, templateById, templateQuestions } from './templates';

describe('starter templates', () => {
  it('offers ticket triage, approve or escalate, and content review', () => {
    expect(TEMPLATES.map((template) => template.name)).toEqual([
      'Ticket triage',
      'Approve or escalate',
      'Content review',
    ]);
  });

  it('are all complete: valid questions of every type, with unique ids', () => {
    for (const template of TEMPLATES) {
      const questions = templateQuestions(template.id)!;
      expect(validateQuestions(questions), template.name).toEqual([]);
      expect(
        questions.map((q) => q.type),
        template.name,
      ).toEqual(['noul', 'choice', 'score']);
      expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
      expect(template.sample.length).toBeGreaterThan(20);
    }
  });

  it('are read-only; loading one hands out a copy to edit', () => {
    const first = templateQuestions('ticket-triage')!;
    first[0]!.name = 'Changed';
    first[1]!.options.push({ name: 'extra', description: '' });
    first.length = 0;
    const second = templateQuestions('ticket-triage')!;
    expect(second).toHaveLength(3);
    expect(second[0]!.name).toBe('Is it a bug?');
    expect(second[1]!.options).toHaveLength(3);
    expect(() => {
      (templateById('ticket-triage')!.questions[0] as { name: string }).name = 'Changed';
    }).toThrow(TypeError);
  });

  it('does not know a template it was not given', () => {
    expect(templateQuestions('nope')).toBeNull();
    expect(templateById('nope')).toBeUndefined();
  });
});
