/**
 * The cost estimate a tool page shows in its header and books with each run.
 *
 * A tool computes it in `ToolInstance.estimate(model)` (from its current input); the framework asks for it when the
 * model changes (header chip, settings, a catalog refresh) and whenever the tool calls `ui.refreshEstimate()`
 * because its input changed. Answers can arrive out of order (catalog reads are async), so only the newest request
 * may update the badge. `current()` is what `ctx.beginRun` books when the spec has no `estimateUsd`: the latest
 * estimate if it was computed for this model and nothing changed since, else a fresh one.
 */

import { withAddons } from '../../core/runs/addons';
import type { RunAddon } from '../../core/types';

/**
 * What the header badge shows: the models' estimate plus the tool's add-ons (`ToolInstance.addons`). Unknown stays
 * unknown: a known add-on price does not make an unknown model cost known.
 */
export function badgeValue(usd: number | null, addons: readonly RunAddon[]): number | null {
  return usd === null ? null : withAddons(usd, addons);
}

export interface EstimateTrackerOptions {
  /** The tool's own estimate for `model`; null when the tool has none (unknown). */
  compute: (model: string) => Promise<number | null> | null;
  /** The model the next run would use, or null when none resolves. */
  model: () => string | null;
  /** Shows a value in the header badge. */
  show: (usd: number | null, note?: string) => void;
}

export interface EstimateTracker {
  /** Recomputes now; resolves with the value (or null), also when a newer request overtook it. */
  refresh(): Promise<number | null>;
  /** The latest estimate when still valid for the current model and input, otherwise a fresh one. */
  current(): Promise<number | null>;
  /** A value set by the tool itself (`ui.setEstimate`): shown, and current until the next change. */
  set(usd: number | null, note?: string): void;
}

export function createEstimateTracker(options: EstimateTrackerOptions): EstimateTracker {
  /** Bumped by every refresh and manual set; a result is applied only if its request is still the newest. */
  let version = 0;
  let latest: { version: number; model: string | null; usd: number | null } | null = null;

  const refresh = async (): Promise<number | null> => {
    const mine = ++version;
    const model = options.model();
    let usd: number | null = null;
    if (model) {
      try {
        const value = await options.compute(model);
        usd = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      } catch {
        usd = null; // an estimate that fails is "unknown", never an error the user has to handle
      }
    }
    if (mine === version) {
      latest = { version: mine, model, usd };
      options.show(usd);
    }
    return usd;
  };

  return {
    refresh,
    async current() {
      if (latest && latest.version === version && latest.model === options.model()) {
        return latest.usd;
      }
      return refresh();
    },
    set(usd, note) {
      version++;
      latest = { version, model: options.model(), usd };
      options.show(usd, note);
    },
  };
}
