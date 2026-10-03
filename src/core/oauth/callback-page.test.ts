/** Tests for the /auth/callback/ page flow (src/pages/auth-callback.ts). */
import { describe, expect, it, vi } from 'vitest';
import { mountAuthCallback, type AuthCallbackEnv } from '../../pages/auth-callback';
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

function env(complete: AuthCallbackEnv['oauth']['complete']): AuthCallbackEnv & {
  calls: string[];
  start: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const start = vi.fn(() => Promise.resolve());
  return {
    calls,
    start,
    oauth: {
      start,
      complete: (params) => {
        calls.push(`complete:${params.get('code') ?? ''}`);
        return complete(params);
      },
    },
    search: '?code=abc&state=s1',
    clearQuery: () => calls.push('clearQuery'),
    redirect: (path) => calls.push(`redirect:${path}`),
  };
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
});
