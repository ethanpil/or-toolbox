/**
 * Settings → Budgets: the mode (Disabled / Warn / Hard stop), the per-run threshold, the app-wide monthly limit
 * and per-key monthly limits, each limit with this month's spend so far: `budgets.monthSpend()`, the numbers the
 * budget checks read (local stats ledger, current UTC month, plus what runs in progress hold), read once for the
 * total and every key. A figure with an estimate in it reads "≈", as on Stats.
 */
import { MAX_MONTHLY_USD, MAX_PER_RUN_USD } from '../../core/settings/schema';
import type { BudgetMode, CoreServices, KeyInfo, MonthSpend } from '../../core/types';
import { keyDot } from '../../ui/components/key-picker';
import { meter } from '../../ui/components/meter';
import { type Child, h } from '../../ui/dom';
import { announce } from '../../ui/feedback/announce';
import { formatUsd } from '../../ui/format';
import { icon } from '../../ui/icon';
import { saveSettings } from '../../ui/settings-actions';
import { markEstimate } from '../stats-logic';
import { parseUsd, spendMeter, usdFieldValue } from './logic';
import {
  card,
  type Field,
  loadingLine,
  numberField,
  radioCards,
  rerender,
  type SectionView,
} from './ui';

const MODE_LABELS: Record<BudgetMode, string> = {
  disabled: 'Disabled',
  warn: 'Warn',
  hard: 'Hard stop',
};

