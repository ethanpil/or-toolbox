import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../../ui/dom';
import { passphraseInput, validNewPassphrase } from './ui';

const announce = vi.hoisted(() => vi.fn());
vi.mock('../../ui/feedback/announce', () => ({ announce, installAnnouncer: () => undefined }));

afterEach(() => {
  document.body.replaceChildren();
  announce.mockClear();
});

const fields = () => {
  const next = passphraseInput({ label: 'Passphrase', autocomplete: 'new-password', testId: 'n' });
  const confirm = passphraseInput({ label: 'Repeat', autocomplete: 'new-password', testId: 'c' });
  const submit = h('button', { type: 'submit' }, 'Turn on');
  document.body.append(next.element, confirm.element, submit);
  return { next, confirm, submit };
};

describe('passphrase field errors', () => {
  it('moving the focus to the field reads the message with it, so it is not announced as well', () => {
    const { next, confirm, submit } = fields();
    next.input.value = 'short';
    submit.focus();
    expect(validNewPassphrase(next, confirm)).toBe(false);
    expect(document.activeElement).toBe(next.input);
    expect(next.input.getAttribute('aria-invalid')).toBe('true');
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces an error once each time it changes, as numberField does', () => {
    const { next, confirm } = fields();
    next.input.value = 'long enough passphrase';
    confirm.input.value = 'something else';
    confirm.input.focus();
    // Submitted from the field itself: nothing moves, so the message is announced.
    expect(validNewPassphrase(next, confirm)).toBe(false);
    expect(announce).toHaveBeenCalledExactlyOnceWith('The passphrases do not match.', {
      assertive: true,
    });
    // The same error on the next submit is not announced again.
    expect(validNewPassphrase(next, confirm)).toBe(false);
    expect(announce).toHaveBeenCalledOnce();
    // Typing clears it; the error after that is new and announced.
    confirm.input.value = 'something else again';
    confirm.input.dispatchEvent(new Event('input'));
    expect(confirm.input.classList.contains('is-invalid')).toBe(false);
    expect(validNewPassphrase(next, confirm)).toBe(false);
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('a repeated error still brings the focus back to the field', () => {
    const { next, submit } = fields();
    next.invalid('Wrong passphrase.', { focus: true });
    submit.focus();
    next.invalid('Wrong passphrase.', { focus: true });
    expect(document.activeElement).toBe(next.input);
    expect(announce).not.toHaveBeenCalled();
  });
});
