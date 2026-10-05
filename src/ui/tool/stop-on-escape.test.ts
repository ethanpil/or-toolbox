import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from '../dom';
import { openModal } from '../feedback/modal';
import { stopOnEscape } from './stop-on-escape';

const removers: (() => void)[] = [];
afterEach(() => {
  for (const remove of removers.splice(0)) remove();
  document.body.replaceChildren();
});

function install(options: Parameters<typeof stopOnEscape>[1] = {}, busy = true) {
  const runner = { busy, stop: vi.fn() };
  removers.push(stopOnEscape(runner, options));
  return runner;
}

function escape(target: EventTarget = document.body, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe('stopOnEscape', () => {
  it('stops the run that is going, and only then', () => {
    const runner = install();
    const event = escape();
    expect(runner.stop).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);

    const idle = install({}, false);
    escape();
    expect(idle.stop).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const runner = install();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('leaves Ctrl, Cmd and Alt+Escape alone', () => {
    const runner = install();
    escape(document.body, { ctrlKey: true });
    escape(document.body, { metaKey: true });
    escape(document.body, { altKey: true });
    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('leaves fields to their own use of Escape, except the ones it is told about', () => {
    const search = h('input', { type: 'search' });
    const select = h('select');
    const composer = h('textarea');
    document.body.append(search, select, composer);
    const runner = install({ allowIn: [composer] });
    escape(search);
    escape(select);
    expect(runner.stop).not.toHaveBeenCalled();
    escape(composer);
    expect(runner.stop).toHaveBeenCalledOnce();
  });

  it('leaves an input method that is composing, and a key something else handled', () => {
    const runner = install();
    escape(document.body, { isComposing: true });
    const handled = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    document.body.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
    document.body.dispatchEvent(handled);
    expect(runner.stop).not.toHaveBeenCalled();
  });

  it('leaves an open drawer or menu to close first, and an open dialog', async () => {
    const runner = install();
    const drawer = h('div', { class: 'offcanvas show' });
    document.body.append(drawer);
    escape();
    drawer.remove();
    const menu = h('ul', { class: 'dropdown-menu show' });
    document.body.append(menu);
    escape();
    menu.remove();
    expect(runner.stop).not.toHaveBeenCalled();

    const modal = openModal({ title: 'Open', body: h('p', null, 'x'), testId: 'dlg' });
    escape();
    expect(runner.stop).not.toHaveBeenCalled();
    modal.hide();
    await modal.closed;
    escape();
    expect(runner.stop).toHaveBeenCalledOnce();
  });

  it('can be removed', () => {
    const runner = { busy: true, stop: vi.fn() };
    const remove = stopOnEscape(runner);
    remove();
    escape();
    expect(runner.stop).not.toHaveBeenCalled();
  });
});
