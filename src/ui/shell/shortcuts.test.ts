import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreServices } from '../../core/types';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { installPaletteShortcut } from './palette';
import { isTypingTarget, plainShortcutAllowed } from './shortcuts';

afterEach(() => {
  document.body.replaceChildren();
  document.body.removeAttribute('class');
  document.body.removeAttribute('style');
});

/** Dispatches a keydown on `target` (bubbling to the document) and returns the event. */
function press(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe('isTypingTarget', () => {
  it('is true for fields and selects, false for everything else', () => {
    expect(isTypingTarget(h('input', { type: 'search' }))).toBe(true);
    expect(isTypingTarget(h('textarea'))).toBe(true);
    expect(isTypingTarget(h('select'))).toBe(true);
    expect(isTypingTarget(h('button'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('plainShortcutAllowed', () => {
  const key = (target: EventTarget, init: KeyboardEventInit = {}): boolean => {
    let allowed = false;
    const listener = (event: KeyboardEvent): void => {
      allowed = plainShortcutAllowed(event);
    };
    document.addEventListener('keydown', listener, { once: true });
    press(target, { key: '/', ...init });
    return allowed;
  };

  it('lets a plain key through on the page', () => {
    expect(key(document.body)).toBe(true);
  });

  it('stays out of the way of typing and of modifiers', () => {
    const input = h('input');
    document.body.append(input);
    expect(key(input)).toBe(false);
    expect(key(document.body, { ctrlKey: true })).toBe(false);
    expect(key(document.body, { metaKey: true })).toBe(false);
    expect(key(document.body, { altKey: true })).toBe(false);
  });

  it('stays out of the way of a dialog', async () => {
    const modal = openModal({ title: 'Open', body: h('p', null, 'x'), testId: 'dlg' });
    expect(key(document.body)).toBe(false);
    modal.hide();
    await modal.closed;
    expect(key(document.body)).toBe(true);
  });
});

describe('the palette shortcut', () => {
  it('leaves Ctrl+K to the browser while another dialog is open', async () => {
    installPaletteShortcut({} as CoreServices);
    const modal = openModal({ title: 'Other', body: h('p', null, 'x'), testId: 'other' });
    const event = press(document.body, { key: 'k', ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    modal.hide();
    await modal.closed;
  });

  it('ignores other keys', () => {
    installPaletteShortcut({} as CoreServices);
    const spy = vi.fn();
    document.addEventListener('keydown', spy);
    expect(press(document.body, { key: 'k' }).defaultPrevented).toBe(false);
    expect(press(document.body, { key: 'j', ctrlKey: true }).defaultPrevented).toBe(false);
    document.removeEventListener('keydown', spy);
  });
});
