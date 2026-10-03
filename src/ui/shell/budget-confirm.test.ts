import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetCheck, RunSpec } from '../../core/types';
import { budgetConfirm } from './budget-confirm';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('./leave-guard', () => ({ guardedNavigate: navigate }));
vi.mock('../../core/index', () => ({ getCore: () => ({}) }));

const $ = (testId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const shown = () =>
  vi.waitFor(() => expect($('budget-dialog')?.contains(document.activeElement)).toBe(true));

const check: BudgetCheck = {
  verdict: 'confirm',
  reasons: [{ kind: 'monthly', limitUsd: 5, projectedUsd: 6, message: 'Over the monthly limit.' }],
};
const spec = (groupId?: string): RunSpec => ({
  tool: 'model-arena',
  model: 'openai/gpt-6.1-sol',
  estimateUsd: 0.5,
  ...(groupId ? { groupId } : {}),
});

afterEach(() => {
  document.body.replaceChildren();
  navigate.mockClear();
});

describe('budgetConfirm', () => {
  it('asks once for parallel runs of one group, and again for the next group', async () => {
    const answers = [budgetConfirm(check, spec('g1')), budgetConfirm(check, spec('g1'))];
    await shown();
    expect(document.querySelectorAll('[data-testid="budget-dialog"]')).toHaveLength(1);
    $('budget-confirm')!.click();
    await expect(Promise.all(answers)).resolves.toEqual([true, true]);

    const next = budgetConfirm(check, spec('g1'));
    await shown();
    $('budget-cancel')!.click();
    await expect(next).resolves.toBe(false);
  });

  it('shows the estimate with paid add-ons included', async () => {
    const answer = budgetConfirm(check, {
      ...spec(),
      addons: [
        { id: 'pdf-engine:mistral-ocr', label: 'Mistral OCR (PDF parser)', estimateUsd: 0.25 },
      ],
    });
    await shown();
    expect($('budget-estimate')?.textContent).toContain('$0.75');
    expect($('budget-estimate')?.textContent).toContain('Includes Mistral OCR (PDF parser)');
    $('budget-cancel')!.click();
    await answer;
  });

  it('declines before following the budgets link', async () => {
    const answer = budgetConfirm(check, spec());
    await shown();
    $('budget-dialog')!.querySelector('a')!.click();
    await expect(answer).resolves.toBe(false);
    expect(navigate).not.toHaveBeenCalled(); // runs.begin sees the "no" first
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(expect.anything(), '/or-toolbox/settings/#budgets'),
    );
  });
});
