import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import { setFieldError } from './field-error';

const announce = vi.hoisted(() => vi.fn());
vi.mock('./announce', () => ({ announce }));

afterEach(() => {
  document.body.replaceChildren();
  announce.mockClear();
});

describe('setFieldError with focus', () => {
  it('moves the focus to the field and leaves the message to aria-describedby (no second announcement)', () => {
    const input = h('input', { type: 'text' });
    const feedback = h('div', { class: 'invalid-feedback' });
    const button = h('button', { type: 'button' }, 'Save');
    document.body.append(input, feedback, button);
    button.focus();

    setFieldError(input, feedback, 'Enter a name.', { focus: true });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-describedby')).toBe(feedback.id);
    expect(feedback.textContent).toBe('Enter a name.');
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces when the focus is already in the field (nothing reads the description again)', () => {
    const input = h('input', { type: 'text' });
    const feedback = h('div', { class: 'invalid-feedback' });
    document.body.append(input, feedback);
    input.focus();

    setFieldError(input, feedback, 'Enter a name.', { focus: true });
    expect(announce).toHaveBeenCalledExactlyOnceWith('Enter a name.', { assertive: true });
  });

  it('announces when the field cannot take the focus', () => {
    const input = h('input', { type: 'text', disabled: true });
    const feedback = h('div', { class: 'invalid-feedback' });
    document.body.append(input, feedback);

    setFieldError(input, feedback, 'Enter a name.', { focus: true });
    expect(announce).toHaveBeenCalledOnce();
  });
});
