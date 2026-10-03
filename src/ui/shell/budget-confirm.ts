/**
 * The budget confirmation every page registers with `runs.setConfirmHandler`: when a run's estimate or the
 * month's spend crosses a Warn-mode rule (or the per-run threshold in Hard-stop mode), `runs.begin` asks here
 * before anything is sent. Cancel makes `begin` throw RunCancelledError, which tools and `presentError` treat
 * as a quiet stop.
 */
import type { BudgetCheck, BudgetReason, RunSpec } from '../../core/types';
import { getTool } from '../../tools/registry';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { formatEstimate, formatUsd } from '../format';
import { settingsUrl } from './links';

const REASON_LABELS: Record<BudgetReason['kind'], string> = {
  'per-run': 'Per-run threshold',
  monthly: 'Monthly budget',
  'key-monthly': 'Monthly budget for this key',
};

export function budgetConfirm(check: BudgetCheck, spec: RunSpec): Promise<boolean> {
  let confirmed = false;
  const cancel = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-secondary',
      'data-bs-dismiss': 'modal',
      'data-testid': 'budget-cancel',
    },
    'Cancel',
  );
  const modal = openModal({
    title: 'Confirm this run',
    icon: 'piggy-bank',
    tone: 'warning',
    body: [
      h('p', null, 'This run goes over a limit you set:'),
      h(
        'ul',
        { class: 'list-unstyled vstack gap-2 mb-3', 'data-testid': 'budget-reasons' },
        check.reasons.map((reason) =>
          h(
            'li',
            { class: 'border rounded-3 p-2 px-3 bg-body-tertiary' },
            h('div', { class: 'fw-semibold' }, REASON_LABELS[reason.kind]),
            h('div', null, reason.message),
            h(
              'div',
              { class: 'small text-body-secondary' },
              `Limit ${formatUsd(reason.limitUsd)} · with this run ${formatUsd(reason.projectedUsd)}`,
            ),
          ),
        ),
      ),
      h(
        'dl',
        { class: 'row small mb-2' },
        h('dt', { class: 'col-4 fw-normal text-body-secondary' }, 'Estimate'),
        h(
          'dd',
          { class: 'col-8 mb-1', 'data-testid': 'budget-estimate' },
          formatEstimate(spec.estimateUsd ?? null),
        ),
        h('dt', { class: 'col-4 fw-normal text-body-secondary' }, 'Tool'),
        h('dd', { class: 'col-8 mb-1' }, getTool(spec.tool).name),
        h('dt', { class: 'col-4 fw-normal text-body-secondary' }, 'Model'),
        h('dd', { class: 'col-8 mb-0 text-break' }, spec.model),
      ),
      h('a', { class: 'small', href: settingsUrl('budgets') }, 'Change your budgets'),
    ],
    footer: [
      cancel,
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          'data-testid': 'budget-confirm',
          onclick: () => {
            confirmed = true;
            modal.hide();
          },
        },
        'Run anyway',
      ),
    ],
    initialFocus: cancel,
    testId: 'budget-dialog',
  });
  return modal.closed.then(() => confirmed);
}
