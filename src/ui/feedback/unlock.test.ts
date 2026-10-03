import { afterEach, describe, expect, it, vi } from 'vitest';
import { unlockDialog } from './unlock';

const announce = vi.hoisted(() => vi.fn());
const unlock = vi.hoisted(() =>
  vi.fn((passphrase: string) => Promise.resolve(passphrase === 'right')),
);
vi.mock('./announce', () => ({ announce, installAnnouncer: () => undefined }));
vi.mock('../../core/index', () => ({
  getCore: () => ({ keys: { lock: { unlocked: () => false, unlock } } }),
}));

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T =>
  document.querySelector<T>(`[data-testid="${testId}"]`)!;

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute('class');
  document.body.removeAttribute('style');
  announce.mockClear();
  unlock.mockClear();
});

describe('unlockDialog', () => {
  it('announces a passphrase error once: never on top of the focus move, never again for the same error', async () => {
    const done = unlockDialog();
    const input = await vi.waitFor(() => {
      const field = $<HTMLInputElement>('unlock-passphrase');
      expect(document.activeElement).toBe(field);
      return field;
    });
    const submit = $<HTMLButtonElement>('unlock-submit');
    const errors = (): string[] => announce.mock.calls.map((call) => String(call[0]));

    // Empty, sent from the button: the focus moves to the field, which reads the message with it.
    submit.focus();
    submit.click();
    expect($('unlock-error').textContent).toBe('Enter your passphrase.');
    expect(document.activeElement).toBe(input);
    expect(errors()).toEqual([]);

    // A wrong passphrase, sent from the field (no focus move): announced once.
    input.value = 'wrong';
    input.dispatchEvent(new Event('input'));
    input.form!.requestSubmit();
    await vi.waitFor(() =>
      expect($('unlock-error').textContent).toBe('Wrong passphrase. Try again.'),
    );
    expect(errors()).toEqual(['Wrong passphrase. Try again.']);

    // The same passphrase again: the same error stays and is not announced again.
    input.form!.requestSubmit();
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect($('unlock-error').textContent).toBe('Wrong passphrase. Try again.');
    expect(errors()).toEqual(['Wrong passphrase. Try again.']);

    // Edited, then wrong again: a new attempt, announced again.
    input.value = 'still wrong';
    input.dispatchEvent(new Event('input'));
    expect($('unlock-error').textContent).toBe('');
    input.form!.requestSubmit();
    await vi.waitFor(() =>
      expect(errors()).toEqual(['Wrong passphrase. Try again.', 'Wrong passphrase. Try again.']),
    );

    input.value = 'right';
    input.dispatchEvent(new Event('input'));
    input.form!.requestSubmit();
    expect(await done).toBe(true);
  });
});
