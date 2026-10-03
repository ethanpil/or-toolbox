import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestCore, isolateChannels } from '../../core/testing/state-fakes';
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
  it('stops listening once its button has left the page, downloaded or not', () => {
    const { core, offs, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    const button = handle.button();
    document.body.append(button);
    add('b.png'); // a change while on the page
    expect(offs[0]).not.toHaveBeenCalled();
    button.remove();
    add('c.png'); // the next change notices it is gone
    expect(offs[0]).toHaveBeenCalledOnce();
  });

  it('removing the result unsubscribes every button and disables it', () => {
    const { core, offs, add } = setup();
    const handle = resultHandle(core, add('a.png'));
    const attached = handle.button();
    document.body.append(attached);
    const detached = handle.button(); // never shown
    handle.remove();
    expect(offs.map((off) => off.mock.calls.length)).toEqual([1, 1]);
    expect(attached.disabled).toBe(true);
    expect(detached.disabled).toBe(true);
    expect(core.results.pending()).toHaveLength(0);
    // A button asked for afterwards does not subscribe at all.
    expect(handle.button().disabled).toBe(true);
    expect(offs).toHaveLength(2);
  });
});
