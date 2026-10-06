import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import documentedRequest from '../../../tests/fixtures/openrouter/decisions-request.documented.json';
import documentedResponse from '../../../tests/fixtures/openrouter/decisions-response.documented.json';
import mercuryResponse from '../../../tests/fixtures/openrouter/decisions-response.recorded.json';
import modelsFixture from '../../../tests/fixtures/openrouter/models.json';
import type { DecisionRequest, DecisionResponse, RawModel } from '../../core/api/types';
import { RateLimitError } from '../../core/errors';
import { getDb } from '../../core/storage/db';
import { isolateChannels, resetDb } from '../../core/testing/state-fakes';
import { acceptsFile, mimeMatches } from '../../ui/components/file-types';
import type * as Dialogs from '../../ui/feedback/dialogs';
import { promptDialog } from '../../ui/feedback/dialogs';
import { createToolTestContext, type ToolTestContext } from '../../ui/tool/testing';
import type { ToolInstance } from '../../ui/tool/types';
import { getTool } from '../registry';
import { newDeciderId, type SavedDecider } from './saved';
import { blankQuestion, type QuestionDef } from './schema';
import { templateQuestions } from './templates';
import { setup } from './tool';

vi.mock('../../ui/feedback/dialogs', async (importOriginal) => ({
  ...(await importOriginal<typeof Dialogs>()),
  promptDialog: vi.fn(),
}));

const catalog = (modelsFixture.data as unknown as RawModel[]).filter(
  (model) => model.id === 'typesafe/jev-1.13' || model.id === 'inception/mercury-decide:free',
);

const triage = (): QuestionDef[] => templateQuestions('ticket-triage')!;
const TICKET =
  'My checkout page shows a blank screen after I click Pay. I have tried two browsers.';
const FIELDS = [
  { key: 'customer_tier', value: 'enterprise' },
  { key: 'ticket', value: TICKET },
];

let t: ToolTestContext | null = null;
beforeEach(async () => {
  isolateChannels();
  await resetDb();
  localStorage.clear();
  document.querySelectorAll('[data-testid="toasts"]').forEach((node) => node.remove());
});
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const $$ = (root: ParentNode, testId: string): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];
const $ = (root: ParentNode, testId: string): HTMLElement => {
  const found = $$(root, testId)[0];
  if (!found) throw new Error(`no element with data-testid="${testId}"`);
  return found;
};
const textOf = (root: ParentNode, testId: string): string => $(root, testId).textContent ?? '';
const texts = (root: ParentNode, testId: string): string[] =>
  $$(root, testId).map((node) => node.textContent ?? '');

