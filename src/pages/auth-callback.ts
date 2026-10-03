/**
 * /auth/callback/: OpenRouter sends the browser here with `?code=…&state=…` after "Connect with OpenRouter".
 * The page removes the query from the address bar first, exchanges the code once (OAuthService.complete clears
 * its pending entry before the exchange), then replaces itself with `returnTo` (Settings by default). A reload
 * therefore finds no code and shows the error with a "Connect again" button instead of exchanging again.
 * Functional markup only; Stage 2 restyles it.
 */
import { boot } from '../core/boot';
import { userMessage } from '../core/errors';
import { getCore } from '../core/index';
import { url } from '../core/paths';
import type { OAuthService } from '../core/types';
import { h } from '../ui/dom';
import { renderStubPage } from '../ui/stub';

export interface AuthCallbackEnv {
  oauth: Pick<OAuthService, 'start' | 'complete'>;
  /** `location.search` at page load. */
  search: string;
  /** Drops `code`/`state` from the address bar (history.replaceState). */
  clearQuery: () => void;
  /** Leaves the page without a history entry (location.replace). */
  redirect: (path: string) => void;
}

function progress(text: string): HTMLElement {
  return h(
    'p',
    { class: 'd-flex align-items-center gap-2' },
    h('span', { class: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }),
    text,
  );
}

/** Runs the callback flow, rendering progress, success or a retryable error into `status`. */
export async function mountAuthCallback(status: HTMLElement, env: AuthCallbackEnv): Promise<void> {
  const params = new URLSearchParams(env.search);
  env.clearQuery();
  status.replaceChildren(progress('Connecting your OpenRouter account…'));
  try {
    const { key, returnTo } = await env.oauth.complete(params);
    status.replaceChildren(
      h(
        'div',
        { class: 'alert alert-success', 'data-testid': 'auth-success' },
        `Connected. The key “${key.name}” (${key.masked}) is saved. Taking you back…`,
      ),
    );
    env.redirect(returnTo ?? url('settings/'));
  } catch (error) {
    const retry = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        'data-testid': 'auth-retry',
        onclick: () => {
          retry.disabled = true;
          env.oauth.start({ returnTo: url('settings/') }).catch((startError: unknown) => {
            retry.disabled = false;
            message.textContent = userMessage(startError);
          });
        },
      },
      'Connect again',
    );
    const message = h('p', { class: 'mb-0' }, userMessage(error));
    status.replaceChildren(
      h(
        'div',
        { class: 'alert alert-danger', 'data-testid': 'auth-error' },
        h('p', { class: 'fw-semibold' }, 'Could not connect to OpenRouter.'),
        message,
      ),
      h(
        'div',
        { class: 'd-flex gap-2' },
        retry,
        h('a', { class: 'btn btn-outline-secondary', href: url('settings/') }, 'Back to Settings'),
      ),
    );
  }
}

if (document.getElementById('app')) {
  boot();
  const status = h('div', { role: 'status', 'aria-live': 'polite', 'data-testid': 'auth-status' });
  renderStubPage('Signing in', status);
  void mountAuthCallback(status, {
    oauth: getCore().oauth,
    search: location.search,
    clearQuery: () => history.replaceState(history.state, '', location.pathname),
    redirect: (path) => location.replace(path),
  });
}