export function budgetsSection(core: CoreServices): SectionView {
  let spend: MonthSpend | null = null;
  let spendError = false;

  const mode = radioCards<BudgetMode>({
    legend: 'Mode',
    legendHidden: true,
    value: core.settings.get().budgets.mode,
    options: [
      {
        value: 'disabled',
        label: 'Disabled',
        icon: 'slash-circle',
        description: 'No checks: runs never ask and are never stopped.',
        testId: 'budget-mode-disabled',
      },
      {
        value: 'warn',
        label: 'Warn',
        icon: 'exclamation-triangle',
        description: 'Ask before a run that would pass a limit or the per-run threshold.',
        testId: 'budget-mode-warn',
      },
      {
        value: 'hard',
        label: 'Hard stop',
        icon: 'sign-stop',
        description: 'Block runs that would pass a monthly limit; ask above the per-run threshold.',
        testId: 'budget-mode-hard',
      },
    ],
    onChange: (value) => {
      const saved = saveSettings(core, (draft) => {
        draft.budgets.mode = value;
      });
      if (saved) announce(`Budget mode: ${MODE_LABELS[value]}.`);
      else mode.set(core.settings.get().budgets.mode); // not saved: show what is in force
    },
  });

  const disabledNote = h(
    'div',
    {
      class: 'alert alert-secondary d-flex gap-2 align-items-center small mt-3 mb-0',
      'data-testid': 'budgets-off',
    },
    icon('info-circle'),
    'Budgets are disabled: the limits below are kept but not checked.',
  );

  const perRun = numberField<number | null>({
    label: 'Per-run threshold',
    help: 'A run estimated above this asks first (Warn and Hard stop). Runs started together, such as an arena round or a video sequence, ask once for their total. 0 asks before every paid run. Default $0.10.',
    prefix: '$',
    testId: 'budget-per-run',
    className: 'or-field-narrow',
    parse: (text) => parseUsd(text, { max: MAX_PER_RUN_USD }),
    onCommit: (value) =>
      value !== null &&
      saveSettings(core, (draft) => {
        draft.budgets.perRunUsd = value;
      }),
  });

  const monthly = numberField<number | null>({
    label: 'Monthly limit for the whole app',
    help: 'Counts every key, per calendar month (UTC). 0 blocks all paid runs (Warn asks instead); leave empty for no limit.',
    prefix: '$',
    placeholder: 'No limit',
    testId: 'budget-monthly',
    parse: (text) => parseUsd(text, { max: MAX_MONTHLY_USD, optional: true }),
    onCommit: (value) =>
      saveSettings(core, (draft) => {
        draft.budgets.monthlyUsd = value;
      }),
  });
  const monthlyMeter = h('div', { class: 'mt-2' });

  const spendLine = h('p', { class: 'mb-0', 'data-testid': 'budget-month-spend' });
  const perKeyList = h('div', { 'data-testid': 'budget-keys' });
  /** Per-key fields, kept across re-renders so typing is never interrupted. */
  const keyFields = new Map<string, Field>();
  const keyMeters = new Map<string, HTMLElement>();

  const meterFor = (
    spent: { usd: number; estimatedUsd: number } | undefined,
    limit: number | null,
    label: string,
    testId: string,
  ): Child => {
    if (limit === null) return null;
    if (spend === null) return spendError ? null : loadingLine('Reading this month’s spend…');
    const m = spendMeter(spent?.usd ?? 0, limit, spent?.estimatedUsd ?? 0)!;
    return meter({ percent: m.percent, tone: m.tone, label, text: m.text, testId });
  };

  const keyLabel = (key: KeyInfo): HTMLElement =>
    h('span', { class: 'd-inline-flex align-items-center gap-2' }, keyDot(key), key.name);

  /** The field of one key, kept across re-renders (typing is never interrupted); its label follows renames. */
  const keyField = (key: KeyInfo): Field => {
    let field = keyFields.get(key.id);
    if (!field) {
      field = numberField<number | null>({
        label: keyLabel(key),
        prefix: '$',
        placeholder: 'No limit',
        testId: 'budget-key-limit',
        parse: (text) => parseUsd(text, { max: MAX_MONTHLY_USD, optional: true }),
        onCommit: (value) =>
          saveSettings(core, (draft) => {
            if (value === null) delete draft.budgets.perKeyMonthlyUsd[key.id];
            else draft.budgets.perKeyMonthlyUsd[key.id] = value;
          }),
      });
      field.input.dataset.focusKey = `budget:${key.id}`;
      keyFields.set(key.id, field);
    } else {
      field.setLabel(keyLabel(key));
    }
    return field;
  };

  const renderMeters = (): void => {
    const budgets = core.settings.get().budgets;
    rerender(
      monthlyMeter,
      meterFor(
        spend ? { usd: spend.usd, estimatedUsd: spend.estimatedUsd } : undefined,
        budgets.monthlyUsd,
        'Spent of the monthly limit',
        'budget-monthly-meter',
      ),
    );
    for (const key of core.keys.list()) {
      const slot = keyMeters.get(key.id);
      if (!slot) continue;
      rerender(
        slot,
        meterFor(
          spend?.byKey.get(key.id),
          budgets.perKeyMonthlyUsd[key.id] ?? null,
          `Spent of the limit for ${key.name}`,
          'budget-key-meter',
        ),
      );
    }
    spendLine.replaceChildren(
      ...(spendError
        ? ['This month’s spend could not be read.']
        : spend === null
          ? [loadingLine('Reading this month’s spend…')]
          : [
              'Spent this month: ',
              h(
                'strong',
                { 'data-testid': 'budget-month-spend-value' },
                markEstimate(formatUsd(spend.usd), spend.estimatedUsd),
              ),
              ` (runs in this browser; the month follows UTC${spend.estimatedUsd > 0 ? '; includes estimated costs' : ''}${spend.heldUsd > 0 ? `, and ${formatUsd(spend.heldUsd)} held for runs in progress` : ''}).`,
            ]),
    );
  };

  const renderKeys = (): void => {
    const keys = core.keys.list();
    const budgets = core.settings.get().budgets;
    for (const id of [...keyFields.keys()]) {
      if (!keys.some((key) => key.id === id)) keyFields.delete(id);
    }
    keyMeters.clear();
    rerender(
      perKeyList,
      keys.length === 0
        ? h(
            'p',
            { class: 'text-body-secondary small mb-0' },
            'Add a key to give it its own monthly limit.',
          )
        : h(
            'div',
            { class: 'row row-cols-1 row-cols-md-2 g-4' },
            keys.map((key) => {
              const field = keyField(key);
              field.sync(usdFieldValue(budgets.perKeyMonthlyUsd[key.id] ?? null));
              const meterSlot = h('div', { class: 'mt-2' });
              keyMeters.set(key.id, meterSlot);
              return h(
                'div',
                { class: 'col', 'data-testid': 'budget-key', 'data-key-id': key.id },
                field.element,
                meterSlot,
              );
            }),
          ),
      // The key whose field had focus was removed: land on this card's heading.
      { fallback: () => perKeyCard.querySelector('h3') },
    );
    renderMeters();
  };

  let loads = 0;
  const loadSpend = (): void => {
    // One read of the month, for the total and every key. A newer load supersedes an older one.
    const mine = ++loads;
    core.budgets
      .monthSpend()
      .then((month) => {
        if (mine !== loads) return;
        spend = month;
        spendError = false;
      })
      .catch(() => {
        if (mine !== loads) return;
        spendError = true;
      })
      .finally(() => {
        if (mine === loads) renderMeters();
      });
  };

  const sync = (): void => {
    const budgets = core.settings.get().budgets;
    mode.set(budgets.mode);
    disabledNote.hidden = budgets.mode !== 'disabled';
    perRun.sync(usdFieldValue(budgets.perRunUsd));
    monthly.sync(usdFieldValue(budgets.monthlyUsd));
    for (const key of core.keys.list()) {
      keyFields.get(key.id)?.sync(usdFieldValue(budgets.perKeyMonthlyUsd[key.id] ?? null));
    }
    renderMeters();
  };

  let shown = false;
  const perKeyCard = card(
    {
      title: 'Monthly limit per key',
      icon: 'key',
      text: 'Optional: a limit for one key, on top of the app-wide one. 0 blocks all paid runs with that key; leave empty for no limit.',
      testId: 'budget-per-key',
    },
    perKeyList,
  );
  const element = h(
    'div',
    null,
    card(
      {
        title: 'Mode',
        icon: 'shield-check',
        text: 'Checks run before every paid request, against what you spent this month in this browser.',
        testId: 'budget-mode',
      },
      mode.element,
      disabledNote,
    ),
    card(
      { title: 'Limits', icon: 'piggy-bank', testId: 'budget-limits' },
      h(
        'div',
        { class: 'vstack gap-4' },
        spendLine,
        perRun.element,
        h('div', { class: 'or-field-narrow' }, monthly.element, monthlyMeter),
      ),
    ),
    perKeyCard,
  );

  core.settings.subscribe((next, prev) => {
    if (JSON.stringify(next.budgets) !== JSON.stringify(prev.budgets)) sync();
  });
  core.keys.subscribe(() => {
    renderKeys();
    if (shown) loadSpend();
  });
  core.stats.subscribe(() => {
    if (shown) loadSpend();
  });
  // A run that starts holds its estimate at once: the meters follow before it has spent anything.
  core.history.subscribe(() => {
    if (shown) loadSpend();
  });
  renderKeys();
  sync();

  return {
    element,
    onShow: () => {
      shown = true;
      loadSpend();
    },
  };
}