/** Types into a field the way the user does: input events while typing, change on leaving it. */
function type(element: HTMLElement, value: string): void {
  (element as HTMLInputElement).value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

const decideWith = (response: unknown) =>
  vi.fn((body: DecisionRequest, options?: unknown) => {
    void body;
    void options;
    return Promise.resolve(response as DecisionResponse);
  });

async function mount(
  decide: ReturnType<typeof decideWith>,
  options: { modelOverride?: string } = {},
): Promise<{ t: ToolTestContext; tool: ToolInstance }> {
  const context = createToolTestContext(getTool('decision'), {
    catalog,
    api: { decide },
    ...options,
  });
  t = context;
  return { t: context, tool: await context.mount(setup) };
}

/** The ticket triage questions and the tutorial's fields, as a restored snapshot. */
const loadTriage = (tool: ToolInstance, settings: Record<string, unknown> = {}): void =>
  tool.applyState({
    prompt: '',
    settings: { stateMode: 'fields', fields: FIELDS, questions: triage(), ...settings },
  });

describe('the form', () => {
  it('starts with the prompt field, the library and one blank Yes/No question', async () => {
    const { t } = await mount(decideWith(documentedResponse));
    expect(t.zones.input.querySelector('[data-testid="tool-prompt"]')).not.toBeNull();
    expect($$(t.zones.input, 'dec-question')).toHaveLength(1);
    expect(($(t.zones.input, 'dec-type') as HTMLSelectElement).value).toBe('noul');
    expect(($(t.zones.input, 'dec-threshold') as HTMLInputElement).value).toBe('80');
    expect($$(t.zones.input, 'dec-library')).toHaveLength(1);
  });

  it('round-trips its whole state: text, fields, thresholds, every question type', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    const questions = triage();
    questions[0]!.threshold = 65;
    questions[1]!.threshold = 90.5;
    questions.push({
      ...blankQuestion(),
      name: 'Spare',
      id: 'spare',
      instructions: 'Kept data of other types',
      options: [
        { name: 'left', description: 'over' },
        { name: '', description: '' },
      ],
      levels: ['a', 'b', 'c'],
    });
    const state = {
      // In fields mode the prompt says what is sent; the text block kept behind it rides in the settings.
      prompt: `customer_tier: enterprise\nticket: ${TICKET}`,
      settings: {
        stateMode: 'fields',
        fields: [...FIELDS, { key: '', value: '' }],
        text: 'Kept while the fields are in use',
        questions,
      },
    };
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);
    tool.applyState(tool.getState());
    expect(tool.getState()).toEqual(state);

    expect($$(t.zones.input, 'dec-question')).toHaveLength(4);
    expect($$(t.zones.input, 'dec-field')).toHaveLength(3);
    expect(($(t.zones.input, 'dec-mode-fields') as HTMLInputElement).checked).toBe(true);
    expect(($(t.zones.input, 'tool-prompt') as HTMLTextAreaElement).value).toBe(
      'Kept while the fields are in use',
    );
    expect(
      ($$(t.zones.input, 'dec-threshold') as HTMLInputElement[]).map((input) => input.value),
    ).toEqual(['65', '90.5', '80', '80']);
  });

  it('restores a text-mode state, and leaves what a snapshot does not mention alone', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    loadTriage(tool);
    tool.applyState({ prompt: 'Just text', settings: { somethingNew: 1 } });
    const state = tool.getState();
    expect(state.prompt).toBe('Just text');
    expect(state.settings['stateMode']).toBe('text');
    // Questions and fields were not in the snapshot: they stay.
    expect(state.settings['questions']).toEqual(triage());
    expect(state.settings['fields']).toEqual(FIELDS);
    expect($$(t.zones.input, 'dec-question')).toHaveLength(3);
  });

  it('describes in its prompt what is sent: the text block, or the key: value lines of the fields', async () => {
    const { tool } = await mount(decideWith(documentedResponse));
    tool.applyState({
      prompt: 'A text block',
      settings: { stateMode: 'text', questions: triage() },
    });
    expect(tool.getState().prompt).toBe('A text block');
    expect(tool.getState().settings).not.toHaveProperty('text');

    tool.applyState({
      prompt: 'whatever a snapshot says here',
      settings: {
        stateMode: 'fields',
        text: 'Hidden words that are never sent',
        fields: [
          { key: ' tier ', value: ' pro ' },
          { key: '', value: '' },
          { key: 'note', value: 'a\nb' },
        ],
        questions: triage(),
      },
    });
    const state = tool.getState();
    // Not the hidden text, not the blank row, and what the request would hold (names and values trimmed).
    expect(state.prompt).toBe('tier: pro\nnote: a\nb');
    expect(state.settings['text']).toBe('Hidden words that are never sent');
    expect(state.settings['fields']).toEqual([
      { key: ' tier ', value: ' pro ' },
      { key: '', value: '' },
      { key: 'note', value: 'a\nb' },
    ]);
    tool.applyState(state);
    expect(tool.getState()).toEqual(state);

    // Nothing in the fields: nothing to describe.
    tool.applyState({
      prompt: 'x',
      settings: { stateMode: 'fields', fields: [{ key: '', value: '' }], questions: triage() },
    });
    expect(tool.getState().prompt).toBe('');
  });

  it('takes the fields from the settings in fields mode and the text from the prompt in text mode', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    tool.applyState({
      prompt: 'ignored',
      settings: { stateMode: 'fields', fields: FIELDS, text: 'hidden', questions: triage() },
    });
    expect(($$(t.zones.input, 'dec-field-key') as HTMLInputElement[]).map((k) => k.value)).toEqual([
      'customer_tier',
      'ticket',
    ]);
    expect(($(t.zones.input, 'tool-prompt') as HTMLTextAreaElement).value).toBe('hidden');
    tool.applyState({ prompt: 'Back to text', settings: { stateMode: 'text' } });
    expect(($(t.zones.input, 'tool-prompt') as HTMLTextAreaElement).value).toBe('Back to text');
  });

  it('carries a threshold typed in the form into the state', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    type($(t.zones.input, 'dec-threshold'), '72');
    expect((tool.getState().settings['questions'] as QuestionDef[])[0]!.threshold).toBe(72);
  });

  it('starts a new question at the starting threshold from the drawer', async () => {
    const { t } = await mount(decideWith(documentedResponse));
    type($(t.zones.drawer, 'dec-default-threshold'), '65');
    expect(t.ctx.options.get()['threshold']).toBe(65);
    $(t.zones.input, 'dec-add-question').click();
    const inputs = $$(t.zones.input, 'dec-threshold') as HTMLInputElement[];
    expect(inputs.map((input) => input.value)).toEqual(['80', '65']);
  });

  it('fills the onboarding sample: the ticket triage questions and a ticket', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    await tool.sample?.();
    expect(($(t.zones.input, 'tool-prompt') as HTMLTextAreaElement).value).toContain(
      'checkout page shows a blank screen',
    );
    expect($$(t.zones.input, 'dec-question')).toHaveLength(3);
    expect(tool.getState().settings['stateMode']).toBe('text');
  });

  it('reads dropped text files into the situation, and skips ones too large to be useful', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    const prompt = $(t.zones.input, 'tool-prompt') as HTMLTextAreaElement;
    type(prompt, 'First');
    tool.onFiles?.([new File(['Second note'], 'note.txt', { type: 'text/plain' })]);
    await vi.waitFor(() => expect(prompt.value).toBe('First\n\nSecond note'));

    const huge = new File(['x'], 'huge.txt', { type: 'text/plain' });
    Object.defineProperty(huge, 'size', { value: 5_000_000 });
    tool.onFiles?.([huge]);
    expect(t.status()).toBe('1 file skipped: over 1 MB.');
    expect(prompt.value).toBe('First\n\nSecond note');
  });

  it('leaves the form alone when what was dropped or sent adds nothing', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    loadTriage(tool);
    const before = tool.getState();
    const huge = new File(['x'], 'huge.txt', { type: 'text/plain' });
    Object.defineProperty(huge, 'size', { value: 5_000_000 });
    tool.onFiles?.([huge]);
    tool.onFiles?.([new File([''], 'empty.txt', { type: 'text/plain' })]);
    tool.onFiles?.([new File(['  \n '], 'blank.txt', { type: 'text/plain' })]);
    tool.onReceive?.([{ kind: 'text', text: '  ' }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(tool.getState()).toEqual(before);
    expect(($(t.zones.input, 'dec-mode-fields') as HTMLInputElement).checked).toBe(true);
    expect(t.status()).toContain('nothing to add');
  });

  it('takes text sent from another tool in place of the situation', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    loadTriage(tool);
    tool.onReceive?.([{ kind: 'text', text: 'Sent over' }]);
    expect(($(t.zones.input, 'tool-prompt') as HTMLTextAreaElement).value).toBe('Sent over');
    expect(tool.getState().settings['stateMode']).toBe('text');
  });
});

