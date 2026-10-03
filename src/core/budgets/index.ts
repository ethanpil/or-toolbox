/**
 * Budget checks before every run. Spend comes from the local stats ledger for the current UTC month, because
 * OpenRouter's `/key` usage and `/generation` lag by minutes (docs/openrouter-api.md §0, §10).
 */

import type { BudgetCheck, BudgetReason, BudgetsService, CoreServices } from '../types';

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

export function createBudgetsService(core: CoreServices): BudgetsService {
  return {
    async check({ keyId, estimateUsd }) {
      const budgets = core.settings.get().budgets;
      if (budgets.mode === 'disabled') return { verdict: 'ok', reasons: [] };

      const estimate = estimateUsd ?? null;
      const reasons: BudgetReason[] = [];

      if (estimate != null && estimate > budgets.perRunUsd) {
        reasons.push({
          kind: 'per-run',
          limitUsd: budgets.perRunUsd,
          projectedUsd: estimate,
          message: `This run is estimated at ${formatUsd(estimate)}, above your ${formatUsd(budgets.perRunUsd)} per-run limit.`,
        });
      }

      const monthly = budgets.monthlyUsd;
      if (monthly != null) {
        const spent = await core.stats.monthSpend();
        if (exceeds(spent, estimate, monthly)) {
          reasons.push({
            kind: 'monthly',
            limitUsd: monthly,
            projectedUsd: spent + (estimate ?? 0),
            message:
              estimate == null
                ? `You have spent ${formatUsd(spent)} this month, which reaches your ${formatUsd(monthly)} monthly limit.`
                : `This run would bring this month's spend to ${formatUsd(spent + estimate)}, above your ${formatUsd(monthly)} monthly limit.`,
          });
        }
      }

      const keyLimit = budgets.perKeyMonthlyUsd[keyId];
      if (keyLimit != null) {
        const spent = await core.stats.monthSpend({ keyId });
        if (exceeds(spent, estimate, keyLimit)) {
          const name = core.keys.get(keyId)?.name;
          const label = name ? `the key “${name}”` : 'this key';
          reasons.push({
            kind: 'key-monthly',
            limitUsd: keyLimit,
            projectedUsd: spent + (estimate ?? 0),
            message:
              estimate == null
                ? `You have spent ${formatUsd(spent)} on ${label} this month, which reaches its ${formatUsd(keyLimit)} monthly limit.`
                : `This run would bring this month's spend on ${label} to ${formatUsd(spent + estimate)}, above its ${formatUsd(keyLimit)} monthly limit.`,
          });
        }
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
