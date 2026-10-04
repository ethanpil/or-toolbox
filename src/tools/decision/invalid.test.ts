import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showListProblem, showProblem } from './invalid';

vi.mock('../../ui/feedback/announce', () => ({ announce: vi.fn() }));
const { announce } = await import('../../ui/feedback/announce');

let input: HTMLInputElement;
let feedback: HTMLElement;
beforeEach(() => {
  vi.mocked(announce).mockClear();
  input = document.createElement('input');
  feedback = document.createElement('div');
  document.body.replaceChildren(input, feedback);
});

describe('showing problems once', () => {
  it('announces a message when it first appears and not again while it stays', () => {
    showProblem(input, feedback, 'Give it a name.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(feedback.textContent).toBe('Give it a name.');
    expect(announce).toHaveBeenCalledTimes(1);

    showProblem(input, feedback, 'Give it a name.');
    showProblem(input, feedback, 'Give it a name.');
    expect(announce).toHaveBeenCalledTimes(1);

    showProblem(input, feedback, 'Give it another name.');
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('clears quietly', () => {
    showProblem(input, feedback, 'Wrong.');
    showProblem(input, feedback, null);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.classList.contains('is-invalid')).toBe(false);
    expect(feedback.textContent).toBe('');
    expect(announce).toHaveBeenCalledTimes(1);
    showProblem(input, feedback, null);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('still takes focus when asked, though the message is already there', () => {
    showProblem(input, feedback, 'Wrong.');
    showProblem(input, feedback, 'Wrong.', { focus: true });
    expect(document.activeElement).toBe(input);
  });

  it('shows a list message while it has text, and sets unchanged text only once', () => {
    const alert = document.createElement('div');
    alert.hidden = true;
    showListProblem(alert, 'Add at least 2 options.');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toBe('Add at least 2 options.');
    const node = alert.firstChild;
    showListProblem(alert, 'Add at least 2 options.');
    expect(alert.firstChild).toBe(node);
    showListProblem(alert, null);
    expect(alert.hidden).toBe(true);
    expect(alert.textContent).toBe('');
  });
});