describe('running', () => {
  it('asks all three kinds of question in one request and draws each answer', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    loadTriage(tool);
    await t.runners[0]!.trigger();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0]).toEqual(documentedRequest);
    const callOptions: unknown = decide.mock.calls[0]![1];
    expect(callOptions).toHaveProperty('run.tool', 'decision');

    const cards = $$(t.zones.output, 'dec-result');
    expect(cards.map((card) => card.dataset['kind'])).toEqual(['noul', 'choice', 'score']);
    expect(cards.map((card) => card.dataset['question'])).toEqual(['is_bug', 'team', 'urgency']);

    // Yes/No: a meter and the numbers as text.
    expect(textOf(cards[0]!, 'dec-yes-text')).toBe('Yes 96%');
    expect(textOf(cards[0]!, 'dec-no-text')).toBe('No 4%');
    expect(textOf(cards[0]!, 'dec-confidence')).toBe('Confidence 96% (the stronger of Yes and No)');
    expect(textOf(cards[0]!, 'dec-threshold-text')).toBe('Threshold 80%');
    expect(cards[0]!.dataset['verdict']).toBe('clear');
    expect(textOf(cards[0]!, 'dec-verdict')).toBe('Clear');

    // Choice: a bar per option, highest first, the chosen one marked.
    const options = $$(cards[1]!, 'dec-option-result');
    expect(options.map((o) => o.dataset['option'])).toEqual(['payments', 'frontend', 'account']);
    expect(options.map((o) => o.dataset['chosen'])).toEqual(['true', 'false', 'false']);
    expect(texts(cards[1]!, 'dec-option-percent')).toEqual(['78%', '22%', '0%']);
    expect(options[0]!.textContent).toContain('Chosen');
    expect(textOf(cards[1]!, 'dec-confidence')).toBe('Confidence 67%');
    expect(textOf(cards[1]!, 'dec-verdict')).toBe('Needs review');

    // Score: the position as text, every level's probability listed.
    expect(textOf(cards[2]!, 'dec-score-text')).toBe('Score 1.99');
    expect(cards[2]!.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Score 1.99 on a scale from 0 (Can wait for the next release) to 2 (Blocking revenue right now)',
    );
    expect(texts(cards[2]!, 'dec-level-percent')).toEqual(['0%', '0%', '100%']);
    expect(cards[2]!.dataset['verdict']).toBe('clear');

    expect(textOf(t.zones.output, 'dec-summary')).toBe('3 questions answered · 1 needs review');
    expect(textOf(t.zones.output, 'dec-meta')).toContain('typesafe/jev-1.13-20260917');
    expect(textOf(t.zones.output, 'dec-cost')).toBe('Cost <$0.0001');
    expect(t.status()).toBe('Done · 3 questions, 1 needs review');
  });

  it('records one run whose output is the JSON answers and whose settings restore the form', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    loadTriage(tool, { stateMode: 'fields' });
    await t.runners[0]!.trigger();

    const runs = await t.core.history.query({ tool: 'decision' });
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe('ok');
    expect(run.title).toBe('Decide: Is it a bug?, Owning team, Urgency');
    expect(run.model).toBe('typesafe/jev-1.13');
    expect(JSON.parse(run.output ?? '')).toEqual(documentedResponse.answers);
    expect(run.settings).toEqual(tool.getState().settings);

    // History's "run again" is applyState of the record: the form comes back exactly.
    const before = tool.getState();
    tool.applyState({ prompt: 'Something else', settings: { stateMode: 'text', questions: [] } });
    expect(tool.getState()).not.toEqual(before);
    tool.applyState({ prompt: run.prompt ?? '', settings: run.settings ?? {} });
    expect(tool.getState()).toEqual(before);
  });

  it('re-labels the shown answers when a threshold changes, without asking again', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    loadTriage(tool);
    await t.runners[0]!.trigger();
    const [first, second] = $$(t.zones.output, 'dec-result');
    const thresholds = $$(t.zones.input, 'dec-threshold');

    type(thresholds[0]!, '97'); // 96% is now short of it
    expect(first!.dataset['verdict']).toBe('review');
    expect(textOf(first!, 'dec-threshold-text')).toBe('Threshold 97%');
    type(thresholds[1]!, '60'); // and 67% now reaches it
    expect(second!.dataset['verdict']).toBe('clear');
    expect(textOf(t.zones.output, 'dec-summary')).toBe('3 questions answered · 1 needs review');
    type(thresholds[0]!, '96'); // exactly at the threshold is clear
    expect(first!.dataset['verdict']).toBe('clear');
    expect(textOf(t.zones.output, 'dec-summary')).toBe('3 questions answered · all clear');

    // The same cards, edited in place; nothing was sent again.
    expect($$(t.zones.output, 'dec-result')[0]).toBe(first);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('reads Mercury Decide’s long unrounded floats', async () => {
    const decide = decideWith(mercuryResponse);
    const { t, tool } = await mount(decide, { modelOverride: 'inception/mercury-decide:free' });
    loadTriage(tool);
    await t.runners[0]!.trigger();

    expect(decide.mock.calls[0]![0].model).toBe('inception/mercury-decide:free');
    const cards = $$(t.zones.output, 'dec-result');
    expect(textOf(cards[0]!, 'dec-yes-text')).toBe('Yes 99.9%');
    expect(textOf(cards[0]!, 'dec-no-text')).toBe('No <0.1%');
    expect(texts(cards[1]!, 'dec-option-percent')).toEqual(['89.2%', '10.6%', '<0.1%']);
    expect(textOf(cards[1]!, 'dec-confidence')).toBe('Confidence 83.9%');
    expect(textOf(cards[2]!, 'dec-score-text')).toBe('Score 2');
    expect(texts(cards[2]!, 'dec-level-percent')).toEqual(['<0.1%', '0.1%', '99.8%']);
    expect(textOf(t.zones.output, 'dec-summary')).toBe('3 questions answered · all clear');
    expect(textOf(t.zones.output, 'dec-cost')).toBe('Cost: free');
    expect(textOf(t.zones.output, 'dec-meta')).toContain('inception/mercury-decide-20260930');
  });

  it('shows what it can when the response lacks confidence, probabilities and cost', async () => {
    const decide = decideWith({
      id: 'gen-dec-1',
      model: 'some/model-1',
      answers: {
        is_bug: { type: 'noul', noul: 0.7, unknownKey: { deep: [1] } },
        team: {
          type: 'choice',
          choice: 'frontend',
          probabilities: { payments: 0.3, frontend: 0.7 },
        },
        urgency: { type: 'score', score: 0.2 },
        invented: { type: 'noul', noul: 0.5 },
      },
    });
    const { t, tool } = await mount(decide);
    loadTriage(tool);
    await t.runners[0]!.trigger();

    const cards = $$(t.zones.output, 'dec-result');
    expect(cards).toHaveLength(3);
    expect(textOf(cards[1]!, 'dec-confidence')).toBe('Confidence 70% (the highest probability)');
    expect(textOf(cards[2]!, 'dec-confidence')).toBe('Confidence not reported');
    expect(texts(cards[2]!, 'dec-level-percent')).toEqual(['', '', '']);
    expect(cards.map((card) => card.dataset['verdict'])).toEqual(['review', 'review', 'review']);
    expect(textOf(t.zones.output, 'dec-cost')).toBe('Cost not reported');
    const run = (await t.core.history.query({ tool: 'decision' }))[0]!;
    expect(run.status).toBe('ok');
  });

  it('says so on the card of a question the model did not answer', async () => {
    const decide = decideWith({ model: 'm', answers: { is_bug: { type: 'noul', noul: 0.9 } } });
    const { t, tool } = await mount(decide);
    loadTriage(tool);
    await t.runners[0]!.trigger();
    const cards = $$(t.zones.output, 'dec-result');
    expect(cards.map((card) => card.dataset['kind'])).toEqual(['noul', 'none', 'none']);
    expect(textOf(cards[1]!, 'dec-none')).toBe('The model sent no answer for this question.');
    expect(cards[1]!.dataset['verdict']).toBe('review');
  });

  it('sends the text block as a string and key-value fields as an object', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    tool.applyState({
      prompt: `  ${TICKET}  `,
      settings: { stateMode: 'text', fields: FIELDS, questions: triage() },
    });
    await t.runners[0]!.trigger();
    expect(decide.mock.calls[0]![0].state).toBe(TICKET);

    tool.applyState({
      prompt: 'ignored in fields mode',
      settings: {
        stateMode: 'fields',
        fields: [...FIELDS, { key: '', value: '' }],
        questions: triage(),
      },
    });
    await t.runners[0]!.trigger();
    expect(decide.mock.calls[1]![0].state).toEqual({
      customer_tier: 'enterprise',
      ticket: TICKET,
    });
  });
});

