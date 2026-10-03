/** Tests for the /auth/callback/ page flow (src/pages/auth-callback.ts). */
import { describe, expect, it, vi } from 'vitest';
import { mountAuthCallback, type AuthCallbackEnv } from '../../pages/auth-callback';
import { KeyLockedError } from '../errors';
import type { KeyInfo } from '../types';
import { OAuthError } from './oauth';

const key: KeyInfo = {
  id: 'k1',
  name: 'OpenRouter',
  colour: null,
  masked: 'sk-or-…abcd',
  source: 'oauth',
  createdAt: 0,
  noRetention: false,
  isDefault: true,
};

interface TestEnv extends AuthCallbackEnv {
  calls: string[];
  start: ReturnType<typeof vi.fn>;
  state: { locked: boolean };
}

function env(complete: AuthCallbackEnv['oauth']['complete'], locked = false): TestEnv {
  const calls: string[] = [];
  const start = vi.fn(() => Promise.resolve());
  const state = { locked };
  return {
    calls,
    start,
    state,
    oauth: {
      start,
      complete: (params) => {
        calls.push(`complete:${params.get('code') ?? ''}`);
        return complete(params);
      },
    },
    lock: {
      unlocked: () => !state.locked,
      unlock: (passphrase) => {
        calls.push(`unlock:${passphrase}`);
        if (passphrase !== 'right') return Promise.resolve(false);
        state.locked = false;
        return Promise.resolve(true);
      },
    },
    search: '?code=abc&state=s1',
    clearQuery: () => calls.push('clearQuery'),
    redirect: (path) => calls.push(`redirect:${path}`),
  };
}

function submitPassphrase(status: HTMLElement, passphrase: string): void {
  const input = status.querySelector<HTMLInputElement>('[data-testid="auth-passphrase"]');
  const form = status.querySelector<HTMLFormElement>('[data-testid="auth-unlock-form"]');
  if (!input || !form) throw new Error('no unlock form');
  input.value = passphrase;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('mountAuthCallback', () => {
  it('clears the query before exchanging, then redirects to returnTo', async () => {
    const status = document.createElement('div');
    const e = env(() => Promise.resolve({ key, returnTo: '/or-toolbox/tools/ocr/' }));
    await mountAuthCallback(status, e);
    expect(e.calls).toEqual(['clearQuery', 'complete:abc', 'redirect:/or-toolbox/tools/ocr/']);
    expect(status.querySelector('[data-testid="auth-success"]')?.textContent).toContain(
      'sk-or-…abcd',
    );
  });

  it('defaults to Settings', async () => {
    const e = env(() => Promise.resolve({ key, returnTo: null }));
    await mountAuthCallback(document.createElement('div'), e);
    expect(e.calls.at(-1)).toBe('redirect:/or-toolbox/settings/');
  });

  it('shows a clear error with a retry that starts a new connection', async () => {
    const status = document.createElement('div');
    const e = env(() => Promise.reject(new OAuthError('This sign-in was already used.')));
    await mountAuthCallback(status, e);
    expect(e.calls).toEqual(['clearQuery', 'complete:abc']);
    expect(status.querySelector('[data-testid="auth-error"]')?.textContent).toContain(
      'This sign-in was already used.',
    );
    const retry = status.querySelector<HTMLButtonElement>('[data-testid="auth-retry"]');
    retry?.click();
    expect(e.start).toHaveBeenCalledWith({ returnTo: '/or-toolbox/settings/' });
    expect(retry?.disabled).toBe(true);
    expect(status.querySelector('a')?.getAttribute('href')).toBe('/or-toolbox/settings/');
  });

  it('asks a locked tab to unlock first, keeping the code, then connects with it', async () => {
    const status = document.createElement('div');
    const e = env(() => Promise.resolve({ key, returnTo: null }), true);
    await mountAuthCallback(status, e);
    // Nothing consumed and the query kept, so a reload would still work.
    expect(e.calls).toEqual([]);

    submitPassphrase(status, 'wrong');
    await vi.waitFor(() =>
      expect(status.querySelector('[data-testid="auth-unlock-error"]')?.textContent).toMatch(
        /Wrong passphrase/,
      ),
    );
    expect(e.calls).toEqual(['unlock:wrong']);

    submitPassphrase(status, 'right');
    await vi.waitFor(() => expect(e.calls.at(-1)).toBe('redirect:/or-toolbox/settings/'));
    expect(e.calls).toEqual([
      'unlock:wrong',
      'unlock:right',
      'clearQuery',
      'complete:abc',
      'redirect:/or-toolbox/settings/',
    ]);
  });

  it('offers unlock again when the tab locked itself during the exchange', async () => {
    const status = document.createElement('div');
    let attempts = 0;
    const e = env(() => {
      attempts++;
      return attempts === 1
        ? Promise.reject(new KeyLockedError())
        : Promise.resolve({ key, returnTo: null });
    });
    await mountAuthCallback(status, e);
    expect(status.querySelector('[data-testid="auth-unlock-form"]')).not.toBeNull();
    submitPassphrase(status, 'right');
    await vi.waitFor(() => expect(e.calls.at(-1)).toBe('redirect:/or-toolbox/settings/'));
    expect(e.calls.filter((c) => c === 'complete:abc')).toHaveLength(2);
  });
});
