/**
 * Add-on arithmetic shared by `runs.begin` (budgets, reservation) and the UI (estimate badge, budget dialog).
 * See `RunAddon` in src/core/types.ts.
 */
import type { RunAddon } from '../types';
import { isFiniteNumber } from '../util';

/**
 * The models' estimate plus every add-on's: what budgets check and a run reserves. Unknown parts count as 0, so a
 * known add-on price still counts when the models' cost is unknown; null only when no part is known.
 */
export function withAddons(estimate: number | null, addons: readonly RunAddon[]): number | null {
  const known = [estimate, ...addons.map((addon) => addon.estimateUsd)].filter(isFiniteNumber);
  return known.length === 0 ? null : known.reduce((sum, usd) => sum + Math.max(0, usd), 0);
}

/** Add-ons that cost something, or whose price is unknown. */
export function paidAddons(addons: readonly RunAddon[]): RunAddon[] {
  return addons.filter((addon) => addon.estimateUsd !== 0);
}

/** How many add-ons have an unknown price (left out of `withAddons`' sum, so it is a floor). */
export function unknownAddons(addons: readonly RunAddon[]): number {
  return addons.filter((addon) => !isFiniteNumber(addon.estimateUsd)).length;
}