describe('refusing before the run', () => {
  it('refuses an empty situation, then bad questions, and changes and books nothing', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Describe the situation first.');
    const prompt = $(t.zones.input, 'tool-prompt');
    expect(prompt.getAttribute('aria-invalid')).toBe('true');

    type(prompt, 'A ticket');
    expect(prompt.getAttribute('aria-invalid')).toBeNull();
    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Fix the questions first.');
    const name = $(t.zones.input, 'dec-name');
    const instructions = $(t.zones.input, 'dec-instructions');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(instructions.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);

    expect(decide).not.toHaveBeenCalled();
    expect(await t.core.history.query({ tool: 'decision' })).toEqual([]);

    type(name, 'Is it a bug?');
    expect(name.getAttribute('aria-invalid')).toBeNull();
    type(instructions, 'Is the customer reporting a defect?');
    await t.runners[0]!.trigger();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(tool.getState().prompt).toBe('A ticket');
  });

  it('refuses a request over the model’s context, saying how big it is', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    tool.applyState({
      prompt: 'x'.repeat(150_000),
      settings: { stateMode: 'text', questions: triage() },
    });
    await t.ctx.ui.refreshEstimate();
    expect(textOf(t.zones.input, 'dec-tokens')).toMatch(/^Input: about \d[\d,]* of 32,000 tokens$/);
    expect($(t.zones.input, 'dec-context-alert').hidden).toBe(false);

    await t.runners[0]!.trigger();
    expect(t.status()).toBe('Too long for this model.');
    expect(decide).not.toHaveBeenCalled();
    expect(await t.core.history.query({ tool: 'decision' })).toEqual([]);

    tool.applyState({ prompt: 'short', settings: { stateMode: 'text', questions: triage() } });
    await t.ctx.ui.refreshEstimate();
    expect($(t.zones.input, 'dec-context-alert').hidden).toBe(true);
    await t.runners[0]!.trigger();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('lets prose through that fits the context (the heavier JSON estimate is for the price only)', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    // About 22,500 tokens of text: it fits 32,000, though JSON of this size would not.
    tool.applyState({
      prompt: 'word '.repeat(18_000),
      settings: { stateMode: 'text', questions: triage() },
    });
    await t.ctx.ui.refreshEstimate();
    expect($(t.zones.input, 'dec-context-alert').hidden).toBe(true);
    await t.runners[0]!.trigger();
    expect(decide).toHaveBeenCalledTimes(1);
    // The price estimate stays high: it is billed by the models' own count.
    expect(t.estimate()).toBeGreaterThan(0.00003);
  });
});

