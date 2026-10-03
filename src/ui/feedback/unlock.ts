/**
 * `unlockDialog()`: asks for the passphrase and unlocks the keys for this tab (`keys.lock.unlock`). Resolves
 * true when unlocked (immediately if the lock is off or already open), false when the user gives up. One dialog
 * at a time: concurrent callers share it.
 */
import { userMessage } from '../../core/errors';
import { getCore } from '../../core/index';
import { h } from '../dom';
import { uid } from '../id';
import { setFieldError } from './field-error';
import { openModal } from './modal';

let pending: Promise<boolean> | null = null;

export function unlockDialog(): Promise<boolean> {
  const lock = getCore().keys.lock;
  if (lock.unlocked()) return Promise.resolve(true);
  pending ??= show().finally(() => {
    pending = null;
  });
  return pending;
}

function show(): Promise<boolean> {
  const lock = getCore().keys.lock;
  let result = false;
  const inputId = uid('unlock-passphrase');
  const errorId = uid('unlock-error');
  const formId = uid('unlock-form');
  const input = h('input', {
    id: inputId,
    type: 'password',
    class: 'form-control',
    autocomplete: 'current-password',
    required: true,
    'data-testid': 'unlock-passphrase',
  });
  const error = h('div', { id: errorId, class: 'invalid-feedback', 'data-testid': 'unlock-error' });
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', 'data-testid': 'unlock-submit' },
    'Unlock',
  );
  submit.setAttribute('form', formId);

  const form = h(
    'form',
    {
      id: formId,
      noValidate: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        void attempt();
      },
    },
    h(
      'p',
      { class: 'text-body-secondary' },
      'Your keys are encrypted with a passphrase. Unlock them for this tab to run tools.',
    ),
    h('label', { class: 'form-label', htmlFor: inputId }, 'Passphrase'),
    input,
    error,
  );

  const attempt = async (): Promise<void> => {
    if (!input.value) {
      setFieldError(input, error, 'Enter your passphrase.');
      input.focus();
      return;
    }
    submit.disabled = true;
    setFieldError(input, error, null);
    let ok: boolean;
    try {
      ok = await lock.unlock(input.value);
    } catch (failure) {
      // Not a wrong passphrase: storage, crypto or a keys file changed in another tab.
      submit.disabled = false;
      setFieldError(input, error, `Could not unlock: ${userMessage(failure)}`);
      return;
    }
    submit.disabled = false;
    if (ok) {
      result = true;
      modal.hide();
      return;
    }
    setFieldError(input, error, 'Wrong passphrase. Try again.');
    input.select();
  };

  const modal = openModal({
    title: 'Unlock your keys',
    icon: 'lock',
    body: form,
    footer: [
      h(
        'button',
        { type: 'button', class: 'btn btn-outline-secondary', 'data-bs-dismiss': 'modal' },
        'Cancel',
      ),
      submit,
    ],
    initialFocus: input,
    testId: 'unlock-dialog',
  });
  return modal.closed.then(() => result);
}
