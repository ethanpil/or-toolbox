/**
 * The budget confirmation every page registers with `runs.setConfirmHandler`: when a run's estimate or the
 * month's spend crosses a Warn-mode rule (or the per-run threshold in Hard-stop mode), `runs.begin` asks here
 * before anything is sent. Cancel makes `begin` throw RunCancelledError, which tools and `presentError` treat
 * as a quiet stop. Parallel runs of one group share one dialog; following a link in it declines first.
 */
import { getCore } from '../../core/index';
import { paidAddons, withAddons } from '../../core/runs/addons';
import type { BudgetCheck, BudgetReason, RunSpec } from '../../core/types';
import { getTool } from '../../tools/registry';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { formatEstimate, formatUsd } from '../format';
import { guardedNavigate } from './leave-guard';
import { settingsUrl } from './links';

const REASON_LABELS: Record<BudgetReason['kind'], string> = {
  'per-run': 'Per-run threshold',
  monthly: 'Monthly budget',
  'key-monthly': 'Monthly budget for this key',
};

/** One dialog per group of parallel runs (arena contenders): every member gets the same answer. */
const pendingByGroup = new Map<string, Promise<boolean>>();

export function budgetConfirm(check: BudgetCheck, spec: RunSpec): Promise<boolean> {
  const group = spec.groupId;
  if (group) {
    const pending = pendingByGroup.get(group);
    if (pending) return pending;
    const answer = askToConfirm(check, spec).finally(() => pendingByGroup.delete(group));
    pendingByGroup.set(group, answer);
    return answer;
  }
  return askToConfirm(check, spec);
}

function askToConfirm(check: BudgetCheck, spec: RunSpec): Promise<boolean> {
  let confirmed = false;
  let leaveTo: string | null = null;
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
          formatEstimate(withAddons(spec.estimateUsd ?? null, spec.addons ?? [])),
          paidAddons(spec.addons ?? []).map((addon) =>
            h(
              'div',
              { class: 'small text-body-secondary' },
              `Includes ${addon.label}: ${formatEstimate(addon.estimateUsd)}`,
            ),
          ),
        ),
        h('dt', { class: 'col-4 fw-normal text-body-secondary' }, 'Tool'),
        h('dd', { class: 'col-8 mb-1' }, getTool(spec.tool).name),
        h('dt', { class: 'col-4 fw-normal text-body-secondary' }, 'Model'),
        h('dd', { class: 'col-8 mb-0 text-break' }, spec.model),
      ),
      h(
        'a',
        {
          class: 'small',
          href: settingsUrl('budgets'),
          // Leaving declines first, so runs.begin cleans up its reservation before the page goes.
          onclick: (event: MouseEvent) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
            event.preventDefault();
            leaveTo = settingsUrl('budgets');
            modal.hide();
          },
        },
        'Change your budgets',
      ),
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
  return modal.closed.then(() => {
    if (leaveTo) {
      const href = leaveTo;
      // After begin() has seen the "no" (this promise resolves first), go where the link pointed.
      setTimeout(() => void guardedNavigate(getCore(), href), 0);
    }
    return confirmed;
  });
}