describe('when the request fails', () => {
  it('keeps the answers on screen, records the failure, and offers a retry (429)', async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce(documentedResponse)
      .mockRejectedValueOnce(new RateLimitError('Rate limit exceeded'));
    const { t, tool } = await mount(decide as ReturnType<typeof decideWith>);
    loadTriage(tool);
    await t.runners[0]!.trigger();
    expect($$(t.zones.output, 'dec-result')).toHaveLength(3);

    await t.runners[0]!.trigger();
    expect(decide).toHaveBeenCalledTimes(2);
    // The earlier answers are still there, no longer dimmed.
    expect($$(t.zones.output, 'dec-result')).toHaveLength(3);
    expect($(t.zones.output, 'dec-results').hasAttribute('aria-busy')).toBe(false);
    expect(t.status()).toBe('Failed');
    const toast = $(document.body, 'error-toast');
    expect(toast.textContent).toContain('Rate limited');
    expect($(toast, 'toast-retry')).toBeTruthy();

    const statuses = (await t.core.history.query({ tool: 'decision' })).map((run) => run.status);
    expect(statuses.sort()).toEqual(['error', 'ok']);
  });
});

describe('when recording a paid answer fails', () => {
  it('keeps the answer as done: no Failed, no Retry (a retry would pay twice), the write failure is shown', async () => {
    const decide = decideWith(documentedResponse);
    const { t, tool } = await mount(decide);
    loadTriage(tool);
    const begin = t.core.runs.begin.bind(t.core.runs);
    const fail = vi.fn();
    vi.spyOn(t.core.runs, 'begin').mockImplementation(async (spec) => {
      const handle = await begin(spec);
      return {
        ...handle,
        finish: () => Promise.reject(new Error('the disk is full')),
        fail: (error: unknown) => {
          fail(error);
          return handle.fail(error);
        },
      };
    });
    await t.runners[0]!.trigger();
    expect(decide).toHaveBeenCalledTimes(1);
    expect($$(t.zones.output, 'dec-result')).toHaveLength(3);
    expect(t.status()).toBe('Done · 3 questions, 1 needs review');
    expect(fail).not.toHaveBeenCalled();
    const toast = $(document.body, 'error-toast');
    expect($$(toast, 'toast-retry')).toHaveLength(0);
  });
});

