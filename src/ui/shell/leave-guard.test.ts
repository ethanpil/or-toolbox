import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreServices, RunHandle, SessionResult } from '../../core/types';
import { atStake, installLeaveGuard, type LinkClick, leavesPage } from './leave-guard';

const here = { href: 'http://localhost/or-toolbox/tools/ocr/?model=x' };
const click = (patch: Partial<LinkClick> = {}): LinkClick => ({
  href: 'http://localhost/or-toolbox/settings/',
  target: '',
  download: false,
  button: 0,
  modifiers: false,
  defaultPrevented: false,
  ...patch,
});

describe('leavesPage', () => {
  it('is true for a plain click to another page of the site', () => {
    expect(leavesPage(click(), here)).toBe(true);
    expect(leavesPage(click({ href: '/or-toolbox/' }), here)).toBe(true);
    expect(leavesPage(click({ target: '_self' }), here)).toBe(true);
    // Same path, different query: a different page load.
    expect(leavesPage(click({ href: 'http://localhost/or-toolbox/tools/ocr/' }), here)).toBe(true);
  });

  it('is false for new tabs, downloads, other buttons and handled clicks', () => {
    expect(leavesPage(click({ target: '_blank' }), here)).toBe(false);
    expect(leavesPage(click({ modifiers: true }), here)).toBe(false);
    expect(leavesPage(click({ download: true }), here)).toBe(false);
    expect(leavesPage(click({ button: 1 }), here)).toBe(false);
    expect(leavesPage(click({ defaultPrevented: true }), here)).toBe(false);
  });

  it('is false for other origins, other schemes and same-page fragments', () => {
    expect(leavesPage(click({ href: 'https://openrouter.ai/settings/keys' }), here)).toBe(false);
    expect(leavesPage(click({ href: 'mailto:a@b.c' }), here)).toBe(false);
    expect(leavesPage(click({ href: `${here.href}#section` }), here)).toBe(false);
  });
});

function fakeCore(
  pending: number,
  running: number,
  handedOff = 0,
): Pick<CoreServices, 'results' | 'runs'> {
  const results = Array.from({ length: pending }, (_, i) => ({ id: `r${i}` }) as SessionResult);
  return {
    results: {
      pending: () => [...results],
      summary: () => (pending === 0 ? null : `${pending} images not downloaded`),
      remove: vi.fn(),
      downloadAll: vi.fn(() => Promise.resolve()),
    } as unknown as CoreServices['results'],
    runs: {
      active: () => [
        ...Array.from({ length: running }, () => ({ jobId: null }) as RunHandle),
        ...Array.from({ length: handedOff }, () => ({ jobId: 'job' }) as RunHandle),
      ],
    } as unknown as CoreServices['runs'],
  };
}

describe('atStake', () => {
  it('lists undownloaded results and runs in progress', () => {
    expect(atStake(fakeCore(0, 0))).toEqual([]);
    expect(atStake(fakeCore(3, 0))).toEqual(['3 images not downloaded']);
    expect(atStake(fakeCore(0, 1))).toEqual(['1 run in progress']);
    expect(atStake(fakeCore(2, 2))).toEqual(['2 images not downloaded', '2 runs in progress']);
    // Runs handed off to a job finish without this page.
    expect(atStake(fakeCore(0, 0, 2))).toEqual([]);
    expect(atStake(fakeCore(0, 1, 1))).toEqual(['1 run in progress']);
  });
});

describe('installLeaveGuard', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('lets links through when nothing is at stake, and asks when something is', () => {
    let core = fakeCore(0, 0);
    installLeaveGuard({
      get results() {
        return core.results;
      },
      get runs() {
        return core.runs;
      },
    });
    const link = document.createElement('a');
    link.href = '/or-toolbox/settings/';
    link.textContent = 'Settings';
    document.body.append(link);

    const free = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    // jsdom does not navigate; stop the default action ourselves after the guard has looked at it.
    document.addEventListener('click', (event) => event.preventDefault(), { once: true });
    link.dispatchEvent(free);
    expect(document.querySelector('[data-testid="leave-guard"]')).toBeNull();

    core = fakeCore(1, 1);
    const guarded = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(true);
    const dialog = document.querySelector('[data-testid="leave-guard"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector('[data-testid="leave-guard-list"]')?.textContent).toBe(
      '1 images not downloaded1 run in progress',
    );
  });
});
