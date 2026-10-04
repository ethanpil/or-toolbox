/**
 * Stage 7 gate, Decision: "Decision handles each question type". The ticket triage questions (a Yes/No, a Choice
 * and a Score) go to the mocked decisions endpoint and come back as Jev's documented answer, Mercury Decide's
 * recorded one with its long floats, and a thin one with no confidence or cost. The specs cover the builder
 * (key-value state sent as the tutorial request, drag and Move buttons for the scale), thresholds that re-label
 * without a new run, saved deciders (save, reload, load, rename, delete with Undo), templates, the 429 path,
 * History and "Reopen", the Prompts round trip, free-only mode, and 320 px with the keyboard only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../mock/index.ts';
import { seedApp, tabTo } from './app.ts';
import { expectNoSeriousA11yViolations, watchForProblems } from './support.ts';

const DECISIONS = '/api/alpha/decisions';
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'openrouter');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

interface Request {
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
}
const DOCUMENTED_REQUEST = fixture<Request>('decisions-request.documented.json');
const JEV = fixture<Record<string, unknown>>('decisions-response.documented.json');
const MERCURY = fixture<Record<string, unknown>>('decisions-response.recorded.json');
const MODELS = fixture<{ data: { id: string }[] }>('models.json').data.filter(
  (model) => model.id === 'typesafe/jev-1.13' || model.id === 'inception/mercury-decide:free',
);

const TICKET =
  'My checkout page shows a blank screen after I click Pay. I have tried two browsers.';

/** A test annotated with this one starts in free-only mode. */
const FREE_ONLY = { type: 'free-only', description: 'starts with free-only mode on' };

test.beforeEach(async ({ context, mock }, testInfo) => {
  const freeOnly = testInfo.annotations.some((note) => note.type === FREE_ONLY.type);
  await seedApp(context, { key: true, settings: freeOnly ? { freeOnly: true } : {} });
  mock.json('GET', '/api/v1/models', { data: MODELS });
});

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`tools/decision/${query}`);
  await expect(page.getByTestId('page-title')).toHaveText('Decision');
  await expect(page.getByTestId('dec-library')).toBeVisible();
}

async function loadTemplate(page: Page, id: string): Promise<void> {
  await page.getByTestId('dec-library').selectOption(`template:${id}`);
  await page.getByTestId('dec-load').click();
}

const cards = (page: Page) => page.getByTestId('dec-result');
const run_button = (page: Page) => page.getByTestId('run-button');
const run = (page: Page) => run_button(page).click();

/** Ticket triage with the ticket typed in, answered by `response`. */
async function runTriage(page: Page): Promise<void> {
  await loadTemplate(page, 'ticket-triage');
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  await page.getByTestId('tool-prompt').fill(TICKET);
  await run(page);
  await expect(cards(page)).toHaveCount(3);
}