describe('answers belong to the question rows, not to what their ids happen to be', () => {
  const bugAnswer = (noul: number) => ({ model: 'm', answers: { bug: { type: 'noul', noul } } });

  /** One Yes/No question named Bug, typed in. */
  const typeBug = (t: ToolTestContext, tool: ToolInstance): void => {
    tool.applyState({ prompt: 'A ticket', settings: { stateMode: 'text', questions: [] } });
    $(t.zones.input, 'dec-add-question').click();
    type($(t.zones.input, 'dec-name'), 'Bug');
    type($(t.zones.input, 'dec-instructions'), 'Is it a bug?');
  };

  it('finds the answer of an id typed with a trailing space before the field lost focus', async () => {
    const decide = decideWith(bugAnswer(0.9));
    const { t, tool } = await mount(decide);
    typeBug(t, tool);
    const id = $(t.zones.input, 'dec-id') as HTMLInputElement;
    id.value = 'bug ';
    id.dispatchEvent(new Event('input', { bubbles: true }));
    await t.runners[0]!.trigger();
    expect(Object.keys(decide.mock.calls[0]![0].questions)).toEqual(['bug']);
    const card = $$(t.zones.output, 'dec-result')[0]!;
    expect(card.dataset['kind']).toBe('noul');
    expect(textOf(card, 'dec-yes-text')).toBe('Yes 90%');
  });

  it('re-labels a card whose question was renamed after the run', async () => {
    const { t, tool } = await mount(decideWith(bugAnswer(0.9)));
    typeBug(t, tool);
    await t.runners[0]!.trigger();
    const card = $$(t.zones.output, 'dec-result')[0]!;
    expect(card.dataset['verdict']).toBe('clear');
    type($(t.zones.input, 'dec-name'), 'Defect');
    expect(tool.getState().settings['questions']).toMatchObject([{ id: 'defect' }]);
    type($(t.zones.input, 'dec-threshold'), '95');
    expect(card.dataset['verdict']).toBe('review');
    expect(textOf(card, 'dec-threshold-text')).toBe('Threshold 95%');
  });

  it('applies a threshold edited while the request was in flight', async () => {
    let release: () => void = () => undefined;
    const decide = vi.fn(
      () =>
        new Promise<DecisionResponse>((resolve) => {
          release = () => resolve(documentedResponse as unknown as DecisionResponse);
        }),
    );
    const context = createToolTestContext(getTool('decision'), { catalog, api: { decide } });
    t = context;
    const tool = await context.mount(setup);
    loadTriage(tool);
    const running = context.runners[0]!.trigger();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    // 96% reaches 80% but not the 97% typed now.
    type($$(context.zones.input, 'dec-threshold')[0]!, '97');
    release();
    await running;
    const card = $$(context.zones.output, 'dec-result')[0]!;
    expect(card.dataset['verdict']).toBe('review');
    expect(textOf(card, 'dec-threshold-text')).toBe('Threshold 97%');
  });
});

