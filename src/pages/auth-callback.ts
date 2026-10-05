/**
 * /auth/callback/: OpenRouter sends the browser here with `?code=…&state=…` after "Connect with OpenRouter".
 * The page removes the query from the address bar first, exchanges the code once (OAuthService.complete clears
 * its pending entry before the exchange), then replaces itself with `returnTo` (Settings by default). A reload
 * therefore finds no code and shows the error with a "Connect again" button instead of exchanging again.
 *
 * With the passphrase lock on and this tab locked, nothing is consumed: the page asks for the passphrase,
 * unlocks, and then connects with the same code (the query stays until then, so a reload still works).
 *
 * If the key is made but cannot be stored (the tab locked during the exchange, storage full), the code is spent and
 * the page holds the key in memory (KeyNotSavedError): it asks for the passphrase or offers "Save again", and says
 * that leaving keeps the key only on the OpenRouter account.
 */
import { errorCode, userMessage } from '../core/errors';
import { KeyNotSavedError } from '../core/oauth/oauth';
import { url } from '../core/paths';
import type { KeyLock, OAuthService } from '../core/types';
import { h } from '../ui/dom';
import { icon } from '../ui/icon';
import { mountPage } from '../ui/shell/index';

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
    { class: 'd-flex align-items-center gap-3 mb-0 fs-5' },
    h('span', { class: 'spinner-border text-primary', 'aria-hidden': 'true' }),
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
      { class: 'alert alert-danger d-flex gap-3', 'data-testid': 'auth-error' },
      icon('x-octagon-fill', 'fs-4 lh-1'),
      h(
        'div',
        null,
        h('p', { class: 'fw-semibold mb-1' }, 'Could not connect to OpenRouter.'),
        message,
      ),
    ),
    h(
      'div',
      { class: 'd-flex flex-wrap gap-2' },
      retry,
      h('a', { class: 'btn btn-outline-secondary', href: url('settings/') }, 'Back to Settings'),
    ),
  );
}

type Completed = Awaited<ReturnType<OAuthService['complete']>>;

const LOCKED_TEXT = 'Your keys are locked. Enter your passphrase to save the new key.';
const LOCKED_AFTER_TEXT =
  'Your new key was created on OpenRouter, but your keys locked before it was saved. Enter your passphrase to save it.';
const KEEP_OPEN_TEXT =
  'Keep this page open and try again. If you leave, the key stays on your OpenRouter account, where you can delete it.';

function showSuccess(
  status: HTMLElement,
  env: AuthCallbackEnv,
  { key, returnTo }: Completed,
): void {
  status.replaceChildren(
    h(
      'div',
      { class: 'alert alert-success d-flex gap-3 mb-0', 'data-testid': 'auth-success' },
      icon('check-circle-fill', 'fs-4 lh-1'),
      h('div', null, `Connected. The key “${key.name}” (${key.masked}) is saved. Taking you back…`),
    ),
  );
  env.redirect(returnTo ?? url('settings/'));
}

/** The key exists only in this page: unlock to save it, or save again. */
function showNotSaved(status: HTMLElement, env: AuthCallbackEnv, error: KeyNotSavedError): void {
  if (errorCode(error.reason) === 'locked') {
    showUnlock(status, env, LOCKED_AFTER_TEXT, () => saveAgain(status, env, error));
    return;
  }
  const save = h(
    'button',
    {
      class: 'btn btn-primary',
      type: 'button',
      'data-testid': 'auth-save-again',
      onclick: () => {
        save.disabled = true;
        void saveAgain(status, env, error);
      },
    },
    'Save again',
  );
  status.replaceChildren(
    h(
      'div',
      { class: 'alert alert-danger d-flex gap-3', 'data-testid': 'auth-error' },
      icon('x-octagon-fill', 'fs-4 lh-1'),
      h(
        'div',
        null,
        h('p', { class: 'fw-semibold mb-1' }, 'Your new key is not saved yet.'),
        h('p', { class: 'mb-1' }, userMessage(error)),
        h('p', { class: 'mb-0' }, KEEP_OPEN_TEXT),
      ),
    ),
    h(
      'div',
      { class: 'd-flex flex-wrap gap-2' },
      save,
      h('a', { class: 'btn btn-outline-secondary', href: url('settings/') }, 'Back to Settings'),
    ),
  );
}

async function saveAgain(
  status: HTMLElement,
  env: AuthCallbackEnv,
  notSaved: KeyNotSavedError,
): Promise<void> {
  status.replaceChildren(progress('Saving your new key…'));
  try {
    showSuccess(status, env, await notSaved.save());
  } catch (reason) {
    showNotSaved(status, env, new KeyNotSavedError(reason, notSaved.save));
  }
}

/** Asks for the passphrase; on success runs `then` (connect with the same params, or save the key held here). */
function showUnlock(
  status: HTMLElement,
  env: AuthCallbackEnv,
  text: string,
  then: () => Promise<void>,
): void {
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
    await then();
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
      h('p', { class: 'mb-0' }, text),
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
    showSuccess(status, env, await env.oauth.complete(params));
  } catch (error) {
    if (error instanceof KeyNotSavedError) showNotSaved(status, env, error);
    // Locked before the exchange: nothing was consumed, so unlock and try the same code again.
    else if (errorCode(error) === 'locked') {
      showUnlock(status, env, LOCKED_TEXT, () => connect(status, env, params));
    } else showError(status, env, error);
  }
}

/** Runs the callback flow, rendering unlock, progress, success or a retryable error into `status`. */
export async function mountAuthCallback(status: HTMLElement, env: AuthCallbackEnv): Promise<void> {
  const params = new URLSearchParams(env.search);
  if (!env.lock.unlocked()) {
    showUnlock(status, env, LOCKED_TEXT, () => connect(status, env, params));
    return;
  }
  await connect(status, env, params);
}

if (document.getElementById('app')) {
  mountPage(
    {
      title: 'Signing in',
      icon: 'box-arrow-in-right',
      lead: 'Connecting ORtoolbox to your OpenRouter account.',
      narrow: true,
    },
    ({ core, main }) => {
      const status = h('div', {
        role: 'status',
        'aria-live': 'polite',
        'data-testid': 'auth-status',
      });
      main.append(
        h('div', { class: 'card shadow-sm' }, h('div', { class: 'card-body p-4' }, status)),
      );
      void mountAuthCallback(status, {
        oauth: core.oauth,
        lock: core.keys.lock,
        search: location.search,
        clearQuery: () => history.replaceState(history.state, '', location.pathname),
        redirect: (path) => location.replace(path),
      });
    },
  );
}