test('one run with all three question types: a request for each and a card for each answer', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page);
  await runTriage(page);

  // One request carries all three questions, exactly as the tutorial shows them.
  expect(mock.calls(DECISIONS)).toHaveLength(1);
  expect(mock.calls(DECISIONS)[0]!.body).toEqual({
    model: 'typesafe/jev-1.13',
    state: TICKET,
    questions: DOCUMENTED_REQUEST.questions,
  });

  // Yes/No: a probability meter with its numbers as text.
  const [yesNo, choice, score] = [cards(page).nth(0), cards(page).nth(1), cards(page).nth(2)];
  await expect(yesNo.getByTestId('dec-yes-text')).toHaveText('Yes 96%');
  await expect(yesNo.getByTestId('dec-no-text')).toHaveText('No 4%');
  await expect(yesNo.getByTestId('dec-verdict')).toHaveText('Clear');
  await expect(yesNo.getByTestId('dec-confidence')).toContainText('Confidence 96%');
  await expect(yesNo.getByTestId('dec-threshold-text')).toHaveText('Threshold 80%');

  // Choice: a bar per option, highest first, the chosen one marked, 67% confidence is short of 80%.
  const options = choice.getByTestId('dec-option-result');
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('data-option', 'payments');
  await expect(options.nth(0)).toHaveAttribute('data-chosen', 'true');
  await expect(options.nth(0)).toContainText('Chosen');
  await expect(choice.getByTestId('dec-option-percent')).toHaveText(['78%', '22%', '0%']);
  await expect(choice.getByTestId('dec-verdict')).toHaveText('Needs review');

  // Score: the marker's value as text and every level's probability listed.
  await expect(score.getByTestId('dec-score-text')).toHaveText('Score 1.99');
  await expect(score.getByTestId('dec-level-percent')).toHaveText(['0%', '0%', '100%']);
  await expect(score.locator('.or-dec-tick')).toHaveCount(3);
  await expect(score.locator('.or-dec-marker')).toContainText('1.99');
  await expect(page.getByTestId('dec-summary')).toHaveText('3 questions answered · 1 needs review');
  await expect(page.getByTestId('dec-meta')).toContainText('typesafe/jev-1.13-20260917');
  await expect(page.getByTestId('dec-cost')).toHaveText('Cost <$0.0001');
  await expect(page.getByTestId('tool-status')).toContainText('Done');

  // Readable in both themes, with the cards on screen.
  await expectNoSeriousA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('key-value fields are sent as the object of the tutorial request', async ({ page, mock }) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await open(page);
  await page.locator('label', { hasText: 'Key-value fields' }).click();
  await expect(page.getByTestId('tool-prompt')).toBeHidden();
  await page.getByTestId('dec-field-key').nth(0).fill('customer_tier');
  await page.getByTestId('dec-field-value').nth(0).fill('enterprise');
  await page.getByTestId('dec-add-field').click();
  await expect(page.getByTestId('dec-field-key').nth(1)).toBeFocused();
  await page.keyboard.type('ticket');
  await page.getByTestId('dec-field-value').nth(1).fill(TICKET);
  await loadTemplate(page, 'ticket-triage');
  await run(page);
  await expect(cards(page)).toHaveCount(3);

  expect(mock.calls(DECISIONS)[0]!.body).toEqual(DOCUMENTED_REQUEST);
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});

test('Mercury Decide’s long floats are shown to a tenth of a percent, cut not rounded', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, MERCURY);
  await open(page, '?model=inception/mercury-decide:free');
  await runTriage(page);

  expect(mock.calls(DECISIONS)[0]!.body).toMatchObject({ model: 'inception/mercury-decide:free' });
  await expect(cards(page).nth(0).getByTestId('dec-yes-text')).toHaveText('Yes 99.9%');
  await expect(cards(page).nth(0).getByTestId('dec-no-text')).toHaveText('No <0.1%');
  await expect(cards(page).nth(1).getByTestId('dec-option-percent')).toHaveText([
    '89.2%',
    '10.6%',
    '<0.1%',
  ]);
  await expect(cards(page).nth(1).getByTestId('dec-confidence')).toHaveText('Confidence 83.9%');
  await expect(cards(page).nth(2).getByTestId('dec-score-text')).toHaveText('Score 2');
  await expect(page.getByTestId('dec-summary')).toHaveText('3 questions answered · all clear');
  await expect(page.getByTestId('dec-cost')).toHaveText('Cost: free');
  expect(problems).toEqual([]);
});

test('a thin response with no confidence or cost still shows what it has', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, {
    id: 'gen-dec-thin',
    model: 'typesafe/jev-1.13-20260917',
    answers: {
      is_bug: { type: 'noul', noul: 0.7 },
      team: { type: 'choice', choice: 'frontend', probabilities: { payments: 0.3, frontend: 0.7 } },
      urgency: { type: 'score', score: 0.2, unexpected: { nested: [1] } },
    },
  });
  await open(page);
  await runTriage(page);
  await expect(cards(page).nth(1).getByTestId('dec-confidence')).toHaveText(
    'Confidence 70% (the highest probability)',
  );
  await expect(cards(page).nth(2).getByTestId('dec-confidence')).toHaveText(
    'Confidence not reported',
  );
  await expect(cards(page).getByTestId('dec-verdict')).toHaveText([
    'Needs review',
    'Needs review',
    'Needs review',
  ]);
  await expect(page.getByTestId('dec-cost')).toHaveText('Cost not reported');
  expect(problems).toEqual([]);
});