describe('what the tool takes in', () => {
  it('accepts the text types it reads: Markdown, CSV, JSON, logs, YAML and plain text', () => {
    const { accepts } = getTool('decision');
    for (const name of [
      'a.txt',
      'notes.md',
      'data.csv',
      'x.json',
      'app.log',
      'ci.yaml',
      'ci.yml',
    ]) {
      expect(acceptsFile({ type: '', name }, accepts), name).toBe(true);
    }
    expect(acceptsFile({ type: 'text/markdown', name: 'x' }, accepts)).toBe(true);
    expect(acceptsFile({ type: 'application/json', name: 'x' }, accepts)).toBe(true);
    // What "Send to…" offers from OCR.
    expect(mimeMatches('text/markdown', accepts)).toBe(true);
    expect(acceptsFile({ type: 'image/png', name: 'x.png' }, accepts)).toBe(false);
    expect(acceptsFile({ type: 'application/pdf', name: 'x.pdf' }, accepts)).toBe(false);
  });
});

describe('Stop', () => {
  it('ends the run quietly, keeps the earlier answers and records it as aborted', async () => {
    let calls = 0;
    const decide = vi.fn(
      (_body: DecisionRequest, options: { run: { signal: AbortSignal } }) =>
        new Promise<DecisionResponse>((resolve, reject) => {
          calls += 1;
          if (calls === 1) {
            resolve(documentedResponse as unknown as DecisionResponse);
            return;
          }
          options.run.signal.addEventListener('abort', () =>
            reject(new DOMException('Stopped by the user.', 'AbortError')),
          );
        }),
    );
    const context = createToolTestContext(getTool('decision'), {
      catalog,
      api: { decide },
    });
    t = context;
    const tool = await context.mount(setup);
    loadTriage(tool);
    await context.runners[0]!.trigger();
    expect($$(context.zones.output, 'dec-result')).toHaveLength(3);

    const second = context.runners[0]!.trigger();
    await vi.waitFor(() => expect(decide).toHaveBeenCalledTimes(2));
    // While it waits the old answers are dimmed and marked busy.
    expect($(context.zones.output, 'dec-results').getAttribute('aria-busy')).toBe('true');
    context.runners[0]!.stop();
    await second;

    expect(context.status()).toBe('Stopped');
    expect($(context.zones.output, 'dec-results').hasAttribute('aria-busy')).toBe(false);
    expect($$(context.zones.output, 'dec-result')).toHaveLength(3);
    expect(document.querySelector('[data-testid="error-toast"]')).toBeNull();
    const statuses = (await context.core.history.query({ tool: 'decision' })).map((r) => r.status);
    expect(statuses.sort()).toEqual(['aborted', 'ok']);
  });
});

describe('the cost estimate', () => {
  it('is the input tokens at the model’s price, and nothing on the free model', async () => {
    const paid = await mount(decideWith(documentedResponse));
    loadTriage(paid.tool);
    await paid.t.ctx.ui.refreshEstimate();
    const estimate = paid.t.estimate();
    expect(estimate).toBeGreaterThan(0);
    // 32,000 tokens would cost $0.00134 at Jev's price; this request is a small fraction of that.
    expect(estimate).toBeLessThan(0.0005);
    await paid.t.cleanup();

    const free = await mount(decideWith(mercuryResponse), {
      modelOverride: 'inception/mercury-decide:free',
    });
    loadTriage(free.tool);
    await free.t.ctx.ui.refreshEstimate();
    expect(free.t.estimate()).toBe(0);
  });
});

