import { beforeEach, describe, expect, it } from 'vitest';
import documentedResponse from '../../../tests/fixtures/openrouter/decisions-response.documented.json';
import { parseDecision } from './results';
import { resultsView, type ResultsView } from './results-view';
import type { QuestionDef } from './schema';
import { templateQuestions } from './templates';

let view: ResultsView;
let questions: QuestionDef[];
/** The builder rows' keys: what a card is matched to, not the question id (which a rename changes). */
const KEYS = ['k1', 'k2', 'k3'];
const show = (): void => view.show(parseDecision(documentedResponse, questions), questions, KEYS);

beforeEach(() => {
  view = resultsView();
  document.body.replaceChildren(view.element);
  questions = templateQuestions('ticket-triage')!;
});

const $$ = (testId: string, root: ParentNode = view.element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const $ = (testId: string, root?: ParentNode): HTMLElement => {
  const found = $$(testId, root)[0];
  if (!found) throw new Error(`no element with data-testid="${testId}"`);
  return found;
};

describe('the results view', () => {
  it('starts empty, and shows the cards once there are answers', () => {
    expect($('dec-empty').closest('[hidden]')).toBeNull();
    show();
    expect($$('dec-empty')[0]!.hidden).toBe(true);
    expect($$('dec-result')).toHaveLength(3);
    // A real heading per question and a list of cards, so a screen reader can move through them.
    expect($$('dec-result').map((card) => card.querySelector('h3')?.textContent)).toEqual([
      'Is it a bug?',
      'Owning team',
      'Urgency',
    ]);
    expect($('dec-results').getAttribute('aria-label')).toBe('Answers');
  });

  it('writes every number as text and hides the drawings from assistive technology', () => {
    show();
    for (const track of view.element.querySelectorAll('.or-dec-track')) {
      expect(track.getAttribute('aria-hidden')).toBe('true');
    }
    // The score scale is one image with a full description; its parts add nothing.
    const scale = view.element.querySelector('.or-dec-scale')!;
    expect(scale.getAttribute('role')).toBe('img');
    expect(scale.getAttribute('aria-label')).toContain('Score 1.99');
    // What a screen reader reads of a level: its text, with the decorative number left out.
    const spoken = (node: HTMLElement): string => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
      return copy.textContent ?? '';
    };
    expect($$('dec-level-result').map(spoken)).toEqual([
      'Level 0: Can wait for the next release0%',
      'Level 1: Should be fixed this week0%',
      'Level 2: Blocking revenue right now100%',
    ]);
  });

  it('marks one tick per level and a marker where the score is', () => {
    show();
    const ticks = [...view.element.querySelectorAll<HTMLElement>('.or-dec-tick')];
    expect(ticks.map((tick) => tick.textContent)).toEqual(['0', '1', '2']);
    expect(ticks.map((tick) => tick.style.left)).toEqual(['0%', '50%', '100%']);
    expect(ticks[2]!.title).toBe('Blocking revenue right now');
    const marker = view.element.querySelector<HTMLElement>('.or-dec-marker')!;
    expect(marker.textContent).toBe('1.99');
    expect(Number.parseFloat(marker.style.left)).toBeCloseTo(99.5, 5);
  });

  it('sets each fill to its probability after the first frames, so it can grow', async () => {
    show();
    const fills = [...view.element.querySelectorAll<HTMLElement>('.or-dec-fill')];
    expect(fills.length).toBe(4);
    // Starts empty (the transition has something to run from)…
    expect(fills.every((fill) => fill.style.getPropertyValue('--or-fill') === '0')).toBe(true);
    // …then goes to the probability.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fills.map((fill) => fill.style.getPropertyValue('--or-fill'))).toEqual([
      '0.96',
      '0.78',
      '0.22',
      '0',
    ]);
  });

  it('highlights the chosen option and marks it in words', () => {
    show();
    const [chosen, other] = $$('dec-option-result');
    expect(chosen!.dataset['chosen']).toBe('true');
    expect(chosen!.textContent).toContain('Chosen');
    expect(other!.textContent).not.toContain('Chosen');
    // The unchosen bars are drawn muted.
    expect(other!.querySelector('.or-dec-fill')?.classList.contains('is-muted')).toBe(true);
    expect(chosen!.querySelector('.or-dec-fill')?.classList.contains('is-muted')).toBe(false);
  });

  it('re-labels in place: same elements, same fills, new badges and summary', () => {
    show();
    const cards = $$('dec-result');
    const fill = cards[0]!.querySelector('.or-dec-fill');
    expect(cards.map((c) => c.dataset['verdict'])).toEqual(['clear', 'review', 'clear']);
    expect($('dec-summary').textContent).toBe('3 questions answered · 1 needs review');

    view.relabel(
      new Map([
        ['k1', 99],
        ['k2', 50],
      ]),
    );
    expect($$('dec-result')).toEqual(cards);
    expect(cards[0]!.querySelector('.or-dec-fill')).toBe(fill);
    expect(cards.map((c) => c.dataset['verdict'])).toEqual(['review', 'clear', 'clear']);
    expect($$('dec-threshold-text', cards[0])[0]!.textContent).toBe('Threshold 99%');
    expect($$('dec-threshold-text', cards[2])[0]!.textContent).toBe('Threshold 80%');
    expect($('dec-summary').textContent).toBe('3 questions answered · 1 needs review');
    // A badge says it in words and in an icon, never by colour alone.
    expect($$('dec-verdict', cards[0])[0]!.textContent).toBe('Needs review');
    expect(
      $$('dec-verdict', cards[0])[0]!.querySelector('.bi-exclamation-triangle'),
    ).not.toBeNull();
    expect($$('dec-verdict', cards[1])[0]!.querySelector('.bi-check-circle')).not.toBeNull();

    // Questions it does not know are left as they were.
    view.relabel(new Map([['nope', 1]]));
    expect(cards.map((c) => c.dataset['verdict'])).toEqual(['review', 'clear', 'clear']);
  });

  it('dims and marks the cards busy while a run replaces them', () => {
    show();
    view.busy(true);
    expect($('dec-results').getAttribute('aria-busy')).toBe('true');
    expect(view.element.classList.contains('opacity-50')).toBe(true);
    view.busy(false);
    expect($('dec-results').hasAttribute('aria-busy')).toBe(false);
    expect(view.element.classList.contains('opacity-50')).toBe(false);
  });

  it('replaces the cards of an earlier run', () => {
    show();
    view.show(parseDecision(documentedResponse, questions.slice(0, 1)), questions.slice(0, 1), [
      'k1',
    ]);
    expect($$('dec-result')).toHaveLength(1);
    expect($('dec-summary').textContent).toBe('1 question answered · all clear');
  });

  it('re-labels the card of a question that was renamed since, because cards are matched by key not id', () => {
    show();
    const [first] = $$('dec-result');
    // The builder row k1 is now called something else on the wire; its key did not change.
    view.relabel(new Map([['k1', 99]]));
    expect(first!.dataset['verdict']).toBe('review');
    expect(first!.dataset['question']).toBe('is_bug');
  });

  it('shows the model snapshot that answered, the input tokens billed and the cost', () => {
    show();
    expect($('dec-meta').textContent).toBe(
      'Answered by typesafe/jev-1.13-20260917 · 476 input tokens · Cost <$0.0001',
    );
    view.show(parseDecision({ answers: {}, model: '' }, questions), questions, KEYS);
    expect($('dec-meta').textContent).toBe('Cost not reported');
  });
});
