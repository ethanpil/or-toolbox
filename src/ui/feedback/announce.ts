/**
 * Screen-reader announcements through two persistent, visually hidden live regions (polite and assertive).
 * Live regions only work reliably when they exist before their text changes, so they are created once per
 * page and reused; toasts and status messages announce through here instead of being live regions themselves.
 */
import { h } from '../dom';

let regions: { polite: HTMLElement; assertive: HTMLElement } | null = null;

function ensureRegions(): { polite: HTMLElement; assertive: HTMLElement } {
  if (regions?.polite.isConnected) return regions;
  const make = (live: 'polite' | 'assertive'): HTMLElement =>
    h('div', {
      class: 'visually-hidden',
      'aria-live': live,
      'aria-atomic': 'true',
      'data-testid': `announcer-${live}`,
    });
  regions = { polite: make('polite'), assertive: make('assertive') };
  document.body.append(regions.polite, regions.assertive);
  return regions;
}

/** Creates the live regions now (the shell calls this at page start, before anything is announced). */
export function installAnnouncer(): void {
  ensureRegions();
}

/**
 * Announces `text` to screen readers. The region is cleared first and filled on the next frame, so the same
 * message twice in a row is announced twice.
 */
export function announce(text: string, options: { assertive?: boolean } = {}): void {
  const region = ensureRegions()[options.assertive ? 'assertive' : 'polite'];
  region.textContent = '';
  setTimeout(() => {
    region.textContent = text;
  }, 50);
}