describe('the library', () => {
  it('loads a template as a copy, without touching the situation', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    type($(t.zones.input, 'tool-prompt'), 'My own situation');
    const select = $(t.zones.input, 'dec-library') as HTMLSelectElement;
    select.value = 'template:content-review';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect($(t.zones.input, 'dec-delete').hidden).toBe(true);
    expect(textOf(t.zones.input, 'dec-library-describe')).toContain('3 questions');
    // Choosing alone changes nothing.
    expect($$(t.zones.input, 'dec-question')).toHaveLength(1);

    $(t.zones.input, 'dec-load').click();
    await vi.waitFor(() => expect($$(t.zones.input, 'dec-question')).toHaveLength(3));
    expect(tool.getState().prompt).toBe('My own situation');
    const names = ($$(t.zones.input, 'dec-name') as HTMLInputElement[]).map((n) => n.value);
    expect(names).toEqual(['Breaks the rules?', 'Main concern', 'Severity']);
    // Editing the loaded questions does not change the template for the next load.
    type($$(t.zones.input, 'dec-name')[0]!, 'Edited');
    expect(templateQuestions('content-review')![0]!.name).toBe('Breaks the rules?');
  });

  it('loads a template at the starting threshold from the drawer, and the sample too', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    t.ctx.options.set({ threshold: 65 });
    const select = $(t.zones.input, 'dec-library') as HTMLSelectElement;
    select.value = 'template:ticket-triage';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    $(t.zones.input, 'dec-load').click();
    await vi.waitFor(() => expect($$(t.zones.input, 'dec-question')).toHaveLength(3));
    expect(
      $$(t.zones.input, 'dec-threshold').map((input) => (input as HTMLInputElement).value),
    ).toEqual(['65', '65', '65']);
    await tool.sample?.();
    await vi.waitFor(() =>
      expect(
        $$(t.zones.input, 'dec-threshold').map((input) => (input as HTMLInputElement).value),
      ).toEqual(['65', '65', '65']),
    );
  });

  it('lists saved deciders from storage, loads one with its situation, and undoes a delete', async () => {
    const { t, tool } = await mount(decideWith(documentedResponse));
    const saved: SavedDecider = {
      id: newDeciderId(),
      name: 'Support tickets',
      questions: triage(),
      state: { mode: 'fields', text: '', fields: FIELDS },
      savedAt: 1_750_000_000_000,
    };
    await t.ctx.state.set(`decider:${saved.id}`, saved);
    const select = $(t.zones.input, 'dec-library') as HTMLSelectElement;
    await vi.waitFor(() =>
      expect([...select.options].map((option) => option.textContent)).toContain('Support tickets'),
    );

    select.value = `saved:${saved.id}`;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect($(t.zones.input, 'dec-delete').hidden).toBe(false);
    expect($(t.zones.input, 'dec-rename').hidden).toBe(false);
    expect(textOf(t.zones.input, 'dec-library-describe')).toContain('includes the situation');
    $(t.zones.input, 'dec-load').click();
    await vi.waitFor(() => expect($$(t.zones.input, 'dec-question')).toHaveLength(3));
    expect(tool.getState().settings['stateMode']).toBe('fields');
    expect(tool.getState().settings['fields']).toEqual(FIELDS);

    // Delete, then Undo brings back the same record.
    $(t.zones.input, 'dec-delete').click();
    await vi.waitFor(async () =>
      expect(await t.ctx.state.get(`decider:${saved.id}`)).toBeUndefined(),
    );
    await vi.waitFor(() =>
      expect([...select.options].map((option) => option.textContent)).not.toContain(
        'Support tickets',
      ),
    );
    $(document.body, 'dec-undo').click();
    await vi.waitFor(async () =>
      expect(await t.ctx.state.get(`decider:${saved.id}`)).toEqual(saved),
    );
    await vi.waitFor(() =>
      expect([...select.options].map((option) => option.textContent)).toContain('Support tickets'),
    );
    expect(select.value).toBe(`saved:${saved.id}`);
  });
  it('renames what is stored, keeping a save another tab made since the list was read', async () => {
    const { t } = await mount(decideWith(documentedResponse));
    const saved: SavedDecider = {
      id: newDeciderId(),
      name: 'Support tickets',
      questions: triage(),
      state: null,
      savedAt: 1_750_000_000_000,
    };
    await t.ctx.state.set(`decider:${saved.id}`, saved);
    const select = $(t.zones.input, 'dec-library') as HTMLSelectElement;
    await vi.waitFor(() =>
      expect([...select.options].map((option) => option.textContent)).toContain('Support tickets'),
    );
    select.value = `saved:${saved.id}`;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    // Another tab saved other questions under the same id, and this one was not told.
    const fresh = { ...saved, questions: triage().slice(0, 1) };
    await (
      await getDb()
    ).put('kv', { key: `tool:decision:decider:${saved.id}`, value: fresh, updatedAt: Date.now() });
    vi.mocked(promptDialog).mockResolvedValue('Renamed');
    $(t.zones.input, 'dec-rename').click();
    await vi.waitFor(async () => {
      const stored = await t.ctx.state.get<SavedDecider>(`decider:${saved.id}`);
      expect(stored?.name).toBe('Renamed');
      expect(stored?.questions).toHaveLength(1);
    });
  });
});
