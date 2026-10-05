/**
 * The budget confirmation every page registers with `runs.setConfirmHandler`: when a run's estimate or the
 * month's spend crosses a Warn-mode rule (or the per-run threshold in Hard-stop mode), `runs.begin` asks here
 * before anything is sent. A group approved at once (`runs.approveGroup`: an arena round, a video sequence) is
 * asked about once, by its label, with its models and its total. Cancel makes `begin`/`approveGroup` throw
 * RunCancelledError, which tools and `presentError` treat as a quiet stop. Following a link in it declines first.
 */
import { getCore } from '../../core/index';
import { paidAddons, withAddons } from '../../core/runs/addons';
import type { BudgetCheck, BudgetQuestion, BudgetReason, RunAddon } from '../../core/types';
import { getTool } from '../../tools/registry';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { formatEstimate, formatUsd, plural } from '../format';
import { guardedNavigate } from './leave-guard';
import { settingsUrl } from './links';

const REASON_LABELS: Record<BudgetReason['kind'], string> = {
  'per-run': 'Per-run threshold',
  monthly: 'Monthly budget',
  'key-monthly': 'Monthly budget for this key',
};

/** What the dialog shows, the same for one run and for a group. */
interface Shown {
  title: string;
  intro: string;
  /** "with this run" / "with these runs", after a reason's limit. */
  withWhat: string;
  group: { label: string; runs: number } | null;
  tool: string;
  models: readonly string[];
  estimateUsd: number | null;
  addons: readonly RunAddon[];
  note: string | null;
}

function shown(question: BudgetQuestion): Shown {
  if (question.kind === 'run') {
    const { spec } = question;
    return {
      title: 'Confirm this run',
      intro: 'This run goes over a limit you set:',
      withWhat: 'with this run',
      group: null,
      tool: getTool(spec.tool).name,
      models: [spec.model],
      estimateUsd: spec.estimateUsd ?? null,
      addons: spec.addons ?? [],
      note: null,
    };
  }
  const { group } = question;
  return {
    title: 'Confirm these runs',
    intro: 'Together, these runs go over a limit you set:',
    withWhat: 'with these runs',
    group: { label: group.label, runs: group.runs },
    tool: getTool(group.tool).name,
    models: group.models,
    estimateUsd: group.estimateUsd,
    addons: group.addons ?? [],
    note: group.note ?? null,
  };
}

const term = (text: string): HTMLElement =>
  h('dt', { class: 'col-4 fw-normal text-body-secondary' }, text);

export function budgetConfirm(check: BudgetCheck, question: BudgetQuestion): Promise<boolean> {
  const view = shown(question);
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
    title: view.title,
    icon: 'piggy-bank',
    tone: 'warning',
    body: [
      h('p', null, view.intro),
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
              `Limit ${formatUsd(reason.limitUsd)} · ${view.withWhat} ${formatUsd(reason.projectedUsd)}`,
            ),
          ),
        ),
      ),
      h(
        'dl',
        { class: 'row small mb-2' },
        view.group
          ? [
              term('Runs'),
              h(
                'dd',
                { class: 'col-8 mb-1', 'data-testid': 'budget-group' },
                view.group.label,
                h(
                  'div',
                  { class: 'small text-body-secondary' },
                  `${plural(view.group.runs, 'run')}, asked once for all of them`,
                ),
              ),
            ]
          : null,
        term(view.group ? 'Total estimate' : 'Estimate'),
        h(
          'dd',
          { class: 'col-8 mb-1', 'data-testid': 'budget-estimate' },
          formatEstimate(withAddons(view.estimateUsd, view.addons)),
          paidAddons(view.addons).map((addon) =>
            h(
              'div',
              { class: 'small text-body-secondary' },
              `Includes ${addon.label}: ${formatEstimate(addon.estimateUsd)}`,
            ),
          ),
        ),
        term('Tool'),
        h('dd', { class: 'col-8 mb-1' }, view.tool),
        term(view.models.length === 1 ? 'Model' : 'Models'),
        h(
          'dd',
          { class: 'col-8 mb-0 text-break', 'data-testid': 'budget-models' },
          view.models.length === 1
            ? view.models[0]
            : h(
                'ul',
                { class: 'list-unstyled mb-0' },
                view.models.map((model) => h('li', null, model)),
              ),
        ),
      ),
      view.note ? h('p', { class: 'small mb-2', 'data-testid': 'budget-note' }, view.note) : null,
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
        view.group ? 'Run them anyway' : 'Run anyway',
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
