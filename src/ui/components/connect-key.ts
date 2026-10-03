/**
 * `connectKey()`: the two ways to give ORtoolbox an OpenRouter key, side by side. "Connect with OpenRouter"
 * (OAuth PKCE: the browser goes to openrouter.ai and comes back with a new key) or pasting an existing key,
 * which is format-checked, saved through `keys.add`, then checked against `GET /key` (a key OpenRouter rejects
 * is removed again). Used by onboarding and by the "Add a key" dialog that `presentError` shows.
 */
import { ApiError, errorCode } from '../../core/errors';
import { getCore } from '../../core/index';
import { keyFormatProblem, normalizeKeyInput } from '../../core/keys/format';
import type { KeyInfo } from '../../core/types';
import { h } from '../dom';
import { announce } from '../feedback/announce';
import { presentError } from '../feedback/errors';
import { setFieldError } from '../feedback/field-error';
import { formatUsd } from '../format';
import { icon } from '../icon';
import { uid } from '../id';
import { OPENROUTER_KEYS_URL } from '../shell/links';
import { externalLink } from './external-link';

export interface ConnectKeyOptions {
  /** Where the OAuth callback returns to; default: this page. */
  returnTo?: string;
  /** Called after a pasted key was saved (and checked). */
  onAdded?: (key: KeyInfo) => void;
}

export function connectKey(options: ConnectKeyOptions = {}): HTMLElement {
  const core = getCore();
  const inputId = uid('key-input');
  const feedbackId = uid('key-feedback');
  const helpId = uid('key-help');

  const connect = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary btn-lg w-100 d-flex align-items-center justify-content-center gap-2',
      'data-testid': 'connect-openrouter',
      onclick: () => void startOAuth(),
    },
    icon('box-arrow-in-right'),
    'Connect with OpenRouter',
  );

  const startOAuth = async (): Promise<void> => {
    connect.disabled = true;
    try {
      await core.oauth.start({
        returnTo: options.returnTo ?? location.pathname + location.search,
        keyLabel: 'ORtoolbox',
      });
    } catch (error) {
      connect.disabled = false;
      await presentError(error, { retry: () => void startOAuth() });
    }
  };

  const input = h('input', {
    id: inputId,
    type: 'password',
    class: 'form-control font-monospace',
    placeholder: 'sk-or-v1-…',
    autocomplete: 'off',
    spellcheck: false,
    'aria-describedby': `${helpId} ${feedbackId}`,
    'data-testid': 'key-input',
  });
  const feedback = h('div', {
    id: feedbackId,
    class: 'invalid-feedback',
    'data-testid': 'key-feedback',
  });
  // Not a live region: results are announced once through announce().
  const status = h('div', { class: 'small mt-2', 'data-testid': 'key-status' });
  const save = h(
    'button',
    { type: 'submit', class: 'btn btn-outline-primary', 'data-testid': 'key-save' },
    'Save key',
  );

  const invalid = (message: string): void => {
    setFieldError(input, feedback, message);
    input.focus();
  };

  const saveKey = async (): Promise<void> => {
    setFieldError(input, feedback, null);
    status.replaceChildren();
    const secret = normalizeKeyInput(input.value);
    const problem = keyFormatProblem(secret);
    if (problem) {
      invalid(problem);
      return;
    }
    save.disabled = true;
    try {
      const count = core.keys.list().length;
      const key = await core.keys.add({
        name: count === 0 ? 'Default' : `Key ${count + 1}`,
        secret,
      });
      input.value = '';
      status.replaceChildren(
        h('span', { class: 'spinner-border spinner-border-sm me-2', 'aria-hidden': 'true' }),
        'Saved. Checking the key with OpenRouter…',
      );
      try {
        const keyStatus = await core.keys.status(key.id, { force: true });
        const balance =
          keyStatus.limitRemainingUsd !== null
            ? ` ${formatUsd(keyStatus.limitRemainingUsd)} left on this key.`
            : '';
        const done = `Key saved (${key.masked}).${balance}`;
        status.replaceChildren(icon('check-circle-fill', 'text-success-emphasis me-1'), done);
        announce(done);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          core.keys.remove(key.id);
          status.replaceChildren();
          invalid('OpenRouter rejected this key. Check that you copied all of it.');
          return;
        }
        const done = `Key saved (${key.masked}). It could not be checked right now.`;
        status.replaceChildren(icon('check-circle', 'text-success-emphasis me-1'), done);
        announce(done);
      }
      options.onAdded?.(key);
    } catch (error) {
      if (errorCode(error) === 'invalid-key' && error instanceof Error) invalid(error.message);
      else await presentError(error, { retry: () => void saveKey() });
    } finally {
      save.disabled = false;
    }
  };

  return h(
    'div',
    { class: 'vstack gap-3', 'data-testid': 'connect-key' },
    h(
      'div',
      null,
      connect,
      h(
        'p',
        { class: 'form-text mb-0 mt-2' },
        'OpenRouter creates a key for this browser. You can give it a credit limit afterwards in ',
        externalLink(OPENROUTER_KEYS_URL, 'your OpenRouter key list'),
        '.',
      ),
    ),
    h(
      'div',
      { class: 'd-flex align-items-center gap-3 text-body-secondary small', 'aria-hidden': 'true' },
      h('hr', { class: 'flex-grow-1 my-0' }),
      'or',
      h('hr', { class: 'flex-grow-1 my-0' }),
    ),
    h(
      'form',
      {
        noValidate: true,
        onsubmit: (event: Event) => {
          event.preventDefault();
          void saveKey();
        },
      },
      h(
        'label',
        { class: 'form-label fw-semibold', htmlFor: inputId },
        'Paste an OpenRouter API key',
      ),
      h('div', { class: 'input-group has-validation' }, input, save, feedback),
      h(
        'div',
        { id: helpId, class: 'form-text' },
        'Stored only in this browser and sent only to openrouter.ai. A key with a credit limit is safest.',
      ),
      status,
    ),
  );
}