test('changing a threshold after a run re-labels the answers without asking again', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await open(page);
  await runTriage(page);
  const thresholds = page.getByTestId('dec-threshold');
  const verdicts = cards(page).getByTestId('dec-verdict');
  await expect(verdicts).toHaveText(['Clear', 'Needs review', 'Clear']);

  // 96% no longer reaches 97%; 67% now reaches 60%.
  await thresholds.nth(0).fill('97');
  await thresholds.nth(1).fill('60');
  await expect(verdicts).toHaveText(['Needs review', 'Clear', 'Clear']);
  await expect(cards(page).nth(0).getByTestId('dec-threshold-text')).toHaveText('Threshold 97%');
  await expect(page.getByTestId('dec-summary')).toHaveText('3 questions answered · 1 needs review');
  // Exactly at the threshold is clear.
  await thresholds.nth(0).fill('96');
  await expect(verdicts.nth(0)).toHaveText('Clear');
  await expect(page.getByTestId('dec-summary')).toHaveText('3 questions answered · all clear');

  expect(mock.calls(DECISIONS)).toHaveLength(1);
  expect(problems).toEqual([]);
});

test('the run is refused before it starts while anything is invalid', async ({ page, mock }) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await open(page);
  await run(page);
  await expect(page.getByTestId('tool-prompt')).toBeFocused();
  await expect(page.getByTestId('tool-prompt')).toHaveAttribute('aria-invalid', 'true');

  await page.getByTestId('tool-prompt').fill(TICKET);
  await expect(page.getByTestId('tool-prompt')).not.toHaveAttribute('aria-invalid', 'true');
  await run(page);
  await expect(page.getByTestId('dec-name')).toBeFocused();
  await expect(page.getByTestId('dec-name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByTestId('dec-instructions')).toHaveAttribute('aria-invalid', 'true');

  // A Choice needs two options.
  await page.getByTestId('dec-name').fill('Team');
  await page.getByTestId('dec-instructions').fill('Which team?');
  await page.getByTestId('dec-type').selectOption('choice');
  await run(page);
  await expect(page.getByTestId('dec-option-name').first()).toBeFocused();
  await page.getByTestId('dec-option-name').nth(0).fill('payments');
  await page.getByTestId('dec-option-name').nth(1).fill('Payments');
  await expect(page.getByTestId('dec-question')).toContainText('already called');
  await page.getByTestId('dec-option-name').nth(1).fill('frontend');

  expect(mock.calls(DECISIONS)).toHaveLength(0);
  await run(page);
  await expect(cards(page)).toHaveCount(1);
  expect(mock.calls(DECISIONS)).toHaveLength(1);
  expect(mock.calls(DECISIONS)[0]!.body).toMatchObject({
    state: TICKET,
    questions: { team: { type: 'choice', criteria: { payments: null, frontend: null } } },
  });
  expect(problems).toEqual([]);
});

test('a Score scale is reordered by dragging, by buttons and by keyboard', async ({ page }) => {
  const problems = await watchForProblems(page);
  await open(page);
  await page.getByTestId('dec-type').selectOption('score');
  const texts = page.getByTestId('dec-level-text');
  await page.getByTestId('dec-add-level').click();
  await expect(texts).toHaveCount(3);
  for (const [index, text] of ['Low', 'Medium', 'High'].entries()) {
    await texts.nth(index).fill(text);
  }
  const order = async (): Promise<string[]> =>
    texts.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
  expect(await order()).toEqual(['Low', 'Medium', 'High']);

  // Drag the last level onto the upper half of the first.
  const handles = page.getByTestId('dec-level-handle');
  await handles.nth(2).dragTo(page.getByTestId('dec-level').nth(0), {
    targetPosition: { x: 40, y: 2 },
  });
  await expect.poll(order).toEqual(['High', 'Low', 'Medium']);

  // A button: Move level 2 up swaps the last two.
  await page.getByRole('button', { name: /^Move level 2 of .* up$/ }).click();
  await expect.poll(order).toEqual(['High', 'Medium', 'Low']);

  // Keyboard: Tab to Move down of level 0, press Enter; focus stays on the moved level's button.
  await page.getByRole('button', { name: /^Move level 0 of .* down$/ }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['Medium', 'High', 'Low']);
  await expect(page.getByRole('button', { name: /^Move level 1 of .* down$/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(order).toEqual(['Medium', 'Low', 'High']);
  // The end of the line: the button that was pressed is disabled now, focus goes to its twin.
  await expect(page.getByRole('button', { name: /^Move level 2 of .* up$/ })).toBeFocused();
  expect(problems).toEqual([]);
});

test('saved deciders: save, reload, load, rename, delete with Undo', async ({ page }) => {
  test.slow();
  const problems = await watchForProblems(page);
  await open(page);
  await loadTemplate(page, 'ticket-triage');
  await page.getByTestId('tool-prompt').fill(TICKET);

  // Save the questions with the situation.
  await page.getByTestId('dec-save').click();
  const dialog = page.getByTestId('dec-save-dialog');
  await dialog.getByTestId('dec-save-name').fill('Support tickets');
  await dialog.getByTestId('dec-save-with-state').check();
  await dialog.getByTestId('dialog-confirm').click();
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Saved “Support tickets”.' }),
  ).toBeVisible();
  const library = page.getByTestId('dec-library');
  await expect(library.locator('option', { hasText: 'Support tickets' })).toHaveCount(1);
  await expect(page.getByTestId('dec-delete')).toBeVisible();

  // Saving again under the same name asks before replacing.
  await page.getByTestId('dec-save').click();
  await page.getByTestId('dec-save-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('Replace “Support tickets”?');
  await page.getByTestId('confirm-dialog').getByTestId('dialog-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // A fresh page has it (stored in the browser), and loading restores questions and situation.
  await page.reload();
  await expect(page.getByTestId('dec-question')).toHaveCount(1);
  await expect(page.getByTestId('tool-prompt')).toHaveValue('');
  await library.selectOption({ label: 'Support tickets' });
  await expect(page.getByTestId('dec-library-describe')).toContainText('includes the situation');
  await page.getByTestId('dec-load').click();
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  await expect(page.getByTestId('tool-prompt')).toHaveValue(TICKET);

  // Rename.
  await page.getByTestId('dec-rename').click();
  await page.getByTestId('prompt-input').fill('Triage');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(library.locator('option', { hasText: /^Triage$/ })).toHaveCount(1);
  await expect(library.locator('option', { hasText: 'Support tickets' })).toHaveCount(0);

  // Delete, then Undo puts the same decider back and selects it.
  await page.getByTestId('dec-delete').click();
  await expect(library.locator('option', { hasText: /^Triage$/ })).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'Deleted “Triage”.' })).toBeVisible();
  await page.getByTestId('dec-undo').click();
  await expect(library.locator('option', { hasText: /^Triage$/ })).toHaveCount(1);
  await expect(page.getByTestId('dec-rename')).toBeVisible();
  expect(
    await library.evaluate(
      (select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent,
    ),
  ).toBe('Triage');

  // Delete for good: it stays gone after a reload.
  await page.getByTestId('dec-delete').click();
  await expect(library.locator('option', { hasText: /^Triage$/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('dec-library')).toBeVisible();
  await expect(library.locator('option', { hasText: /^Triage$/ })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('templates load as copies; loading over edited questions asks first', async ({ page }) => {
  const problems = await watchForProblems(page);
  await open(page);
  const names = page.getByTestId('dec-name');
  const values = (): Promise<string[]> =>
    names.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));

  // Choosing is not loading.
  await page.getByTestId('dec-library').selectOption('template:content-review');
  await expect(page.getByTestId('dec-library-describe')).toContainText(
    'Does a post break the rules',
  );
  await expect(page.getByTestId('dec-delete')).toBeHidden();
  await expect(page.getByTestId('dec-question')).toHaveCount(1);
  // The untouched starting question is replaced without asking.
  await page.getByTestId('dec-load').click();
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  expect(await values()).toEqual(['Breaks the rules?', 'Main concern', 'Severity']);

  // Edit one, then load another: Cancel keeps the edit, Replace takes the new set.
  await names.nth(0).fill('Edited name');
  await page.getByTestId('dec-library').selectOption('template:approve-escalate');
  await page.getByTestId('dec-load').click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Replace your questions?');
  await confirm.getByTestId('dialog-cancel').click();
  await expect(confirm).toHaveCount(0);
  expect((await values())[0]).toBe('Edited name');
  await page.getByTestId('dec-load').click();
  await confirm.getByTestId('dialog-confirm').click();
  await expect.poll(values).toEqual(['Approve as is?', 'Next step', 'Risk']);

  // The template itself was never changed.
  await page.getByTestId('dec-library').selectOption('template:content-review');
  await page.getByTestId('dec-load').click();
  await expect.poll(values).toEqual(['Breaks the rules?', 'Main concern', 'Severity']);
  expect(problems).toEqual([]);
});

test('a 429 shows a rate-limit notice with Retry and keeps the form; Retry then works', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  // A long wait is not retried by the client, so the error surfaces at once.
  mock.error(DECISIONS, 429, {
    error: {
      code: 429,
      message: 'Rate limit exceeded',
      metadata: { error_type: 'rate_limit_exceeded', retry_after_seconds: 600 },
    },
  });
  await open(page);
  await loadTemplate(page, 'ticket-triage');
  await page.getByTestId('tool-prompt').fill(TICKET);
  await run(page);

  const notice = page.getByTestId('error-toast');
  await expect(notice).toContainText('Rate limited');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByTestId('tool-prompt')).toHaveValue(TICKET);
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  expect(mock.calls(DECISIONS)).toHaveLength(1);

  mock.json('POST', DECISIONS, JEV);
  await notice.getByTestId('toast-retry').click();
  await expect(cards(page)).toHaveCount(3);
  expect(mock.calls(DECISIONS)).toHaveLength(2);
  // The only problems are the 429 itself, as the browser reports it.
  expect(problems.filter((problem) => !problem.includes('429'))).toEqual([]);
});

test('Stop ends a run quietly and keeps the answers that were on screen', async ({
  page,
  mock,
}) => {
  // Stopping cancels the request in flight; that abort is the app's doing, not a problem.
  const problems = await watchForProblems(page, { allowAborted: [DECISIONS] });
  mock.json('POST', DECISIONS, JEV);
  await open(page);
  await runTriage(page);

  mock.json('POST', DECISIONS, MERCURY, { delayMs: 20_000 });
  await run(page);
  await expect(page.getByTestId('stop-button')).toBeVisible();
  await expect(page.getByTestId('dec-results')).toHaveAttribute('aria-busy', 'true');
  await page.getByTestId('stop-button').click();

  await expect(page.getByTestId('tool-status')).toContainText('Stopped');
  await expect(page.getByTestId('dec-results')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('error-toast')).toHaveCount(0);
  // The first run's answers are still the ones shown.
  await expect(cards(page).nth(0).getByTestId('dec-yes-text')).toHaveText('Yes 96%');
  await expect(run_button(page)).toBeEnabled();
  expect(problems).toEqual([]);
});

test('History keeps the answers as pretty JSON, and Reopen restores the whole form', async ({
  page,
  mock,
}) => {
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await open(page);
  await page.locator('label', { hasText: 'Key-value fields' }).click();
  await page.getByTestId('dec-field-key').nth(0).fill('customer_tier');
  await page.getByTestId('dec-field-value').nth(0).fill('enterprise');
  await page.getByTestId('dec-add-field').click();
  await page.getByTestId('dec-field-key').nth(1).fill('ticket');
  await page.getByTestId('dec-field-value').nth(1).fill(TICKET);
  await loadTemplate(page, 'ticket-triage');
  await page.getByTestId('dec-threshold').nth(1).fill('65');
  await run(page);
  await expect(cards(page)).toHaveCount(3);

  await page.goto('history/?tool=decision');
  await expect(page.getByTestId('history-row')).toHaveCount(1);
  await expect(page.getByTestId('run-title')).toHaveText(
    'Decide: Is it a bug?, Owning team, Urgency',
  );
  await page.getByTestId('run-open').click();
  const output = page.getByTestId('run-output');
  await expect(output).toContainText('"is_bug"');
  await expect(output).toContainText('"probabilities"');
  // Indented for reading, not one line.
  expect(((await output.textContent()) ?? '').split('\n').length).toBeGreaterThan(10);

  await page.getByTestId('run-reopen').click();
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  await expect(page.getByTestId('dec-mode-fields')).toBeChecked();
  await expect(page.getByTestId('dec-field-key')).toHaveCount(2);
  await expect(page.getByTestId('dec-field-value').nth(1)).toHaveValue(TICKET);
  await expect(page.getByTestId('dec-threshold').nth(1)).toHaveValue('65');
  await expect(page.getByTestId('dec-name').nth(2)).toHaveValue('Urgency');
  await expect(page.getByTestId('dec-level-text')).toHaveCount(3);
  expect(problems).toEqual([]);
});

test('the Prompts panel saves the whole form and Use restores it', async ({ page }) => {
  test.slow();
  const problems = await watchForProblems(page);
  await open(page);
  await loadTemplate(page, 'ticket-triage');
  await page.getByTestId('tool-prompt').fill(TICKET);
  await page.getByTestId('dec-threshold').nth(0).fill('72');

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-save-current').click();
  await page.getByTestId('prompt-input').fill('Triage form');
  await page.getByTestId('prompt-dialog').getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('prompts-saved').getByTestId('prompt-entry')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('prompts-panel')).toBeHidden();

  // Change the form every way it can change, then Use the saved prompt.
  await page.getByTestId('tool-prompt').fill('Something else entirely');
  await page.getByTestId('dec-threshold').nth(0).fill('50');
  await page.getByTestId('dec-question-remove').nth(2).click();
  await page.getByTestId('dec-question-remove').nth(1).click();
  await page.locator('label', { hasText: 'Key-value fields' }).click();
  await expect(page.getByTestId('dec-question')).toHaveCount(1);

  await page.getByTestId('prompts-button').click();
  await page.getByTestId('prompts-tab-saved').click();
  await page.getByTestId('prompts-saved').getByTestId('prompt-use').click();
  await expect(page.getByTestId('prompts-panel')).toBeHidden();
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  await expect(page.getByTestId('dec-mode-text')).toBeChecked();
  await expect(page.getByTestId('tool-prompt')).toHaveValue(TICKET);
  await expect(page.getByTestId('dec-threshold').nth(0)).toHaveValue('72');
  expect(problems).toEqual([]);
});

test('the onboarding sample fills the situation and the ticket triage questions', async ({
  page,
}) => {
  const problems = await watchForProblems(page);
  await page.goto('tools/decision/?sample=1');
  await expect(page.getByTestId('tool-prompt')).not.toHaveValue('');
  await expect(page.getByTestId('dec-question')).toHaveCount(3);
  await expect(page).toHaveURL(/\/tools\/decision\/$/);
  expect(problems).toEqual([]);
});

test(
  'free-only mode uses Mercury Decide, and the model picker says which models are verified',
  { annotation: FREE_ONLY },
  async ({ page, mock }) => {
    const problems = await watchForProblems(page);
    mock.json('POST', DECISIONS, MERCURY);
    await open(page);
    await expect(page.getByTestId('model-chip-name')).toHaveText('inception/mercury-decide:free');
    await page.getByTestId('model-chip').click();
    await expect(page.getByTestId('model-picker-help')).toContainText(
      'Jev and Mercury Decide are the only models verified',
    );
    await page.getByTestId('model-picker').getByRole('button', { name: 'Cancel' }).click();

    await runTriage(page);
    expect(mock.calls(DECISIONS)[0]!.body).toMatchObject({
      model: 'inception/mercury-decide:free',
    });
    expect(problems).toEqual([]);
  },
);

test('at 320 px the whole flow works with the keyboard alone, without sideways scrolling', async ({
  page,
  mock,
}) => {
  test.slow();
  const problems = await watchForProblems(page);
  mock.json('POST', DECISIONS, JEV);
  await page.setViewportSize({ width: 320, height: 720 });
  await open(page);

  await tabTo(page, 'tool-prompt', 80);
  await page.keyboard.type(TICKET);
  await tabTo(page, 'dec-library');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('dec-library')).toHaveValue('template:ticket-triage');
  await tabTo(page, 'dec-load');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dec-question')).toHaveCount(3);

  await page.keyboard.press('Control+Enter');
  await expect(cards(page)).toHaveCount(3);
  await expect(page.getByTestId('dec-summary')).toHaveText('3 questions answered · 1 needs review');

  // A threshold, typed in its field, re-labels the card.
  await tabTo(page, 'dec-threshold');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('97');
  await expect(cards(page).nth(0).getByTestId('dec-verdict')).toHaveText('Needs review');

  // A level moves with its button.
  await page.getByTestId('dec-level-text').nth(0).focus();
  await tabTo(page, 'dec-level-down');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dec-level-text').nth(0)).toHaveValue('Should be fixed this week');

  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>('main *')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .map((el) => `${el.tagName}.${el.className}`)
      .slice(0, 5),
  }));
  expect(overflow).toEqual({ page: 0, wide: [] });
  await expectNoSeriousA11yViolations(page);
  expect(problems).toEqual([]);
});
