import { h } from '../dom';
import { formatEstimate } from '../format';
import { icon } from '../icon';

export interface CostBadge {
  readonly element: HTMLElement;
  /** `null` = cannot be estimated. `note` becomes the tooltip (e.g. "for 1,000 output tokens"). */
  set(usd: number | null, note?: string): void;
}

/**
 * The pre-run estimate pill: `≈ $0.0012`, `Free` (exactly zero) or `Unknown`. Not a live region: it changes as
 * the user types, and announcing every change would be noise; the Run button's description carries it.
 */
export function costBadge(initial: number | null = null, note?: string): CostBadge {
  const text = h('span', { 'data-testid': 'cost-estimate-value' });
  const element = h(
    'span',
    {
      class: 'badge rounded-pill or-cost-badge d-inline-flex align-items-center gap-1',
      'data-testid': 'cost-estimate',
    },
    icon('coin'),
    h('span', { class: 'visually-hidden' }, 'Estimated cost: '),
    text,
  );
  const set = (usd: number | null, nextNote?: string): void => {
    const value = usd !== null && Number.isFinite(usd) ? usd : null;
    text.textContent = formatEstimate(value);
    element.dataset.state = value === null ? 'unknown' : value === 0 ? 'free' : 'estimate';
    element.title =
      nextNote ??
      (value === null
        ? 'The cost cannot be estimated before running.'
        : 'Estimated cost of the next run');
  };
  set(initial, note);
  return { element, set };
}
