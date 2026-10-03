/**
 * /auth/callback/: OpenRouter sends the browser here with `?code=…&state=…` after "Connect with OpenRouter".
 * The page removes the query from the address bar first, exchanges the code once (OAuthService.complete clears
 * its pending entry before the exchange), then replaces itself with `returnTo` (Settings by default). A reload
 * therefore finds no code and shows the error with a "Connect again" button instead of exchanging again.
 *
 * With the passphrase lock on and this tab locked, nothing is consumed: the page asks for the passphrase,
 * unlocks, and then connects with the same code (the query stays until then, so a reload still works).
 * Functional markup only; Stage 2 restyles it.
 */
import { boot } from '../core/boot';
import { errorCode, userMessage } from '../core/errors';
import { getCore } from '../core/index';
import { url } from '../core/paths';
import type { KeyLock, OAuthService } from '../core/types';
import { h } from '../ui/dom';
import { renderStubPage } from '../ui/stub';

export interface AuthCallbackEnv {
  oauth: Pick<OAuthService, 'start' | 'complete'>;
  lock: Pick<KeyLock, 'unlocked' | 'unlock'>;
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

function showError(status: HTMLElement, env: AuthCallbackEnv, error: unknown): void {
  const message = h('p', { class: 'mb-0' }, userMessage(error));
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

/** Asks for the passphrase; on success connects with the same params. */
function showUnlock(status: HTMLElement, env: AuthCallbackEnv, params: URLSearchParams): void {
  const input = h('input', {
    id: 'auth-passphrase',
    type: 'password',
    class: 'form-control',
    autocomplete: 'current-password',
    required: true,
    'data-testid': 'auth-passphrase',
  });
  const feedback = h('p', { class: 'text-danger mb-0', 'data-testid': 'auth-unlock-error' });
  const submit = h(
    'button',
    { class: 'btn btn-primary', type: 'submit', 'data-testid': 'auth-unlock' },
    'Unlock and connect',
  );
  const unlock = async (): Promise<void> => {
    submit.disabled = true;
    feedback.textContent = '';
    const ok = await env.lock.unlock(input.value).catch(() => false);
    if (!ok) {
      submit.disabled = false;
      feedback.textContent = 'Wrong passphrase. Try again.';
      input.select();
      return;
    }
    await connect(status, env, params);
  };
  status.replaceChildren(
    h(
      'form',
      {
        class: 'vstack gap-2',
        'data-testid': 'auth-unlock-form',
        onsubmit: (event: Event) => {
          event.preventDefault();
          void unlock();
        },
      },
      h('p', { class: 'mb-0' }, 'Your keys are locked. Enter your passphrase to save the new key.'),
      h('label', { class: 'form-label mb-0', htmlFor: 'auth-passphrase' }, 'Passphrase'),
      input,
      feedback,
      h('div', null, submit),
    ),
  );
}

async function connect(
  status: HTMLElement,
  env: AuthCallbackEnv,
  params: URLSearchParams,
): Promise<void> {
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
    // Locked meanwhile (auto-lock): nothing was consumed, so unlock and try the same code again.
    if (errorCode(error) === 'locked') showUnlock(status, env, params);
    else showError(status, env, error);
  }
}

/** Runs the callback flow, rendering unlock, progress, success or a retryable error into `status`. */
export async function mountAuthCallback(status: HTMLElement, env: AuthCallbackEnv): Promise<void> {
  const params = new URLSearchParams(env.search);
  if (!env.lock.unlocked()) {
    showUnlock(status, env, params);
    return;
  }
  await connect(status, env, params);
}

if (document.getElementById('app')) {
  boot();
  const status = h('div', { role: 'status', 'aria-live': 'polite', 'data-testid': 'auth-status' });
  renderStubPage('Signing in', status);
  const core = getCore();
  void mountAuthCallback(status, {
    oauth: core.oauth,
    lock: core.keys.lock,
    search: location.search,
    clearQuery: () => history.replaceState(history.state, '', location.pathname),
    redirect: (path) => location.replace(path),
  });
}
