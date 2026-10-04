import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCore, isolateChannels } from '../../core/testing/state-fakes';
import { h, replace } from '../dom';
import { resultHandle } from './results';

beforeEach(() => {
  isolateChannels();
  document.body.replaceChildren();
});

function setup() {
  const { core } = createTestCore();
  const offs: ReturnType<typeof vi.fn>[] = [];
  const subscribe = core.results.subscribe.bind(core.results);
  core.results.subscribe = (fn) => {
    const off = vi.fn(subscribe(fn));
    offs.push(off);
    return off;
  };
  const add = (name: string) =>
    core.results.add({ tool: 'chat', kind: 'image', name, blob: new Blob(['x']) });
  return { core, offs, add };
}

describe('resultHandle', () => {
  it('hands out one button per result, so a card redrawn many times keeps one subscription', () => {
    const { core, offs, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    const list = h('div');
    document.body.append(list);
    for (let i = 0; i < 50; i++) replace(list, h('div', null, handle.button()));
    expect(offs).toHaveLength(1);
    expect(handle.button()).toBe(list.querySelector('button'));

    // It still follows the result, wherever it was put last.
    core.results.markDownloaded(handle.result.id);
    expect(handle.button().textContent).toBe('Downloaded');
    expect(handle.button().getAttribute('aria-label')).toBe('a.png, downloaded. Download again');
  });

  it('takes the latest label', () => {
    const { core, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    expect(handle.button('Download recording').textContent).toBe('Download recording');
    expect(handle.button().textContent).toBe('Download');
  });

  it('keeps focus when a redraw moves it into the new markup', async () => {
    const { core, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    const list = h('div');
    document.body.append(list);
    replace(list, h('div', null, handle.button()));
    handle.button().focus();
    // The new row takes the button before `replace` runs, which drops focus to the page.
    replace(list, h('div', null, handle.button()));
    await Promise.resolve();
    expect(document.activeElement).toBe(handle.button());
  });

  it('removing the result unsubscribes and disables its button', () => {
    const { core, offs, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    const button = handle.button();
    document.body.append(button);
    handle.remove();
    handle.remove();
    expect(offs.map((off) => off.mock.calls.length)).toEqual([1]);
    expect(button.disabled).toBe(true);
    expect(core.results.pending()).toHaveLength(0);
    // Asked for afterwards, it is the same disabled button, and nothing subscribes again.
    expect(handle.button()).toBe(button);
    expect(button.disabled).toBe(true);
    expect(offs).toHaveLength(1);
  });

  it('a handle removed before its button was asked for never subscribes', () => {
    const { core, offs, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    handle.remove();
    expect(handle.button().disabled).toBe(true);
    expect(offs).toHaveLength(0);
  });
});
