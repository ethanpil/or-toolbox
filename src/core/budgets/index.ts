/**
 * Budget checks before every run. Spend = finished spend this UTC month from the local stats ledger (one
 * read per check) plus what every `running` run in any tab holds: its reservation, or what it has already
 * spent if that is more. OpenRouter's `/key` usage and `/generation` lag by minutes, so they are never used
 * (docs/openrouter-api.md §0, §10).
 *
 * When the spend cannot be read (IndexedDB failing), monthly rules cannot be evaluated: the verdict is
 * `confirm` in both warn and hard mode, so the user decides instead of the run being silently allowed or
 * blocked.
 */

import type { BudgetCheck, BudgetReason, BudgetsService, CoreServices } from '../types';
import { getDb } from '../storage/db';
import { utcMonthRange } from '../stats';

/** `$0.18`; amounts under a cent keep two significant digits (`$0.0042`). */
export function formatUsd(value: number): string {
  const digits =
    value !== 0 && Math.abs(value) < 0.01 ? 1 - Math.floor(Math.log10(Math.abs(value))) : 2;
  return `$${value.toFixed(digits)}`;
}

/** With an estimate: spend + estimate above the limit. Without one: the limit is already used up. */
function exceeds(spent: number, estimate: number | null, limit: number): boolean {
  return estimate == null ? spent >= limit : spent + estimate > limit;
}

interface MonthSpend {
  total: number;
  byKey: Map<string, number>;
}

export function createBudgetsService(core: CoreServices): BudgetsService {
  /** Finished spend this month plus running runs' holds, overall and per key. */
  const readSpend = async (): Promise<MonthSpend> => {
    const [rows, running] = await Promise.all([
      core.stats.rows(utcMonthRange()),
      getDb().then((db) => db.getAllFromIndex('runs', 'status', 'running')),
    ]);
    const spend: MonthSpend = { total: 0, byKey: new Map() };
    const add = (keyId: string, usd: number): void => {
      spend.total += usd;
      spend.byKey.set(keyId, (spend.byKey.get(keyId) ?? 0) + usd);
    };
    for (const row of rows) add(row.keyId, row.costUsd);
    for (const run of running) add(run.keyId, Math.max(run.reservedUsd || 0, run.usage.costUsd));
    return spend;
  };

  return {
    async check({ keyId, estimateUsd, group = false }) {
      const budgets = core.settings.get().budgets;
      if (budgets.mode === 'disabled') return { verdict: 'ok', reasons: [] };

      const estimate = estimateUsd ?? null;
      const reasons: BudgetReason[] = [];
      const subject = group ? 'These runs' : 'This run';

      if (estimate != null && estimate > budgets.perRunUsd) {
        reasons.push({
          kind: 'per-run',
          limitUsd: budgets.perRunUsd,
          projectedUsd: estimate,
          message: group
            ? `These runs are estimated at ${formatUsd(estimate)} together, above your ${formatUsd(budgets.perRunUsd)} per-run limit.`
            : `This run is estimated at ${formatUsd(estimate)}, above your ${formatUsd(budgets.perRunUsd)} per-run limit.`,
        });
      }

      const monthly = budgets.monthlyUsd;
      const keyLimit = budgets.perKeyMonthlyUsd[keyId] ?? null;
      if (monthly == null && keyLimit == null) {
        return { verdict: verdictFor(budgets.mode, reasons), reasons };
      }

      let spend: MonthSpend;
      try {
        spend = await readSpend();
      } catch (error) {
        console.error(error);
        reasons.push({
          kind: monthly != null ? 'monthly' : 'key-monthly',
          limitUsd: monthly ?? keyLimit ?? 0,
          projectedUsd: estimate ?? 0,
          message:
            "This month's spend could not be read, so your monthly limits cannot be checked.",
        });
        return { verdict: 'confirm', reasons };
      }

      if (monthly != null && exceeds(spend.total, estimate, monthly)) {
        const spent = spend.total;
        reasons.push({
          kind: 'monthly',
          limitUsd: monthly,
          projectedUsd: spent + (estimate ?? 0),
          message:
            estimate == null
              ? `You have spent ${formatUsd(spent)} this month, which reaches your ${formatUsd(monthly)} monthly limit.`
              : `${subject} would bring this month's spend to ${formatUsd(spent + estimate)}, above your ${formatUsd(monthly)} monthly limit.`,
        });
      }

      const spentOnKey = spend.byKey.get(keyId) ?? 0;
      if (keyLimit != null && exceeds(spentOnKey, estimate, keyLimit)) {
        const name = core.keys.get(keyId)?.name;
        const label = name ? `the key “${name}”` : 'this key';
        reasons.push({
          kind: 'key-monthly',
          limitUsd: keyLimit,
          projectedUsd: spentOnKey + (estimate ?? 0),
          message:
            estimate == null
              ? `You have spent ${formatUsd(spentOnKey)} on ${label} this month, which reaches its ${formatUsd(keyLimit)} monthly limit.`
              : `${subject} would bring this month's spend on ${label} to ${formatUsd(spentOnKey + estimate)}, above its ${formatUsd(keyLimit)} monthly limit.`,
        });
      }

      return { verdict: verdictFor(budgets.mode, reasons), reasons };
    },
  };
}

function verdictFor(mode: 'warn' | 'hard', reasons: BudgetReason[]): BudgetCheck['verdict'] {
  if (reasons.length === 0) return 'ok';
  if (mode === 'hard' && reasons.some((reason) => reason.kind !== 'per-run')) return 'block';
  return 'confirm';
}
