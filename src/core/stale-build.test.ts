import { describe, expect, it } from 'vitest';
import { installStaleBuildOffer } from './stale-build';

const toasts = () => document.querySelectorAll('[data-testid="stale-build"]');

describe('installStaleBuildOffer', () => {
  it('offers a reload once when a lazy chunk fails to load, and lets the error through', () => {
    installStaleBuildOffer();
    const event = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(event);
    window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));

    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]?.querySelector('[data-testid="reload"]')?.textContent).toContain('Reload');
    // Not prevented: the code that imported still sees its import fail.
    expect(event.defaultPrevented).toBe(false);
  });
});
