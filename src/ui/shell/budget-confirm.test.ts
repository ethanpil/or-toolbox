import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetCheck, BudgetQuestion, RunSpec } from '../../core/types';
import { budgetConfirm } from './budget-confirm';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('./leave-guard', () => ({ guardedNavigate: navigate }));
vi.mock('../../core/index', () => ({ getCore: () => ({}) }));

const $ = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const shown = () =>
  vi.waitFor(() => expect($('budget-dialog')?.contains(document.activeElement)).toBe(true));
const gone = () => vi.waitFor(() => expect($('budget-dialog')).toBeNull());

const check: BudgetCheck = {
  verdict: 'confirm',
  reasons: [{ kind: 'monthly', limitUsd: 5, projectedUsd: 6, message: 'Over the monthly limit.' }],
};
const run = (spec: Partial<RunSpec> = {}): BudgetQuestion => ({
  kind: 'run',
  spec: { tool: 'model-arena', model: 'openai/gpt-6.1-sol', estimateUsd: 0.5, ...spec },
});

afterEach(() => {
  document.body.replaceChildren();
  navigate.mockClear();
});

describe('budgetConfirm', () => {
  it('asks about one run: its estimate, tool and model', async () => {
    const answer = budgetConfirm(check, run());
    await shown();
    expect($('budget-dialog')?.textContent).toContain('Confirm this run');
    expect($('budget-estimate')?.textContent).toBe('≈ $0.50');
    expect($('budget-models')?.textContent).toBe('openai/gpt-6.1-sol');
    expect($('budget-group')).toBeNull();
    $('budget-confirm')!.click();
    await expect(answer).resolves.toBe(true);
  });

  it('asks every run of one group for itself (a group shares one question only through approveGroup)', async () => {
    const first = budgetConfirm(check, run({ groupId: 'g1', estimateUsd: 0.5 }));
    const second = budgetConfirm(check, run({ groupId: 'g1', estimateUsd: 0.9 }));
    await shown();
    expect($('budget-estimate')?.textContent).toBe('≈ $0.50');
    $('budget-cancel')!.click();
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect($('budget-estimate')?.textContent).toBe('≈ $0.90'));
    await shown();
    $('budget-confirm')!.click();
    await expect(second).resolves.toBe(true);
  });

  it('asks about a group once, by its label, with its models and its total', async () => {
    const answer = budgetConfirm(check, {
      kind: 'group',
      group: {
        tool: 'model-arena',
        groupId: 'round-1',
        label: 'Model arena round: 3 models',
        models: ['a/one', 'b/two', 'c/three'],
        runs: 3,
        estimateUsd: 0.3,
        addons: [{ id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR', estimateUsd: 0.06 }],
        note: 'Each model reserves its own part.',
      },
    });
    await shown();
    expect($('budget-dialog')?.textContent).toContain('Confirm these runs');
    expect($('budget-group')?.textContent).toContain('Model arena round: 3 models');
    expect($('budget-group')?.textContent).toContain('3 runs, asked once for all of them');
    expect($('budget-estimate')?.textContent).toContain('≈ $0.36');
    expect($('budget-estimate')?.textContent).toContain('Includes Mistral OCR');
    expect([...$('budget-models')!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'a/one',
      'b/two',
      'c/three',
    ]);
    expect($('budget-note')?.textContent).toBe('Each model reserves its own part.');
    $('budget-cancel')!.click();
    await expect(answer).resolves.toBe(false);
    await gone();
  });

  it('shows the estimate with paid add-ons included', async () => {
    const answer = budgetConfirm(
      check,
      run({
        addons: [
          { id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR (PDF parser)', estimateUsd: 0.25 },
        ],
      }),
    );
    await shown();
    expect($('budget-estimate')?.textContent).toContain('$0.75');
    expect($('budget-estimate')?.textContent).toContain('Includes Mistral OCR (PDF parser)');
    $('budget-cancel')!.click();
    await answer;
  });

  it('declines before following the budgets link', async () => {
    const answer = budgetConfirm(check, run());
    await shown();
    $('budget-dialog')!.querySelector('a')!.click();
    await expect(answer).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled(); // runs.begin sees the "no" first
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(expect.anything(), '/or-toolbox/settings/#budgets'),
    );
  });
});
