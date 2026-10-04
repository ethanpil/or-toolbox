import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { questionBuilder, type QuestionBuilder } from './builder';
import { blankQuestion, type QuestionDef } from './schema';
import { templateQuestions } from './templates';

let builder: QuestionBuilder;
let changes = 0;

beforeEach(() => {
  changes = 0;
  builder = questionBuilder({ onChange: () => (changes += 1) });
  document.body.append(builder.element);
});
afterEach(() => {
  builder.element.remove();
});

const $$ = (testId: string, root: ParentNode = builder.element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const $ = (testId: string, root: ParentNode = builder.element): HTMLElement => {
  const found = $$(testId, root)[0];
  if (!found) throw new Error(`no element with data-testid="${testId}"`);
  return found;
};
const values = (testId: string, root?: ParentNode): string[] =>
  ($$(testId, root) as HTMLInputElement[]).map((input) => input.value);

function type(element: HTMLElement, value: string): void {
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

const card = (index = 0): HTMLElement => $$('dec-question')[index]!;
const choose = (index: number, type: 'noul' | 'choice' | 'score'): void => {
  const select = $('dec-type', card(index)) as HTMLSelectElement;
  select.value = type;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const ariaInvalid = (element: HTMLElement): boolean =>
  element.getAttribute('aria-invalid') === 'true';

describe('question cards', () => {
  it('adds and removes questions, naming each card by its place', () => {
    builder.setQuestions([blankQuestion()]);
    $('dec-add-question').click();
    $('dec-add-question').click();
    expect($$('dec-question')).toHaveLength(3);
    expect($$('dec-question').map((q) => q.querySelector('h4')?.textContent)).toEqual([
      'Question 1',
      'Question 2',
      'Question 3',
    ]);
    $('dec-question-remove', card(1)).click();
    expect($$('dec-question')).toHaveLength(2);
    expect(card(1).querySelector('h4')?.textContent).toBe('Question 2');
    expect(changes).toBe(3);
  });

  it('moves focus to the neighbour when a question is removed, and to Add when none is left', () => {
    builder.setQuestions([blankQuestion(), blankQuestion()]);
    $('dec-question-remove', card(0)).focus();
    $('dec-question-remove', card(0)).click();
    expect(document.activeElement).toBe($('dec-question-remove', card(0)));
    $('dec-question-remove', card(0)).click();
    expect(document.activeElement).toBe($('dec-add-question'));
  });

  it('derives the id from the name, unique among the questions', () => {
    builder.setQuestions([blankQuestion(), blankQuestion()]);
    type($('dec-name', card(0)), 'Is it a bug?');
    expect(($('dec-id', card(0)) as HTMLInputElement).value).toBe('is_it_a_bug');
    type($('dec-name', card(1)), 'Is it a bug');
    expect(($('dec-id', card(1)) as HTMLInputElement).value).toBe('is_it_a_bug_2');
    // While the name is being typed the id follows it.
    ($('dec-name', card(0)) as HTMLInputElement).value = 'Owning team';
    $('dec-name', card(0)).dispatchEvent(new Event('input', { bubbles: true }));
    expect(($('dec-id', card(0)) as HTMLInputElement).value).toBe('owning_team');
    expect(builder.questions().map((q) => q.id)).toEqual(['owning_team', 'is_it_a_bug_2']);
  });

  it('lets the id be edited, and then leaves it alone when the name changes', () => {
    builder.setQuestions([blankQuestion()]);
    type($('dec-name', card()), 'Is it a bug?');
    type($('dec-id', card()), 'Is Bug!');
    expect(($('dec-id', card()) as HTMLInputElement).value).toBe('is_bug');
    type($('dec-name', card()), 'A completely different name');
    expect(builder.questions()[0]!.id).toBe('is_bug');
    // Emptying it hands it back to the name.
    type($('dec-id', card()), '');
    expect(builder.questions()[0]!.id).toBe('a_completely_different_name');
  });

  it('keeps an id it was given by a template through renames', () => {
    builder.setQuestions(templateQuestions('ticket-triage')!);
    type($('dec-name', card(0)), 'Defect?');
    expect(builder.questions()[0]!.id).toBe('is_bug');
  });

  it('flags a duplicate id where it is typed', () => {
    builder.setQuestions(templateQuestions('ticket-triage')!);
    type($('dec-id', card(1)), 'is_bug');
    const id = $('dec-id', card(1));
    expect(ariaInvalid(id)).toBe(true);
    expect(card(1).textContent).toContain('Another question already uses “is_bug”.');
    expect(builder.validate()).toBe(false);
    type($('dec-id', card(1)), 'owner');
    expect(ariaInvalid(id)).toBe(false);
    expect(builder.validate()).toBe(true);
  });

  it('keeps what was typed for the other types when the type changes', () => {
    builder.setQuestions([blankQuestion()]);
    type($('dec-yes', card()), 'It is a defect.');
    type($('dec-no', card()), 'It is a request.');
    choose(0, 'choice');
    expect($$('dec-yes')).toHaveLength(0);
    type($$('dec-option-name')[0]!, 'bug');
    type($$('dec-option-description')[0]!, 'A defect');
    choose(0, 'score');
    expect($$('dec-option-name')).toHaveLength(0);
    type($$('dec-level-text')[0]!, 'Low');
    choose(0, 'noul');
    expect(values('dec-yes')).toEqual(['It is a defect.']);
    expect(values('dec-no')).toEqual(['It is a request.']);
    const def = builder.questions()[0]!;
    expect(def.options[0]).toEqual({ name: 'bug', description: 'A defect' });
    expect(def.levels[0]).toBe('Low');
  });

  it('shows the part its type needs', () => {
    builder.setQuestions([blankQuestion()]);
    expect($$('dec-yes')).toHaveLength(1);
    choose(0, 'choice');
    expect($$('dec-option')).toHaveLength(2);
    expect($$('dec-add-option')).toHaveLength(1);
    choose(0, 'score');
    expect($$('dec-level')).toHaveLength(2);
    expect($$('dec-add-level')).toHaveLength(1);
  });

  it('restores questions exactly as given, whatever the type', () => {
    const questions: QuestionDef[] = [
      ...templateQuestions('content-review')!,
      { ...blankQuestion(12.5), name: 'x', id: 'custom', instructions: 'y', yes: 'a', no: 'b' },
    ];
    builder.setQuestions(questions);
    expect(builder.questions()).toEqual(questions);
    builder.setQuestions(builder.questions());
    expect(builder.questions()).toEqual(questions);
  });
});

describe('Choice options', () => {
  const choice = (): QuestionDef => ({
    ...blankQuestion(),
    name: 'Team',
    id: 'team',
    instructions: 'Which team?',
    type: 'choice',
    options: [
      { name: 'payments', description: '' },
      { name: 'frontend', description: '' },
      { name: 'account', description: '' },
    ],
  });

  it('adds, removes and reorders options with buttons, keeping focus on the moved one', () => {
    builder.setQuestions([choice()]);
    const names = (): string[] => builder.questions()[0]!.options.map((o) => o.name);
    $$('dec-option-down')[0]!.focus();
    $$('dec-option-down')[0]!.click();
    expect(names()).toEqual(['frontend', 'payments', 'account']);
    // Focus follows the option that moved, on the button that was pressed.
    expect(document.activeElement).toBe($$('dec-option-down')[1]);
    $$('dec-option-up')[2]!.click();
    expect(names()).toEqual(['frontend', 'account', 'payments']);
    $$('dec-option-remove')[0]!.click();
    expect(names()).toEqual(['account', 'payments']);

    $('dec-add-option').click();
    expect(builder.questions()[0]!.options).toHaveLength(3);
    expect(document.activeElement).toBe($$('dec-option-name')[2]);
  });

  it('disables moving past either end', () => {
    builder.setQuestions([choice()]);
    expect(($$('dec-option-up')[0] as HTMLButtonElement).disabled).toBe(true);
    expect(($$('dec-option-down')[2] as HTMLButtonElement).disabled).toBe(true);
    expect(($$('dec-option-up')[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps focus on a button whose move reached the end by falling back to its twin', () => {
    builder.setQuestions([choice()]);
    $$('dec-option-down')[1]!.focus();
    $$('dec-option-down')[1]!.click();
    // The moved option is last now: its Down is disabled, so focus lands on its Up.
    expect(document.activeElement).toBe($$('dec-option-up')[2]);
  });

  it('needs two options with unique, named rows, and says where', () => {
    builder.setQuestions([{ ...choice(), options: [{ name: 'only', description: '' }] }]);
    expect(builder.validate()).toBe(false);
    expect(card().textContent).toContain('Add at least 2 options.');
    $('dec-add-option').click();
    type($$('dec-option-name')[1]!, 'only');
    expect(ariaInvalid($$('dec-option-name')[1]!)).toBe(true);
    expect(card().textContent).toContain('Another option is already called “only”.');
    type($$('dec-option-name')[1]!, 'other');
    expect(builder.validate()).toBe(true);
    expect(card().textContent).not.toContain('Add at least');
  });

  it('puts focus on the first thing to fix', () => {
    builder.setQuestions([choice(), { ...choice(), id: 'second', name: '', instructions: '' }]);
    expect(builder.validate()).toBe(false);
    expect(document.activeElement).toBe($('dec-name', card(1)));
    expect(ariaInvalid($('dec-name', card(1)))).toBe(true);
    expect(ariaInvalid($('dec-instructions', card(1)))).toBe(true);
    expect(ariaInvalid($('dec-name', card(0)))).toBe(false);
  });
});

describe('Score levels', () => {
  const score = (): QuestionDef => ({
    ...blankQuestion(),
    name: 'Urgency',
    id: 'urgency',
    instructions: 'How urgent?',
    type: 'score',
    levels: ['Low', 'Medium', 'High'],
  });
  const levels = (): string[] => builder.questions()[0]!.levels;

  it('reorders levels with Move up and Move down, which name the level', () => {
    builder.setQuestions([score()]);
    expect($$('dec-level-up')[1]!.getAttribute('aria-label')).toBe('Move level 1 of Urgency up');
    $$('dec-level-up')[2]!.click();
    expect(levels()).toEqual(['Low', 'High', 'Medium']);
    $$('dec-level-down')[0]!.click();
    expect(levels()).toEqual(['High', 'Low', 'Medium']);
    expect(values('dec-level-text')).toEqual(['High', 'Low', 'Medium']);
  });

  it('numbers the levels from 0', () => {
    builder.setQuestions([score()]);
    expect(
      $$('dec-level').map((li) => li.querySelector('.or-dec-level-index')?.textContent),
    ).toEqual(['0', '1', '2']);
  });

  it('adds and removes levels, and wants two described ones', () => {
    builder.setQuestions([score()]);
    $('dec-add-level').click();
    expect($$('dec-level')).toHaveLength(4);
    expect(document.activeElement).toBe($$('dec-level-text')[3]);
    expect(builder.validate()).toBe(false);
    expect(ariaInvalid($$('dec-level-text')[3]!)).toBe(true);
    $$('dec-level-remove')[3]!.click();
    $$('dec-level-remove')[2]!.click();
    $$('dec-level-remove')[1]!.click();
    expect(builder.validate()).toBe(false);
    expect(card().textContent).toContain('Add at least 2 levels.');
  });

  describe('drag and drop', () => {
    const drag = (from: number, to: number, where: 'before' | 'after'): void => {
      const items = $$('dec-level');
      $$('dec-level-handle')[from]!.dispatchEvent(new Event('dragstart', { bubbles: true }));
      const target = items[to]!;
      // jsdom has no layout: every box is empty, so a pointer below its top (y 1) is in the lower half.
      target.dispatchEvent(
        new MouseEvent('dragover', {
          bubbles: true,
          cancelable: true,
          clientY: where === 'after' ? 1 : -1,
        }),
      );
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      $$('dec-level-handle')[from]?.dispatchEvent(new Event('dragend', { bubbles: true }));
    };

    it('moves a level to where it is dropped', () => {
      builder.setQuestions([score()]);
      drag(0, 2, 'after');
      expect(levels()).toEqual(['Medium', 'High', 'Low']);
      drag(2, 0, 'before');
      expect(levels()).toEqual(['Low', 'Medium', 'High']);
      drag(0, 1, 'after');
      expect(levels()).toEqual(['Medium', 'Low', 'High']);
      drag(2, 0, 'after');
      expect(levels()).toEqual(['Medium', 'High', 'Low']);
    });

    it('does nothing when a level is dropped where it already is', () => {
      builder.setQuestions([score()]);
      const before = changes;
      drag(1, 1, 'after');
      drag(1, 2, 'before');
      drag(1, 0, 'after');
      expect(levels()).toEqual(['Low', 'Medium', 'High']);
      expect(changes).toBe(before);
    });

    it('ignores a drag that started in another question', () => {
      builder.setQuestions([score(), { ...score(), id: 'other', levels: ['a', 'b'] }]);
      $$('dec-level-handle', card(0))[0]!.dispatchEvent(new Event('dragstart', { bubbles: true }));
      const target = $$('dec-level', card(1))[1]!;
      target.dispatchEvent(
        new MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 1 }),
      );
      target.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
      expect(builder.questions()[1]!.levels).toEqual(['a', 'b']);
      expect(builder.questions()[0]!.levels).toEqual(['Low', 'Medium', 'High']);
    });

    it('marks the handle as decoration: the buttons are the accessible way', () => {
      builder.setQuestions([score()]);
      const handle = $$('dec-level-handle')[0]!;
      expect(handle.getAttribute('aria-hidden')).toBe('true');
      expect(handle.draggable).toBe(true);
      expect(handle.tabIndex).toBe(-1);
    });
  });
});

describe('validation', () => {
  it('does not scold a card for being empty until it is touched or Run fails', () => {
    builder.setQuestions([blankQuestion()]);
    expect(ariaInvalid($('dec-name'))).toBe(false);
    expect(builder.validate()).toBe(false);
    expect(ariaInvalid($('dec-name'))).toBe(true);
    // A card added afterwards starts clean.
    $('dec-add-question').click();
    expect(ariaInvalid($('dec-name', card(1)))).toBe(false);
  });

  it('clears a message as soon as the field is fixed, without waiting for it to lose focus', () => {
    builder.setQuestions([blankQuestion()]);
    expect(builder.validate()).toBe(false);
    const name = $('dec-name') as HTMLInputElement;
    expect(ariaInvalid(name)).toBe(true);
    name.value = 'Q';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ariaInvalid(name)).toBe(false);
    name.value = '';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    expect(ariaInvalid(name)).toBe(true);
  });

  it('wants a Yes/No pair of criteria or neither, and clears the message when fixed', () => {
    builder.setQuestions([{ ...blankQuestion(), name: 'Q', id: 'q', instructions: 'Q?' }]);
    type($('dec-yes'), 'It is a defect.');
    // The other box is not scolded while the user is on their way to it.
    expect(ariaInvalid($('dec-no'))).toBe(false);
    expect(builder.validate()).toBe(false);
    expect(ariaInvalid($('dec-no'))).toBe(true);
    expect(card().textContent).toContain('Describe the No case too, or clear the Yes criteria.');
    expect(document.activeElement).toBe($('dec-no'));
    type($('dec-yes'), '');
    expect(ariaInvalid($('dec-no'))).toBe(false);
    expect(builder.validate()).toBe(true);
  });

  it('refuses a threshold that is not a percentage, and accepts the ends', () => {
    builder.setQuestions([{ ...blankQuestion(), name: 'Q', id: 'q', instructions: 'Q?' }]);
    const input = $('dec-threshold') as HTMLInputElement;
    type(input, '150');
    expect(ariaInvalid(input)).toBe(true);
    expect(builder.validate()).toBe(false);
    // What the request would use meanwhile is held inside 0..100.
    expect(builder.questions()[0]!.threshold).toBe(100);
    type(input, '');
    expect(builder.validate()).toBe(false);
    expect(builder.questions()[0]!.threshold).toBe(80);
    type(input, '0');
    expect(builder.validate()).toBe(true);
    type(input, '100');
    expect(builder.validate()).toBe(true);
    expect(builder.questions()[0]!.threshold).toBe(100);
  });

  it('needs a question at all', () => {
    builder.setQuestions([]);
    expect(builder.validate()).toBe(false);
    expect(builder.element.textContent).toContain('Add at least one question.');
    expect(document.activeElement).toBe($('dec-add-question'));
    $('dec-add-question').click();
    expect(builder.element.textContent).not.toContain('Add at least one question.');
  });

  it('accepts the three templates', () => {
    for (const id of ['ticket-triage', 'approve-escalate', 'content-review']) {
      builder.setQuestions(templateQuestions(id)!);
      expect(builder.validate(), id).toBe(true);
    }
  });
});
