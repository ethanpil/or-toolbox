import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BudgetBlockedError,
  FreeOnlyError,
  NetworkError,
  NoKeyError,
  RateLimitError,
  RunCancelledError,
  StorageFullError,
} from '../../core/errors';
import { h } from '../dom';
import { confirmDialog, promptDialog, typedConfirm } from './dialogs';
import { presentError } from './errors';
import { setFieldError } from './field-error';
import { modalOpen, openModal } from './modal';
import { toast } from './toast';

const $ = <T extends HTMLElement = HTMLElement>(testId: string): T | null =>
  document.querySelector<T>(`[data-testid="${testId}"]`);
const count = (testId: string): number =>
  document.querySelectorAll(`[data-testid="${testId}"]`).length;

/** Waits until Bootstrap has finished showing the modal (it then moves focus into it). */
const shown = (testId: string) =>
  vi.waitFor(() => {
    expect($(testId)?.contains(document.activeElement)).toBe(true);
  });

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute('class');
  document.body.removeAttribute('style');
});

describe('toast', () => {
  it('shows the message and runs its action, then closes', async () => {
    const onClick = vi.fn();
    toast({ message: 'Prompt deleted.', action: { label: 'Undo', onClick, testId: 'undo' } });
    expect($('toast')?.textContent).toContain('Prompt deleted.');
    $('undo')!.click();
    expect(onClick).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect($('toast')).toBeNull());
  });

  it('runs an action once, keeps a toast with actions until used, and survives a late hide', async () => {
    const onClick = vi.fn();
    const handle = toast({
      message: 'Prompt deleted.',
      action: { label: 'Undo', onClick, testId: 'undo' },
      timeoutMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect($('toast')).not.toBeNull(); // no timer to race (WCAG 2.2.1)
    $('undo')!.click();
    $('undo')?.click();
    expect(onClick).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect($('toast')).toBeNull());
    expect(() => handle.hide()).not.toThrow();
  });

  it('hides a plain message after its timeout', async () => {
    toast({ message: 'Saved.', timeoutMs: 20 });
    await vi.waitFor(() => expect($('toast')).toBeNull());
  });

  it('announces the message through the live region', async () => {
    toast({ message: 'Saved.', variant: 'success' });
    await vi.waitFor(() => expect($('announcer-polite')?.textContent).toBe('Saved.'));
    toast({ message: 'Failed.', variant: 'danger' });
    await vi.waitFor(() => expect($('announcer-assertive')?.textContent).toBe('Failed.'));
  });
});

