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
import { RUN_HOLD_PREFIX, holdOf, parseHold, type RunHold } from '../runs/holds';
import { prefixRange } from '../tool-state';

/** `$0.18`; amounts under a cent keep two significant digits (`$0.0042`). */
export function formatUsd(value: number): string {
  const digits =
    value !== 0 && Math.abs(value) < 0.01 ? 1 - Math.floor(Math.log10(Math.abs(value))) : 2;
  return `$${value.toFixed(digits)}`;
}

/**
 * With an estimate: spend + estimate above the limit. Without one, or with parts of it unknown (a floor): any
 * unknown cost passes a limit that is already reached.
 */
function exceeds(spent: number, estimate: number | null, limit: number, partly: boolean): boolean {
  if (estimate == null) return spent >= limit;
  return partly ? spent + estimate >= limit : spent + estimate > limit;
}

interface MonthSpend {
  total: number;
  byKey: Map<string, number>;
}

/**
 * What every `running` run holds, read from the small `kv` holds the runs service keeps beside its records (never
 * the records themselves, which carry up to 500 KB of output each). The running ids come from the `status` index
 * (keys only); a running record without a hold (written before holds existed) is read once, and a hold whose run
 * is no longer running is ignored.
 */
async function readHolds(): Promise<RunHold[]> {
  const db = await getDb();
  const tx = db.transaction(['runs', 'kv']);
  const [ids, entries] = await Promise.all([
    tx.objectStore('runs').index('status').getAllKeys('running'),
    tx.objectStore('kv').getAll(prefixRange(RUN_HOLD_PREFIX)),
  ]);
  const byId = new Map<string, RunHold>();
  for (const entry of entries) {
    const hold = parseHold(entry.value);
    if (hold) byId.set(entry.key.slice(RUN_HOLD_PREFIX.length), hold);
  }
  const holds: RunHold[] = [];
  for (const id of ids) {
    const hold = byId.get(id);
    if (hold) {
      holds.push(hold);
      continue;
    }
    const run = await tx.objectStore('runs').get(id);
    if (run?.status === 'running') holds.push(holdOf(run));
  }
  return holds;
}

export function createBudgetsService(core: CoreServices): BudgetsService {
  /** Finished spend this month plus running runs' holds, overall and per key. */
  const readSpend = async (): Promise<MonthSpend> => {
    const [rows, holds] = await Promise.all([core.stats.rows(utcMonthRange()), readHolds()]);
    const spend: MonthSpend = { total: 0, byKey: new Map() };
    const add = (keyId: string, usd: number): void => {
      spend.total += usd;
      spend.byKey.set(keyId, (spend.byKey.get(keyId) ?? 0) + usd);
    };
    for (const row of rows) add(row.keyId, row.costUsd);
    for (const hold of holds) add(hold.keyId, hold.usd);
    return spend;
  };

  return {
    async check({ keyId, estimateUsd, group = false, unknownParts = 0 }) {
      const budgets = core.settings.get().budgets;
      if (budgets.mode === 'disabled') return { verdict: 'ok', reasons: [] };

      const estimate = estimateUsd ?? null;
      const reasons: BudgetReason[] = [];
      const subject = group ? 'These runs' : 'This run';
      /** Part of the cost is unknown: the estimate is a floor. */
      const partly = estimate != null && unknownParts > 0;
      const unknownNote = `${unknownParts} unknown`;

      if (estimate != null && estimate > budgets.perRunUsd) {
        const amount = `${formatUsd(estimate)}${group ? ' together' : ''}`;
        reasons.push({
          kind: 'per-run',
          limitUsd: budgets.perRunUsd,
          projectedUsd: estimate,
          message: `${subject} ${group ? 'are' : 'is'} estimated at ${amount}${partly ? ` and ${unknownNote}` : ''}, above your ${formatUsd(budgets.perRunUsd)} per-run limit.`,
        });
      }
      /** "would bring this month's spend [on …] to $x, above …" or, for a floor, "to at least $x (1 unknown), which reaches …". */
      const wouldBring = (on: string, total: number, limit: number, its: string): string =>
        partly
          ? `${subject} would bring this month's spend${on} to at least ${formatUsd(total)} (${unknownNote}), which reaches ${its} ${formatUsd(limit)} monthly limit.`
          : `${subject} would bring this month's spend${on} to ${formatUsd(total)}, above ${its} ${formatUsd(limit)} monthly limit.`;

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

      if (monthly != null && exceeds(spend.total, estimate, monthly, partly)) {
        const spent = spend.total;
        reasons.push({
          kind: 'monthly',
          limitUsd: monthly,
          projectedUsd: spent + (estimate ?? 0),
          message:
            estimate == null
              ? `You have spent ${formatUsd(spent)} this month, which reaches your ${formatUsd(monthly)} monthly limit.`
              : wouldBring('', spent + estimate, monthly, 'your'),
        });
      }

      const spentOnKey = spend.byKey.get(keyId) ?? 0;
      if (keyLimit != null && exceeds(spentOnKey, estimate, keyLimit, partly)) {
        const name = core.keys.get(keyId)?.name;
        const label = name ? `the key “${name}”` : 'this key';
        reasons.push({
          kind: 'key-monthly',
          limitUsd: keyLimit,
          projectedUsd: spentOnKey + (estimate ?? 0),
          message:
            estimate == null
              ? `You have spent ${formatUsd(spentOnKey)} on ${label} this month, which reaches its ${formatUsd(keyLimit)} monthly limit.`
              : wouldBring(` on ${label}`, spentOnKey + estimate, keyLimit, 'its'),
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