describe('openModal', () => {
  it('labels the dialog, focuses the first field and returns focus on close', async () => {
    const opener = h('button', { type: 'button' }, 'Open');
    document.body.append(opener);
    opener.focus();
    const input = h('input', { type: 'text' });
    const modal = openModal({
      title: 'Rename',
      body: input,
      footer: h('button', { type: 'button' }, 'Save'),
      testId: 'm',
    });
    await shown('m');
    expect(modal.element.getAttribute('role')).toBe('dialog');
    expect(
      document.getElementById(modal.element.getAttribute('aria-labelledby')!)?.textContent,
    ).toBe('Rename');
    expect(document.activeElement).toBe(input);
    modal.hide();
    await modal.closed;
    expect($('m')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('openModal queue', () => {
  it('shows one modal at a time and drops a queued one that is hidden first', async () => {
    const first = openModal({ title: 'First', body: 'One', testId: 'm1' });
    const second = openModal({ title: 'Second', body: 'Two', testId: 'm2' });
    const third = openModal({ title: 'Third', body: 'Three', testId: 'm3' });
    expect(modalOpen()).toBe(true);
    await shown('m1');
    expect($('m2')).toBeNull();
    third.hide();
    await third.closed;
    first.hide();
    await first.closed;
    await shown('m2');
    expect(count('m1') + count('m3')).toBe(0);
    second.hide();
    await second.closed;
    expect($('m3')).toBeNull();
    expect(modalOpen()).toBe(false);
  });

  it('names a dialog without a header by aria-label and adds no hidden close button', async () => {
    const modal = openModal({
      title: 'Search',
      body: h('input', { type: 'search' }),
      hideHeader: true,
      testId: 'bare',
    });
    await shown('bare');
    expect(modal.element.getAttribute('aria-label')).toBe('Search');
    expect(modal.element.hasAttribute('aria-labelledby')).toBe(false);
    expect(modal.element.querySelector('.btn-close')).toBeNull();
    modal.hide();
    await modal.closed;
  });
  it('honours Cancel or Escape pressed while the dialog is still opening', async () => {
    const cancelled = confirmDialog({ title: 'Delete?', message: 'Sure?' });
    $('dialog-cancel')!.click(); // Bootstrap ignores hide() during the show transition
    await expect(cancelled).resolves.toBe(false);

    const escaped = confirmDialog({ title: 'Delete?', message: 'Sure?' });
    $('confirm-dialog')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await expect(escaped).resolves.toBe(false);
    expect(modalOpen()).toBe(false);
  });
});

describe('setFieldError', () => {
  it('marks the field invalid, links the message and announces it; null clears it', async () => {
    const input = h('input', { type: 'text', 'aria-describedby': 'help' });
    const feedback = h('div', { class: 'invalid-feedback' });
    document.body.append(input, feedback);
    setFieldError(input, feedback, 'Enter a name.');
    expect(input.classList.contains('is-invalid')).toBe(true);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`help ${feedback.id}`);
    expect(feedback.textContent).toBe('Enter a name.');
    await vi.waitFor(() => expect($('announcer-assertive')?.textContent).toBe('Enter a name.'));
    setFieldError(input, feedback, null);
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(feedback.textContent).toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(`help ${feedback.id}`);
  });
});

describe('dialogs', () => {
  it('confirmDialog resolves true on confirm and false on cancel', async () => {
    const yes = confirmDialog({ title: 'Delete?', message: 'Sure?', tone: 'danger' });
    await shown('confirm-dialog');
    // Destructive dialogs start on Cancel.
    expect(document.activeElement).toBe($('dialog-cancel'));
    $('dialog-confirm')!.click();
    await expect(yes).resolves.toBe(true);

    const no = confirmDialog({ title: 'Delete?', message: 'Sure?' });
    await shown('confirm-dialog');
    $('dialog-cancel')!.click();
    await expect(no).resolves.toBe(false);
  });

  it('typedConfirm enables its button only for the phrase', async () => {
    const result = typedConfirm({
      title: 'Reset',
      message: 'Everything goes.',
      phrase: 'reset everything',
    });
    await shown('typed-confirm-dialog');
    const input = $<HTMLInputElement>('typed-confirm-input')!;
    const confirm = $<HTMLButtonElement>('dialog-confirm')!;
    expect(confirm.disabled).toBe(true);
    input.value = 'reset';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(true);
    input.value = '  Reset Everything ';
    input.dispatchEvent(new Event('input'));
    expect(confirm.disabled).toBe(false);
    input.form!.requestSubmit();
    await expect(result).resolves.toBe(true);
  });

  it('promptDialog returns the trimmed value, or null when cancelled', async () => {
    const named = promptDialog({ title: 'Name', label: 'Name', value: 'Old' });
    await shown('prompt-dialog');
    const input = $<HTMLInputElement>('prompt-input')!;
    input.value = '  New name ';
    input.form!.requestSubmit();
    await expect(named).resolves.toBe('New name');

    const required = promptDialog({ title: 'Name', label: 'Name' });
    await shown('prompt-dialog');
    $<HTMLInputElement>('prompt-input')!.form!.requestSubmit();
    expect($('prompt-input')?.classList.contains('is-invalid')).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-testid="prompt-dialog"] .btn-close')!.click();
    await expect(required).resolves.toBeNull();
  });
});

describe('presentError', () => {
  it('stays quiet for cancelled and aborted runs', async () => {
    await presentError(new RunCancelledError());
    await presentError(new DOMException('Stopped', 'AbortError'));
    expect($('error-toast')).toBeNull();
  });

  it('links budget and free-only problems to the right settings', async () => {
    await presentError(
      new BudgetBlockedError({
        verdict: 'block',
        reasons: [
          { kind: 'monthly', limitUsd: 5, projectedUsd: 6, message: 'Over the monthly limit.' },
        ],
      }),
    );
    const budget = $('error-toast')!;
    expect(budget.textContent).toContain('Over the monthly limit.');
    expect(budget.querySelector('a')?.getAttribute('href')).toBe('/or-toolbox/settings/#budgets');
    document.body.replaceChildren();

    await presentError(new FreeOnlyError(['openai/gpt-6-luna']));
    expect($('error-toast')?.querySelector('a')?.getAttribute('href')).toBe(
      '/or-toolbox/settings/#models',
    );
    document.body.replaceChildren();

    await presentError(new StorageFullError());
    expect($('error-toast')?.querySelector('a')?.getAttribute('href')).toBe(
      '/or-toolbox/settings/#data',
    );
  });

  it('shows an error once, however many places report it', async () => {
    const error = new NetworkError();
    await presentError(error);
    await presentError(error);
    expect(count('error-toast')).toBe(1);
  });

  it('opens one add-key dialog for parallel runs that all lack a key', async () => {
    const first = presentError(new NoKeyError());
    const second = presentError(new NoKeyError());
    await shown('add-key-dialog');
    expect(count('add-key-dialog')).toBe(1);
    document.querySelector<HTMLButtonElement>('[data-testid="add-key-dialog"] .btn-close')!.click();
    await Promise.all([first, second]);
    expect($('add-key-dialog')).toBeNull();
    expect(modalOpen()).toBe(false);
  });

  it('offers Retry for rate limits, network errors and the rest', async () => {
    const retry = vi.fn();
    await presentError(new RateLimitError('slow down'), { retry });
    expect($('error-toast')?.textContent).toContain('20 requests a minute');
    $('toast-retry')!.click();
    expect(retry).toHaveBeenCalledOnce();
    document.body.replaceChildren();

    await presentError(new NetworkError(), { retry });
    expect($('error-toast')?.textContent).toContain('Network error');
    document.body.replaceChildren();

    await presentError(new TypeError('Cannot read properties of undefined'));
    // Engine messages are never shown.
    expect($('error-toast')?.textContent).toContain('Something went wrong');
    expect($('toast-retry')).toBeNull();
  });
});
